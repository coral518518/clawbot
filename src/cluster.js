import { config } from './config.js';
import { storage } from './storage.js';

/**
 * 安全合并对端状态，防止对端的空凭证或陈旧数据覆盖本地有效凭证
 * 核心原则：
 * 1. 显式注销优先：若 incoming 标记了 isExplicitLogout（用户在管理后台主动解绑），允许合法清空本地凭证；
 * 2. 账号凭据保护：若 local 有有效 botToken，而 incoming 为空且未显式注销，坚决保留 local 凭据；
 * 3. 会话单调性与 CRDT 融合（彻底杜绝配额倒退）：
 *    - 若两端持有【同一个】contextToken：配额已用次数 contextTokenUsedCount 严格取两者最大值 Math.max(...)，
 *      绝不允许任何陈旧的从节点快照将已消耗配额倒退（如已用 2 条剩 8 条绝不可能被倒退回剩 9 条）；
 *    - 若两端是【不同】的 contextToken：比对创建时间 contextTokenCreatedAt，采纳真正更新的会话及其实时计数；
 * 4. 提醒与 Webhook 标记：一旦任一节点标记为已触发，合并后坚决保持已触发，杜绝重复骚扰；
 * 5. 更新时间戳 updatedAt 自动推进为两者与当前时间的最大值，避免版本陈旧。
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

  // 2. 账号凭据合并 (botToken, botId, userId)
  if (incomingHasToken) {
    if (!localHasToken || incoming.botToken !== local.botToken) {
      // 扫码换绑了新 Bot 或本地原本无 Token：比对时间戳采纳最新
      if (!localHasToken || incomingTime >= localTime) {
        result.botToken = incoming.botToken;
        result.botId = incoming.botId;
        result.userId = incoming.userId;
        result.userWechatId = incoming.userWechatId || incoming.userId;
      }
    }
  } else if (localHasToken) {
    console.warn('[Cluster] 拦截到对端空凭证同步请求，本地有效微信凭证已受保护，拒绝抹除！');
  }

  // 3. 会话凭据与配额合并 (contextToken & contextTokenUsedCount)
  const incomingHasCtx = Boolean(incoming.contextToken);
  const localHasCtx = Boolean(local.contextToken);

  if (incomingHasCtx && localHasCtx && incoming.contextToken === local.contextToken) {
    // 【关键场景 A】：两端持有同一个会话 Token（常规运行发消息扣配额）
    // 配额已用条数严格单调递增！谁用得多说明谁发了更多通知，绝对不能被旧快照倒退！
    const localUsed = Number(local.contextTokenUsedCount || 0);
    const incomingUsed = Number(incoming.contextTokenUsedCount || 0);
    const maxUsed = Math.max(localUsed, incomingUsed);
    result.contextTokenUsedCount = maxUsed;

    // 保留正确的创建时间与到期时间
    result.contextTokenCreatedAt = local.contextTokenCreatedAt || incoming.contextTokenCreatedAt;
    result.contextTokenExpireAt = local.contextTokenExpireAt || incoming.contextTokenExpireAt;

    // 活跃时间取较晚者
    result.lastActiveTime = Math.max(Number(local.lastActiveTime || 0), Number(incoming.lastActiveTime || 0));

    // 提醒与 Webhook 触发状态：只要任一方已触发过，合并后保持已触发
    if (local.reminderSentToken === result.contextToken || incoming.reminderSentToken === result.contextToken) {
      result.reminderSentToken = result.contextToken;
      result.reminderSentAt = local.reminderSentAt || incoming.reminderSentAt || Date.now();
    }
    if (local.webhookTriggeredToken === result.contextToken || incoming.webhookTriggeredToken === result.contextToken) {
      result.webhookTriggeredToken = result.contextToken;
      result.webhookTriggeredAt = local.webhookTriggeredAt || incoming.webhookTriggeredAt || Date.now();
      result.webhookLastStatus = local.webhookLastStatus || incoming.webhookLastStatus || 200;
    }

    // 游标取非空且较长者（通常代表收到了更多微信消息）
    if (incoming.syncBuf && (!result.syncBuf || incomingTime >= localTime)) {
      result.syncBuf = incoming.syncBuf;
    }

    // 失效原因更新
    if (maxUsed >= config.maxQuota) {
      result.invalidationReason = `本轮 ${config.maxQuota} 条推送配额已全部用完，状态已自动流转为 WAITING_CONTEXT，请在微信回复任意内容恢复`;
    } else if (incomingTime >= localTime && incoming.invalidationReason !== undefined) {
      result.invalidationReason = incoming.invalidationReason;
    }
  } else if (incomingHasCtx) {
    // 【场景 B】：对端拥有不同（更新）的会话 Token，或者本地本来没有会话
    const incomingCreatedAt = Number(incoming.contextTokenCreatedAt || incomingTime);
    const localCreatedAt = Number(local.contextTokenCreatedAt || localTime);

    if (!localHasCtx || incomingCreatedAt >= localCreatedAt) {
      // 对端捕获到了用户更新的微信回复，全面采纳新会话！
      result.contextToken = incoming.contextToken;
      result.contextTokenUsedCount = Number(incoming.contextTokenUsedCount || 0);
      result.contextTokenCreatedAt = incoming.contextTokenCreatedAt || Date.now();
      result.contextTokenExpireAt = incoming.contextTokenExpireAt || (Date.now() + 24 * 3600 * 1000);
      result.syncBuf = incoming.syncBuf || result.syncBuf;
      result.lastActiveTime = incoming.lastActiveTime || Date.now();
      result.reminderSentToken = incoming.reminderSentToken || null;
      result.reminderSentAt = incoming.reminderSentAt || null;
      result.webhookTriggeredToken = incoming.webhookTriggeredToken || null;
      result.webhookTriggeredAt = incoming.webhookTriggeredAt || null;
      result.webhookLastStatus = incoming.webhookLastStatus || null;
      result.webhookLastError = incoming.webhookLastError || null;
      result.invalidationReason = incoming.invalidationReason || null;
    } else {
      console.log('[Cluster] 本地持有的会话比对端传入的会话更新，保留本地会话凭据');
    }
  }

  // 推进数据版本更新时间戳，确保高于两者，防止再次比对时被陈旧判定
  result.updatedAt = Math.max(localTime, incomingTime, Date.now());
  return result;
}

/**
 * ClusterManager: 跨云多节点高可用集群协调器 (Netrun.io <-> Miget <-> Blitz Cloud)
 * 职责：
 * 1. 多节点主备竞选与防脑裂（基于优先级 NODE_PRIORITY 确定性选举），保证全集群永远只有 1 个实例运行长轮询与守护任务；
 * 2. 状态全自动实时广播同步（登录凭证、Token、配额、游标变化并发推送到所有对端）；
 * 3. 心跳探活与分级自动故障转移（Failover）：高优先级主节点宕机时，次高优先级备节点自动接管，主节点恢复时优雅让出。
 */
export class ClusterManager {
  constructor(iLink, reminderService) {
    this.iLink = iLink;
    this.reminderService = reminderService;
    if (this.reminderService) {
      this.reminderService.clusterManager = this;
    }
    this.peerUrls = Array.isArray(config.peerUrls) ? config.peerUrls : [];
    this.peerUrl = this.peerUrls[0] || ''; // 向后兼容旧接口与单节点引用
    this.nodePriority = config.nodePriority;
    this.role = config.nodeRole === 'standby' ? 'standby' : 'master'; // 初始角色

    // 多对端节点运行时状态映射表: url => { url, online, role, priority, lastSeen, isAsleep, failureCount, error }
    this.peersStatus = new Map();
    for (const url of this.peerUrls) {
      this.peersStatus.set(url, {
        url,
        online: null,
        role: null,
        priority: 0,
        lastSeen: null,
        failureCount: 0,
        isAsleep: false,
        error: null
      });
    }

    this.failureCount = 0; // 连续未检测到存活 Master 的心跳周期计数
    this.lastHeartbeat = null;
    this.lastSyncSuccess = null;
    this.lastRoleChangeAt = Date.now();
    this.heartbeatTimer = null;
    this.unsubscribeStorage = null;
  }

  /**
   * 初始化多节点集群
   */
  async init() {
    // 监听本地存储变更，无论本节点是 Master 还是 Standby，只要有本地发起的有效变更均并发推送到所有对端
    this.unsubscribeStorage = storage.subscribe((state) => {
      if (this.peerUrls.length > 0 && state) {
        this.syncToPeers(state);
      }
    });

    if (this.peerUrls.length === 0) {
      console.log('[Cluster] 未配置 PEER_URLS / PEER_URL，当前服务以独立单机模式运行 (Role: Master)');
      this.role = 'master';
      this.startMasterTasks();
      return;
    }

    console.log(`[Cluster] 多节点集群模式启动！节点权重(Priority): ${this.nodePriority} | 初始预设角色: ${config.nodeRole}`);
    console.log(`[Cluster] 对端节点列表 (${this.peerUrls.length} 个):`, this.peerUrls.join(', '));

    // 1. 启动时主动并发探测所有对端节点状态
    await this._probeAllPeers();

    // 2. 无论本节点最终角色为何，启动时务必优先从存活对端（优先在线 Master）拉取最新权威 auth_state.json！
    // 这样当主节点重启恢复时，能瞬间补齐停机期间备机接管时更新的最新凭证与已用配额计数
    await this.pullStateFromPeers(null, false);

    const onlinePeers = Array.from(this.peersStatus.values()).filter(p => p.online);
    const activeMaster = onlinePeers.find(p => p.role === 'master');
    const higherPriorityPeer = onlinePeers.find(p => (p.priority || 0) > this.nodePriority);

    // 3. 自适应角色决策与抢占机制
    if (config.nodeRole === 'standby') {
      console.log('[Cluster] 环境变量显式配置为固定 Standby 备用角色');
      this.role = 'standby';
      this.stopMasterTasks();
    } else if (config.nodeRole === 'master') {
      console.log('[Cluster] 环境变量显式配置为固定 Master 主控角色');
      this.role = 'master';
      this.startMasterTasks();
      this.syncToPeers(this.iLink.state).catch(() => {});
    } else {
      // auto 动态自适应选举模式：
      if (higherPriorityPeer) {
        // 集群中存在权重严格高于本节点的存活节点 -> 本节点必须让位为 Standby
        console.log(`[Cluster] 探测到更高优先级的在线节点 (${higherPriorityPeer.url}, Priority: ${higherPriorityPeer.priority} > ${this.nodePriority})，当前节点设为 Standby 备用`);
        this.role = 'standby';
        this.stopMasterTasks();
      } else if (activeMaster && (activeMaster.priority || 0) > this.nodePriority) {
        // 存在在线 Master 且对方权重高于本节点 -> 保持 Standby
        console.log(`[Cluster] 探测到在线 Master (${activeMaster.url}, Priority: ${activeMaster.priority} > ${this.nodePriority})，当前节点设为 Standby 备用`);
        this.role = 'standby';
        this.stopMasterTasks();
      } else {
        // 本节点权重高于或等于全网存活节点（例如主节点 Netrun 重启恢复，权重 100 高于当前临时 Master Miget 的 80）：
        // 触发高权重节点抢占式晋升为 Master！
        if (activeMaster) {
          console.warn(`[Cluster] ⚡ 抢占接管：本节点已拉取最新凭据并启动，权重 (${this.nodePriority}) 高于当前临时主控 (${activeMaster.url}, Priority: ${activeMaster.priority})，主动升级为新 Master！`);
        } else {
          console.log(`[Cluster] 未发现活跃主节点，且本节点在存活节点中权重最高 [Priority: ${this.nodePriority}]，当前节点自动接管为 Master`);
        }
        this.role = 'master';
        this.startMasterTasks();
        // 立即向全网广播最新状态与主控身份，促使旧主控退位让贤
        this.syncToPeers(this.iLink.state).catch(() => {});
      }
    }

    // 启动多节点心跳与故障转移检测回路
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
    console.log(`[Cluster] ★ 当前节点已激活 MASTER 权限 [Priority: ${this.nodePriority}]：长轮询与守护任务运行中`);
  }

  /**
   * 停止 Master 任务（降级为 Standby 备用）
   */
  stopMasterTasks() {
    this.role = 'standby';
    this.lastRoleChangeAt = Date.now();

    this.iLink.stopLongPolling();
    this.reminderService.stop();
    console.log(`[Cluster] ⏸ 当前节点已切换至 STANDBY 状态 [Priority: ${this.nodePriority}]：长轮询与定时守护任务静默待命中`);
  }

  /**
   * 晋升为主节点 (Promote to Master)
   */
  async promoteToMaster(reason = '手动晋升') {
    if (this.role === 'master') return;
    console.warn(`[Cluster] ⚡ 故障接管：备机晋升为 MASTER！原因: ${reason}`);

    // 晋升前，务必先从存活对端拉取一次最新状态，防止接管前有更新未落盘
    await this.pullStateFromPeers(null, false);

    // 重新加载本地最新 auth_state
    const latestState = storage.get();
    if (latestState) {
      this.iLink.state = latestState;
    }
    this.startMasterTasks();

    // 晋升后主动向所有备机广播，确立权威地位并促使低权重对端让位
    if (this.peerUrls.length > 0) {
      this.syncToPeers(this.iLink.state).catch(() => {});
    }
  }

  /**
   * 降级为备节点 (Demote to Standby)
   */
  async demoteToStandby(reason = '让出 Master 权限') {
    if (this.role === 'standby') return;
    console.warn(`[Cluster] ⚡ 主备协调：当前节点降级为 STANDBY！原因: ${reason}`);
    this.stopMasterTasks();

    // 降级前，若本地有有效凭据，主动向所有对端推送最新状态，确保新主机拿到最新凭证
    const local = storage.get() || this.iLink.state;
    if (local && local.botToken) {
      await this.syncToPeers(local).catch(() => {});
    }
    await this.pullStateFromPeers(null, false);
  }

  /**
   * 将当前状态并发推送到所有对端 (Push Sync)
   */
  async syncToPeers(state) {
    if (!this.peerUrls.length || !state) return;
    const tasks = this.peerUrls.map(url => this._syncToSinglePeer(url, state));
    const results = await Promise.allSettled(tasks);
    const successCount = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
    if (successCount > 0) {
      this.lastSyncSuccess = Date.now();
      console.log(`[Cluster] 已将最新 auth_state.json 实时推送到 ${successCount}/${this.peerUrls.length} 个对端节点`);
    }
  }

  /**
   * 向单个对端推送状态
   */
  async _syncToSinglePeer(url, state) {
    if (!url || !state) return false;
    const current = this.peersStatus.get(url) || { url };
    try {
      const res = await fetch(`${url}${config.routePrefix}/api/cluster/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'x-cluster-sender-role': this.role,
          'x-cluster-sender-priority': String(this.nodePriority)
        },
        body: JSON.stringify(state),
        signal: AbortSignal.timeout(6000)
      });
      if (res.ok) {
        this.peersStatus.set(url, {
          ...current,
          lastSyncTime: Date.now(),
          lastSyncStatus: 'success',
          lastSyncError: null
        });
        return true;
      }
      let errDetail = `HTTP ${res.status}`;
      try {
        const json = await res.json();
        if (json.error || json.message) errDetail += ` (${json.error || json.message})`;
      } catch {}
      console.warn(`[Cluster] 推送状态至对端 (${url}) 返回失败: ${errDetail}`);
      this.peersStatus.set(url, {
        ...current,
        lastSyncTime: Date.now(),
        lastSyncStatus: 'failed',
        lastSyncError: errDetail
      });
      return false;
    } catch (err) {
      console.warn(`[Cluster] 推送状态至对端 (${url}) 失败: ${err.message}`);
      this.peersStatus.set(url, {
        ...current,
        lastSyncTime: Date.now(),
        lastSyncStatus: 'failed',
        lastSyncError: err.message
      });
      return false;
    }
  }

  // 兼容旧的单个参数调用
  async syncToPeer(state, specificUrl = null) {
    if (specificUrl) {
      return this._syncToSinglePeer(specificUrl, state);
    }
    return this.syncToPeers(state);
  }

  /**
   * 从集群对端拉取最新状态 (Pull Sync)
   * 优先拉取存活且为 Master 的节点，其次拉取高优先级或最后活跃的节点
   */
  async pullStateFromPeers(targetUrl = null, throwOnError = false) {
    if (!this.peerUrls.length) {
      if (throwOnError) throw new Error('未配置 PEER_URLS / PEER_URL 对端节点列表');
      return false;
    }

    // 确定拉取候选 URL 列表
    let candidates = [];
    if (targetUrl) {
      candidates = [targetUrl];
    } else {
      // 按照“在线 Master > 在线高优先级 > 其他”排序
      const peerArray = this.peerUrls.map(url => {
        const info = this.peersStatus.get(url) || {};
        return {
          url,
          online: Boolean(info.online),
          isMaster: info.role === 'master',
          priority: info.priority || 0
        };
      });

      peerArray.sort((a, b) => {
        if (a.isMaster !== b.isMaster) return a.isMaster ? -1 : 1;
        if (a.online !== b.online) return a.online ? -1 : 1;
        return (b.priority || 0) - (a.priority || 0);
      });

      candidates = peerArray.map(p => p.url);
    }

    let lastError = null;
    for (const url of candidates) {
      try {
        const res = await fetch(`${url}${config.routePrefix}/api/cluster/state`, {
          headers: { 'x-api-key': config.apiKey },
          signal: AbortSignal.timeout(6000)
        });

        if (res.ok) {
          const body = await res.json();
          if (body && body.state) {
            const incoming = body.state;
            const local = storage.get() || this.iLink.state;
            const merged = mergeAuthState(local, incoming);

            storage.set(merged, false); // false: 避免反向循环广播
            this.iLink.state = merged;
            console.log(`[Cluster] 已成功从节点 (${url}) 拉取并安全合并最新 auth_state.json [配额已用: ${merged.contextTokenUsedCount || 0}]`);

            // 若本节点当前是 Master，拉取并合并后顺手将全网最新权威状态反向广播给所有从节点，纠正从节点陈旧数据
            if (this.role === 'master' && this.peerUrls.length > 0) {
              console.log('[Cluster] Master 节点已完成权威状态合并，正在反向广播修正全网从节点数据...');
              this.syncToPeers(this.iLink.state).catch(() => {});
            }

            return true;
          }
        } else {
          const errData = await res.json().catch(() => null);
          const errMsg = errData?.error || errData?.message || `HTTP ${res.status}`;
          lastError = new Error(`节点 ${url} 响应错误: ${errMsg}`);
          console.warn(`[Cluster] 从对端 (${url}) 拉取状态返回失败: ${errMsg}`);
        }
      } catch (err) {
        lastError = err;
        console.warn(`[Cluster] 从对端 (${url}) 拉取状态失败: ${err.message}`);
      }
    }

    if (throwOnError) {
      throw lastError || new Error('未能从任何集群对端节点成功拉取到状态');
    }
    return false;
  }

  // 保持向后兼容的方法名
  async pullStateFromPeer(throwOnError = false) {
    return this.pullStateFromPeers(null, throwOnError);
  }

  /**
   * 处理对端推送过来的最新状态
   */
  handleIncomingSync(incomingState, senderRole = null, senderPriority = 0) {
    if (!incomingState || typeof incomingState !== 'object') return false;
    const local = storage.get() || this.iLink.state;
    const merged = mergeAuthState(local, incomingState);

    storage.set(merged, false); // false: 禁止二次广播，防止死循环
    this.iLink.state = merged;
    console.log('[Cluster] 已收到并安全合并对端同步的最新 auth_state.json');

    // 核心让位协同：若本节点当前是 Master，但收到更高优先级的 Master 同步，本节点立即退位让贤为 Standby！
    if (this.role === 'master' && senderRole === 'master' && Number(senderPriority) > this.nodePriority) {
      console.warn(`[Cluster] ⚡ 收到更高优先级 Master [Priority: ${senderPriority} > ${this.nodePriority}] 的状态推送，本节点立即让位为 Standby！`);
      this.demoteToStandby(`收到更高优先级主节点推送 (Priority: ${senderPriority})`);
      return true;
    }

    // 若本节点当前是 Master 且此前未启动轮询（如用户是在对端备机扫码绑定的），则自动激活长轮询
    if (this.role === 'master' && this.iLink.state.botToken && !this.iLink.pollingActive) {
      console.log('[Cluster] 收到新绑定凭证，Master 自动激活微信长轮询回路...');
      this.iLink.startLongPolling();
    }
    return true;
  }

  /**
   * 启动心跳检测回路
   */
  startHeartbeatLoop() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => this._tickHeartbeat(), config.clusterHeartbeatIntervalMs);
  }

  /**
   * 探测单个对端状态
   */
  async _probeSinglePeer(url) {
    const isAsleepResponse = (text, contentType, status) => {
      if (status === 502 || status === 503 || status === 504) return true;
      if (!text || typeof text !== 'string') return false;
      if (contentType && contentType.toLowerCase().includes('text/html')) {
        return true;
      }
      return text.includes('This app is asleep') ||
             text.includes('data-kind="asleep"') ||
             text.includes('blitz-wake') ||
             text.includes('Starting container') ||
             text.includes('waking up') ||
             text.includes('<!DOCTYPE html>');
    };

    try {
      const res = await fetch(`${url}${config.routePrefix}/api/cluster/status`, {
        headers: { 'x-api-key': config.apiKey },
        signal: AbortSignal.timeout(4500)
      });
      const contentType = res.headers.get('content-type') || '';
      const text = await res.text();

      if (isAsleepResponse(text, contentType, res.status)) {
        return { online: false, isAsleep: true, role: 'unknown', priority: 0, reason: '对端实例处于休眠状态' };
      }

      if (res.ok && contentType.includes('application/json')) {
        const data = JSON.parse(text);
        if (data && typeof data === 'object' && data.success) {
          return {
            online: true,
            isAsleep: false,
            role: data.role || 'standby',
            priority: data.priority !== undefined ? data.priority : 50,
            lastRoleChangeAt: data.lastRoleChangeAt || 0,
            ...data
          };
        }
      }
    } catch {}

    // Fallback 探测 /health
    try {
      const fallbackRes = await fetch(`${url}/health`, { signal: AbortSignal.timeout(4500) });
      const fallbackContentType = fallbackRes.headers.get('content-type') || '';
      const fallbackText = await fallbackRes.text();

      if (isAsleepResponse(fallbackText, fallbackContentType, fallbackRes.status)) {
        return { online: false, isAsleep: true, role: 'unknown', priority: 0, reason: '对端实例处于休眠状态' };
      }

      if (fallbackRes.ok && fallbackContentType.includes('application/json')) {
        const fallbackData = JSON.parse(fallbackText);
        if (fallbackData && fallbackData.status === 'ok') {
          return {
            online: true,
            isAsleep: false,
            role: fallbackData.cluster?.role || 'master',
            priority: fallbackData.cluster?.priority !== undefined ? fallbackData.cluster.priority : 50,
            lastRoleChangeAt: fallbackData.cluster?.lastRoleChangeAt || 0,
            ...fallbackData
          };
        }
      }
    } catch {}

    return { online: false, isAsleep: false, role: 'unknown', priority: 0 };
  }

  /**
   * 并发探测所有对端节点
   */
  async _probeAllPeers() {
    if (!this.peerUrls.length) return;
    const tasks = this.peerUrls.map(async (url) => {
      const probe = await this._probeSinglePeer(url);
      const current = this.peersStatus.get(url) || { url, failureCount: 0 };
      this.peersStatus.set(url, {
        ...current,
        url,
        online: probe.online,
        role: probe.role,
        priority: probe.priority !== undefined ? probe.priority : 50,
        lastRoleChangeAt: probe.lastRoleChangeAt || 0,
        isAsleep: Boolean(probe.isAsleep),
        lastSeen: probe.online ? Date.now() : current.lastSeen,
        failureCount: probe.online ? 0 : (current.failureCount + 1),
        error: probe.reason || (probe.online ? null : '连接超时或无响应')
      });
    });
    await Promise.allSettled(tasks);
  }

  // 兼容旧的单对端探测
  async _probePeer() {
    if (!this.peerUrls.length) return { online: false };
    await this._probeAllPeers();
    const primary = this.peersStatus.get(this.peerUrls[0]);
    return primary || { online: false };
  }

  /**
   * 心跳周期触发：多节点探活、脑裂预防与分级故障转移
   */
  async _tickHeartbeat() {
    if (!this.peerUrls.length) return;

    await this._probeAllPeers();
    this.lastHeartbeat = Date.now();

    const onlinePeers = Array.from(this.peersStatus.values()).filter(p => p.online);
    const activeMasters = onlinePeers.filter(p => p.role === 'master');

    // 场景 1：当前节点是 Standby 备用节点
    if (this.role === 'standby') {
      if (activeMasters.length > 0) {
        // 集群中已有健康的 Master 在正常工作
        // 关键增强：检查运行中的 Master 权重是否低于本节点！
        // 如果本节点权重（如 Netrun=100）高于当前 Master（如 Miget=80），说明高优先级节点已恢复，必须触发抢占恢复主节点！
        const lowerPriorityMaster = activeMasters.find(m => (m.priority || 0) < this.nodePriority);
        if (lowerPriorityMaster && config.nodeRole !== 'standby') {
          console.warn(`[Cluster] ⚡ 发现当前运行中的 Master (${lowerPriorityMaster.url}, Priority: ${lowerPriorityMaster.priority}) 权重低于本节点 (${this.nodePriority})，触发高优先级节点抢占接管！`);
          this.failureCount = 0;
          await this.promoteToMaster(`本节点权重最高 [Priority: ${this.nodePriority} > ${lowerPriorityMaster.priority}]，抢占升级为 Master`);
          return;
        }
        this.failureCount = 0;
      } else {
        // 全集群未发现任何存活的 Master！
        this.failureCount++;
        const maxRetries = 2; // 2 次心跳周期（约 30 秒）无主，进入分级容灾选举
        console.warn(`[Cluster] 警告：全集群当前无活跃 Master [${this.failureCount}/${maxRetries}]`);

        if (this.failureCount >= maxRetries) {
          // 比较存活的备节点最高权重
          const highestPeerPriority = onlinePeers.length > 0
            ? Math.max(...onlinePeers.map(p => p.priority || 0))
            : -1;

          if (this.nodePriority > highestPeerPriority) {
            // 本节点权重高于所有存活对端，当仁不让接管 Master！
            this.failureCount = 0;
            await this.promoteToMaster(`主节点故障，且本节点在存活节点中权重最高 [Priority: ${this.nodePriority} > ${highestPeerPriority}]`);
          } else if (this.nodePriority === highestPeerPriority) {
            // 权重极端相同：根据显式配置或字母序裁决，防止脑裂
            const myUrl = config.routePrefix;
            const peerUrlsSorted = onlinePeers.map(p => p.url).sort();
            if (peerUrlsSorted.length === 0 || myUrl < peerUrlsSorted[0]) {
              this.failureCount = 0;
              await this.promoteToMaster(`主节点故障且权重并列，决胜获胜晋升 Master`);
            }
          } else {
            // 存活节点中有更高权重的备机（例如 Netrun 挂了，Miget(80) 还在，Blitz(60) 看到 Miget 存活），本节点绝不争抢，保持静默！
            console.log(`[Cluster] 检测到权重更高的在线备机 (Priority: ${highestPeerPriority} > ${this.nodePriority})，保持 Standby 静候其接管`);
            this.failureCount = 0;
          }
        }
      }
    }

    // 场景 2：当前节点是 Master，检测是否有双主冲突 (Split-Brain)
    if (this.role === 'master' && activeMasters.length > 0) {
      // 找出对方 Master 中权重最高的节点
      const topMaster = activeMasters.reduce((prev, curr) => (curr.priority > prev.priority ? curr : prev), activeMasters[0]);

      if (topMaster.priority > this.nodePriority) {
        // 对方权重高于本节点（例如高优先级的 Netrun 恢复上线）：主动谦让降级为 Standby！
        console.warn(`[Cluster] ⚡ 发现更高优先级的主节点 (${topMaster.url}, Priority: ${topMaster.priority} > ${this.nodePriority}) 已恢复，本节点主动让出 Master 权限`);
        await this.demoteToStandby(`高优先级主节点恢复 (${topMaster.url})`);
      } else if (topMaster.priority === this.nodePriority) {
        // 权重相同：后晋升者让位于先晋升者
        if (this.lastRoleChangeAt > (topMaster.lastRoleChangeAt || 0)) {
          console.warn(`[Cluster] 双主冲突且权重并列，后晋升者主动让位降级`);
          await this.demoteToStandby('双主冲突时间戳让位');
        }
      } else {
        // 本节点权重更高：继续维持 Master，低优先级对端会在其心跳探活中自动降级
      }
    }
  }

  /**
   * 获取多节点集群运行时状态（给前端与监控使用）
   */
  getStatus() {
    const peersArray = Array.from(this.peersStatus.values()).map(p => ({
      url: p.url,
      online: p.online,
      role: p.role,
      priority: p.priority,
      lastSeen: p.lastSeen,
      isAsleep: p.isAsleep,
      failureCount: p.failureCount,
      error: p.error,
      lastSyncTime: p.lastSyncTime || null,
      lastSyncStatus: p.lastSyncStatus || null,
      lastSyncError: p.lastSyncError || null
    }));

    const primaryPeer = peersArray[0] || null;

    return {
      isCluster: this.peerUrls.length > 0,
      role: this.role,
      priority: this.nodePriority,
      configuredRole: config.nodeRole,
      peers: peersArray,
      peerUrls: this.peerUrls,
      // 向下兼容单对端字段
      peerUrl: this.peerUrl || null,
      peerOnline: peersArray.some(p => p.online),
      peerRole: peersArray.find(p => p.role === 'master')?.role || (primaryPeer?.role || null),
      failureCount: this.failureCount,
      lastHeartbeat: this.lastHeartbeat,
      lastSyncSuccess: this.lastSyncSuccess,
      lastRoleChangeAt: this.lastRoleChangeAt,
      isPollingActive: this.iLink.pollingActive,
      isReminderActive: Boolean(this.reminderService?.timer)
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

