import { config } from './config.js';
import { storage } from './storage.js';

/**
 * 安全合并对端状态，防止对端的空凭证覆盖本地有效凭证
 * 规则：
 * 1. 若 incoming 标记了 isExplicitLogout（用户主动在管理后台注销），允许合法清空本地凭证；
 * 2. 若 local 存在有效的 botToken，而 incoming.botToken 为空且未显式注销，坚决保留 local 的 botToken、botId、userId；
 * 3. 比较时间戳：若 incoming.updatedAt >= local.updatedAt，允许更新 contextToken、quota、cursor、webhook 等业务动态字段；
 * 4. 其它情况保留两者中更全面有价值的数据。
 */
export function mergeAuthState(local, incoming) {
  if (!incoming || typeof incoming !== 'object') return local;
  if (!local || typeof local !== 'object') return { ...incoming };

  // 1. 若用户显式注销登录，允许清空凭证
  if (incoming.isExplicitLogout) {
    return { ...incoming };
  }

  const result = { ...local };
  const incomingHasToken = Boolean(incoming.botToken);
  const localHasToken = Boolean(local.botToken);

  const incomingTime = Number(incoming.updatedAt || incoming.lastActiveTime || 0);
  const localTime = Number(local.updatedAt || local.lastActiveTime || 0);

  if (incomingHasToken) {
    // 对端有有效 Token：比较时间戳，若对端更新或本地本无 Token，则采纳对端 Token 及相关字段
    if (!localHasToken || incomingTime >= localTime) {
      result.botToken = incoming.botToken;
      result.botId = incoming.botId;
      result.userId = incoming.userId;
      result.userWechatId = incoming.userWechatId || incoming.userId;
    }
  } else if (localHasToken) {
    console.warn('[Cluster] 拦截到对端空凭证同步请求，本地有效微信凭证已受保护，拒绝抹除！');
  }

  // 业务动态字段（ContextToken, 剩余配额, 游标, Webhook 状态等）按时间戳更新
  if (incomingTime >= localTime) {
    if (incoming.contextToken !== undefined && (incoming.contextToken || !local.contextToken)) {
      result.contextToken = incoming.contextToken;
      result.contextTokenUsedCount = incoming.contextTokenUsedCount ?? result.contextTokenUsedCount;
      result.contextTokenCreatedAt = incoming.contextTokenCreatedAt ?? result.contextTokenCreatedAt;
      result.contextTokenExpireAt = incoming.contextTokenExpireAt ?? result.contextTokenExpireAt;
    }
    if (incoming.syncBuf) result.syncBuf = incoming.syncBuf;
    if (incoming.lastActiveTime) result.lastActiveTime = incoming.lastActiveTime;
    if (incoming.invalidationReason !== undefined) {
      if (incomingHasToken || !localHasToken) {
        result.invalidationReason = incoming.invalidationReason;
      }
    }
    if (incoming.reminderSentToken) result.reminderSentToken = incoming.reminderSentToken;
    if (incoming.reminderSentAt) result.reminderSentAt = incoming.reminderSentAt;
    if (incoming.webhookTriggeredToken) result.webhookTriggeredToken = incoming.webhookTriggeredToken;
    if (incoming.webhookTriggeredAt) result.webhookTriggeredAt = incoming.webhookTriggeredAt;
    if (incoming.webhookLastStatus !== undefined) result.webhookLastStatus = incoming.webhookLastStatus;
    if (incoming.webhookLastError !== undefined) result.webhookLastError = incoming.webhookLastError;
    result.updatedAt = Math.max(incomingTime, Date.now());
  }

  return result;
}

/**
 * ClusterManager: 跨云双机对等高可用集群协调器 (Blitz Cloud <-> Miget)
 * 职责：
 * 1. 自动主备选举（Master / Standby），保证全集群永远只有 1 个实例运行长轮询与定时任务；
 * 2. 状态全自动实时双向同步（登录凭证、Token、配额、游标变化立即落盘到两端）；
 * 3. 心跳探活与自动故障转移（Failover）：主节点宕机/休眠时，备节点无感自动顶替接管。
 */
export class ClusterManager {
  constructor(iLink, reminderService) {
    this.iLink = iLink;
    this.reminderService = reminderService;
    this.peerUrl = config.peerUrl;
    this.role = config.nodeRole === 'standby' ? 'standby' : 'master'; // 初始角色
    this.peerOnline = null;
    this.peerRole = null;
    this.failureCount = 0;
    this.lastHeartbeat = null;
    this.lastSyncSuccess = null;
    this.lastRoleChangeAt = Date.now();
    this.heartbeatTimer = null;
    this.unsubscribeStorage = null;
  }

  /**
   * 初始化集群
   */
  async init() {
    // 监听本地存储变更，无论本节点是 Master 还是 Standby，只要有本地发起的有效变更均同步给对端
    this.unsubscribeStorage = storage.subscribe((state) => {
      if (this.peerUrl && state) {
        this.syncToPeer(state);
      }
    });

    if (!this.peerUrl) {
      console.log('[Cluster] 未配置 PEER_URL，当前服务以独立单机模式运行 (Role: Master)');
      this.role = 'master';
      this.startMasterTasks();
      return;
    }

    console.log(`[Cluster] 集群模式启动！对端地址: ${this.peerUrl} | 初始预设角色: ${config.nodeRole}`);

    // 自适应角色决策
    if (config.nodeRole === 'master') {
      this.role = 'master';
      this.startMasterTasks();
    } else if (config.nodeRole === 'standby') {
      this.role = 'standby';
      this.stopMasterTasks();
      await this.pullStateFromPeer();
    } else {
      // auto 模式：主动探活对端，若对端 Master 存活则成为 Standby，否则成为 Master
      const peerStatus = await this._probePeer();
      if (peerStatus && peerStatus.online && peerStatus.role === 'master') {
        console.log('[Cluster] 探测到对端 Master 正在运行，当前节点自动设置为 Standby 备用');
        this.role = 'standby';
        this.stopMasterTasks();
        await this.pullStateFromPeer();
      } else {
        console.log('[Cluster] 未发现活跃的主节点，当前节点自动接管为 Master');
        this.role = 'master';
        this.startMasterTasks();
      }
    }

    // 启动心跳与故障转移检测回路
    this.startHeartbeatLoop();
  }

  /**
   * 启动 Master 任务（微信长轮询回路 + 定时提醒守护任务）
   */
  startMasterTasks() {
    this.role = 'master';
    this.lastRoleChangeAt = Date.now();

    if (this.iLink.state.botToken && !this.iLink.pollingActive) {
      console.log('[Cluster] 发现授权记录，Master 正在拉起微信消息长轮询...');
      this.iLink.startLongPolling();
    }
    this.reminderService.start(this.iLink);
    console.log('[Cluster] ★ 当前节点已激活 MASTER 权限：长轮询与到期提醒任务正常运行中');
  }

  /**
   * 停止 Master 任务（降级为 Standby 备用）
   */
  stopMasterTasks() {
    this.role = 'standby';
    this.lastRoleChangeAt = Date.now();

    this.iLink.stopLongPolling();
    this.reminderService.stop();
    console.log('[Cluster] ⏸ 当前节点已切换至 STANDBY 状态：长轮询与定时守护任务静默待命中');
  }

  /**
   * 晋升为主节点 (Promote to Master)
   */
  promoteToMaster(reason = '手动晋升') {
    if (this.role === 'master') return;
    console.warn(`[Cluster] ⚡ 故障接管：备机晋升为 MASTER！原因: ${reason}`);
    // 重新加载本地最新 auth_state
    const latestState = storage.get();
    if (latestState) {
      this.iLink.state = latestState;
    }
    this.startMasterTasks();
  }

  /**
   * 降级为备节点 (Demote to Standby)
   */
  async demoteToStandby(reason = '让出 Master 权限') {
    if (this.role === 'standby') return;
    console.warn(`[Cluster] ⚡ 主备协调：当前节点降级为 STANDBY！原因: ${reason}`);
    this.stopMasterTasks();
    // 降级前，若本地有有效凭据，主动向刚醒来的主机推送最新状态，确保主机拿到最新凭证
    const local = storage.get() || this.iLink.state;
    if (local && local.botToken) {
      await this.syncToPeer(local).catch(() => {});
    }
    await this.pullStateFromPeer();
  }

  /**
   * 将当前状态推送到对端 (Push Sync)
   */
  async syncToPeer(state) {
    if (!this.peerUrl || !state) return;
    try {
      const res = await fetch(`${this.peerUrl}${config.routePrefix}/api/cluster/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey
        },
        body: JSON.stringify(state),
        signal: AbortSignal.timeout(6000)
      });
      if (res.ok) {
        this.lastSyncSuccess = Date.now();
        console.log('[Cluster] 已将最新 auth_state.json 实时推送到对端节点');
      } else {
        console.warn(`[Cluster] 推送状态至对端返回 HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn(`[Cluster] 推送状态至对端失败 (${err.message})`);
    }
  }

  /**
   * 从对端主动拉取最新状态 (Pull Sync)
   */
  async pullStateFromPeer() {
    if (!this.peerUrl) return;
    try {
      const res = await fetch(`${this.peerUrl}${config.routePrefix}/api/cluster/state`, {
        headers: { 'x-api-key': config.apiKey },
        signal: AbortSignal.timeout(6000)
      });
      if (res.ok) {
        const body = await res.json();
        if (body && body.state) {
          const incoming = body.state;
          const local = storage.get() || this.iLink.state;
          const merged = mergeAuthState(local, incoming);

          storage.set(merged, false); // false: 避免再次反向触发推送
          this.iLink.state = merged;
          console.log('[Cluster] 已成功从对端拉取并安全合并最新 auth_state.json');
        }
      }
    } catch (err) {
      console.warn(`[Cluster] 从对端拉取状态失败 (${err.message})`);
    }
  }

  /**
   * 处理对端推送过来的最新状态
   */
  handleIncomingSync(incomingState) {
    if (!incomingState || typeof incomingState !== 'object') return false;
    const local = storage.get() || this.iLink.state;
    const merged = mergeAuthState(local, incomingState);

    storage.set(merged, false); // false: 禁止二次广播，防止死循环
    this.iLink.state = merged;
    console.log('[Cluster] 已收到并安全合并对端同步的最新 auth_state.json');

    // 若本节点当前是 Master 且此前未启动轮询（如用户是在对端备机扫码绑定的），则自动激活长轮询
    if (this.role === 'master' && this.iLink.state.botToken && !this.iLink.pollingActive) {
      console.log('[Cluster] 收到新绑定凭证，Master 自动激活微信长轮询回路...');
      this.iLink.startLongPolling();
    }
    return true;
  }

  /**
   * 启动心跳检测回路（探测对端、故障转移与脑裂预防）
   */
  startHeartbeatLoop() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => this._tickHeartbeat(), config.clusterHeartbeatIntervalMs);
  }

  async _probePeer() {
    if (!this.peerUrl) return { online: false };

    // 严密检查响应是否为 Blitz 休眠拦截页面
    const isAsleepResponse = (text, contentType, status) => {
      if (status === 502 || status === 503 || status === 504) return true;
      if (!text || typeof text !== 'string') return false;
      if (contentType && contentType.toLowerCase().includes('text/html')) {
        return true; // 集群接口绝不可能返回 HTML，凡是 HTML 必然是平台休眠/拦截网关
      }
      return text.includes('This app is asleep') ||
             text.includes('data-kind="asleep"') ||
             text.includes('blitz-wake') ||
             text.includes('Starting container') ||
             text.includes('waking up') ||
             text.includes('<!DOCTYPE html>');
    };

    try {
      const res = await fetch(`${this.peerUrl}${config.routePrefix}/api/cluster/status`, {
        headers: { 'x-api-key': config.apiKey },
        signal: AbortSignal.timeout(4500)
      });
      const contentType = res.headers.get('content-type') || '';
      const text = await res.text();

      if (isAsleepResponse(text, contentType, res.status)) {
        return { online: false, isAsleep: true, reason: '对端实例处于休眠状态' };
      }

      if (res.ok && contentType.includes('application/json')) {
        try {
          const data = JSON.parse(text);
          if (data && typeof data === 'object' && data.success) {
            return { online: true, role: data.role, ...data };
          }
        } catch {}
      }
    } catch {
      // 接口网络错误或超时
    }

    // 兼容直接探测 /health (严格校验 JSON 与 status: ok)
    try {
      const fallbackRes = await fetch(`${this.peerUrl}/health`, { signal: AbortSignal.timeout(4500) });
      const fallbackContentType = fallbackRes.headers.get('content-type') || '';
      const fallbackText = await fallbackRes.text();

      if (isAsleepResponse(fallbackText, fallbackContentType, fallbackRes.status)) {
        return { online: false, isAsleep: true, reason: '对端实例处于休眠状态' };
      }

      if (fallbackRes.ok && fallbackContentType.includes('application/json')) {
        const fallbackData = JSON.parse(fallbackText);
        if (fallbackData && fallbackData.status === 'ok') {
          const fallbackRole = fallbackData.cluster?.role || 'master';
          return { online: true, role: fallbackRole, ...fallbackData };
        }
      }
    } catch {}

    return { online: false };
  }

  async _tickHeartbeat() {
    if (!this.peerUrl) return;

    const probe = await this._probePeer();
    this.peerOnline = probe.online;

    if (probe.online) {
      this.lastHeartbeat = Date.now();
      this.peerRole = probe.role || 'unknown';

      // 1. 备节点场景：对端 Master 存活，重置失败计数
      if (this.role === 'standby') {
        this.failureCount = 0;
      }

      // 2. 脑裂防护场景：两个节点若同时被判定为 Master
      if (this.role === 'master' && probe.role === 'master') {
        if (config.nodeRole === 'standby') {
          // 当前节点配置明确倾向为 standby，主动谦让降级
          this.demoteToStandby('对端已为 Master，且本节点配置偏向为 standby');
        } else if (config.nodeRole === 'auto' && this.lastRoleChangeAt > (probe.lastRoleChangeAt || 0)) {
          // 当前节点更晚变更为 master，后启动者让位于先启动者
          this.demoteToStandby('集群双主冲突，优先保留老节点');
        }
      }
    } else {
      // 对端不在线或超时
      if (this.role === 'standby') {
        this.failureCount++;
        const maxRetries = 3;
        console.warn(`[Cluster] 主节点 (${this.peerUrl}) 心跳无响应 [${this.failureCount}/${maxRetries}]${probe.isAsleep ? ' (对端已休眠)' : ''}`);

        // 连续 3 次心跳失败（约 45 秒），自动晋升为主节点接管工作！
        if (this.failureCount >= maxRetries) {
          this.failureCount = 0;
          this.promoteToMaster(`主节点连续 ${maxRetries} 次无心跳响应${probe.isAsleep ? '(休眠)' : ''}，自动故障接管`);
        }
      }
    }
  }

  /**
   * 获取集群运行时状态（给前端与健康探测使用）
   */
  getStatus() {
    return {
      isCluster: Boolean(this.peerUrl),
      role: this.role,
      configuredRole: config.nodeRole,
      peerUrl: this.peerUrl || null,
      peerOnline: this.peerOnline,
      peerRole: this.peerRole,
      failureCount: this.failureCount,
      lastHeartbeat: this.lastHeartbeat,
      lastSyncSuccess: this.lastSyncSuccess,
      lastRoleChangeAt: this.lastRoleChangeAt,
      isPollingActive: this.iLink.pollingActive,
      isReminderActive: Boolean(this.reminderService.intervalTimer)
    };
  }

  stop() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.unsubscribeStorage) {
      this.unsubscribeStorage();
    }
  }
}
