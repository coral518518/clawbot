import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config, saveTriggerConfig } from './config.js';
import { storage } from './storage.js';
import { iLink } from './ilink-client.js';
import { reminderService } from './reminder.js';
import { requireApiKey, apiLimiter } from './middleware.js';
import { ClusterManager } from './cluster.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const adminHtmlPath = path.join(__dirname, 'admin.html');

const app = express();

// 隐藏服务端特征
app.disable('x-powered-by');

// 兼容反向代理（如 Nginx、Caddy、Cloudflare、Docker 容器）
app.set('trust proxy', 1);

// 解析 JSON 与 URL-encoded 请求体
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// 创建专属路由器，挂载于 config.routePrefix（默认 /coral）
const router = express.Router();

// 实例化集群协调器
export const clusterManager = new ClusterManager(iLink, reminderService);

// 针对 blitz.cloud 与 Cloudflare 边缘代理禁用动态接口缓存
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// 1. 保活与外部健康检查处理函数（无鉴权，便于外部监控如 Uptime Kuma 探测）
function handleHealth(req, res) {
  res.json({
    status: 'ok',
    cluster: clusterManager.getStatus(),
    gateway_state: iLink.statusDescription,
    quota: {
      remaining: iLink.remainingQuota,
      used: iLink.state.contextTokenUsedCount || 0,
      total: config.maxQuota
    },
    expire_remaining_hours: (iLink.remainingTimeMs / 3600000).toFixed(1),
    timestamp: Date.now()
  });
}

// 根路径健康检查（无需 ROUTE_PREFIX，直接访问 /health，同时也兼容前缀访问）
app.get('/health', handleHealth);
router.get('/health', handleHealth);

// 2. 查看当前网关详细状态（包含配额与失效自动流转信息）
router.get('/api/status', requireApiKey, (req, res) => {
  res.json({
    success: true,
    cluster: clusterManager.getStatus(),
    status: iLink.statusDescription,
    userId: iLink.effectiveUserId || iLink.state.userId || null,
    botId: iLink.state.botId || null,
    hasContextToken: Boolean(iLink.state.contextToken),
    quota: {
      used: Number(iLink.state.contextTokenUsedCount) || 0,
      remaining: iLink.remainingQuota,
      total: config.maxQuota
    },
    expireAt: iLink.state.contextTokenExpireAt || null,
    expireRemainingHours: (iLink.remainingTimeMs / 3600000).toFixed(1),
    reminder: reminderService.getStatus(),
    invalidationDetail: iLink.invalidationDetail,
    batchWindowMs: config.batchWindowMs,
    lastActiveTime: iLink.state.lastActiveTime || null
  });
});

// 3. 核心接口：发送微信通知（支持单条、批量合批与智能防风暴合并）
// POST /coral/api/send
router.post('/api/send', apiLimiter, requireApiKey, async (req, res) => {
  const isImmediate = Boolean(req.body.immediate || req.query.immediate === '1' || req.query.immediate === 'true');

  // 支持显式传入批量数组：{ messages: [...] } 或直接 [...]
  const messagesArray = Array.isArray(req.body) ? req.body : req.body.messages;
  if (Array.isArray(messagesArray) && messagesArray.length > 0) {
    try {
      const result = await iLink.sendBatch(messagesArray, req.body.title);
      return res.json({
        success: true,
        batched: true,
        count: messagesArray.length,
        result,
        quota: {
          remaining: iLink.remainingQuota,
          used: iLink.state.contextTokenUsedCount,
          total: config.maxQuota
        }
      });
    } catch (err) {
      return res.status(502).json({ success: false, error: err.message });
    }
  }

  // 单条消息
  const text = req.body.text || req.body.content || req.body.message;
  const title = req.body.title || null;

  if (!text || typeof text !== 'string') {
    return res.status(400).json({
      success: false,
      error: '缺少通知内容字段：text（或 content / message）必须为非空字符串'
    });
  }

  try {
    const result = await iLink.sendMessage(text, title, isImmediate);
    res.json({
      success: true,
      result,
      batched: Boolean(result && result.batched),
      batchCount: result && result.count ? result.count : 1,
      quota: {
        remaining: iLink.remainingQuota,
        used: iLink.state.contextTokenUsedCount,
        total: config.maxQuota
      },
      expireRemainingHours: (iLink.remainingTimeMs / 3600000).toFixed(1)
    });
  } catch (err) {
    res.status(502).json({
      success: false,
      error: err.message,
      gateway_state: iLink.statusDescription,
      invalidationDetail: iLink.invalidationDetail
    });
  }
});

// GET /coral/api/send （简易 Webhook 形式，支持 ?text=...&title=...&immediate=1）
router.get('/api/send', apiLimiter, requireApiKey, async (req, res) => {
  const text = req.query.text || req.query.content || req.query.message;
  const title = req.query.title || null;
  const isImmediate = req.query.immediate === '1' || req.query.immediate === 'true';

  if (!text || typeof text !== 'string') {
    return res.status(400).json({
      success: false,
      error: '缺少通知内容参数：text 必须为非空字符串'
    });
  }

  try {
    const result = await iLink.sendMessage(text, title, isImmediate);
    res.json({
      success: true,
      result,
      batched: Boolean(result && result.batched),
      quota: {
        remaining: iLink.remainingQuota,
        used: iLink.state.contextTokenUsedCount,
        total: config.maxQuota
      }
    });
  } catch (err) {
    res.status(502).json({
      success: false,
      error: err.message,
      gateway_state: iLink.statusDescription
    });
  }
});

// 4. 管理端配套接口
router.get('/admin/get-qrcode', requireApiKey, async (req, res) => {
  try {
    const data = await iLink.fetchQrCode();
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/admin/check-qrcode', requireApiKey, async (req, res) => {
  try {
    const { qrcode } = req.query;
    if (!qrcode) {
      return res.status(400).json({ success: false, error: '缺少 qrcode 参数' });
    }
    const data = await iLink.checkQrStatus(qrcode);
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/admin/sync-messages', requireApiKey, async (req, res) => {
  try {
    const reset = Boolean(req.query.reset === '1' || req.body?.reset);
    const { data, captured, count } = await iLink.fetchUpdatesOnce(reset);
    res.json({
      success: true,
      capturedToken: captured || Boolean(iLink.state.contextToken),
      status: iLink.statusDescription,
      hasContextToken: Boolean(iLink.state.contextToken),
      msgsCount: count || (Array.isArray(data?.msgs) ? data.msgs.length : 0),
      ret: data?.ret ?? data?.errcode ?? 0,
      errmsg: data?.errmsg || null,
      rawKeys: Object.keys(data || {})
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/admin/logout', requireApiKey, (req, res) => {
  try {
    iLink.logout();
    res.json({ success: true, message: '已成功解除配对并清除本地授权凭据' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 手动测试发送保活提醒通知
router.post('/admin/test-reminder', requireApiKey, async (req, res) => {
  try {
    const result = await reminderService.checkAndTrigger(true);
    res.json({
      success: true,
      message: '测试保活提醒通知已成功推送至微信！请在微信查看并回复任意内容进行测试。',
      result
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 手动测试触发 Token 到期前半小时外部 Webhook 任务
router.post('/admin/test-trigger-webhook', requireApiKey, async (req, res) => {
  try {
    const result = await reminderService.checkAndTriggerWebhook(true);
    res.json({
      success: true,
      message: `到期前半小时 Webhook 任务执行成功！[HTTP ${result.status}]`,
      result
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 手动测试触发每日鉴权凭据冷备份至远端接口
router.post('/admin/trigger-daily-backup', requireApiKey, async (req, res) => {
  try {
    const result = await reminderService.checkAndTriggerDailyBackup(true);
    res.json({
      success: true,
      message: `每日鉴权凭据已成功冷备份至远端！[HTTP ${result.status}]`,
      result
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 隐蔽接口：上传并还原鉴权票据 (从远端备份导入，恢复后全网自动广播同步并激活长轮询)
router.post('/api/restore-auth', requireApiKey, async (req, res) => {
  try {
    let incoming = req.body?.state || req.body?.data || req.body;
    if (typeof incoming === 'string') {
      try { incoming = JSON.parse(incoming); } catch {}
    }

    if (!incoming || typeof incoming !== 'object' || !incoming.botToken || typeof incoming.botToken !== 'string' || incoming.botToken.trim().length < 10) {
      return res.status(400).json({
        success: false,
        error: '无效的票据数据：请求体必须为合法 JSON 且必须包含有效的 botToken'
      });
    }

    // 格式化与时间戳推进
    incoming.updatedAt = Date.now();
    delete incoming.isExplicitLogout;

    // 持久化存储并触发本地更新与广播
    storage.set(incoming, true);
    iLink.state = incoming;

    console.log(`[Restore] ★★★ 鉴权票据已成功导入还原！BotId: ${incoming.botId}, UserId: ${incoming.userId} ★★★`);

    // 若当前为主机角色且未开启长轮询，自动激活长轮询回路
    if (clusterManager.role === 'master' && !iLink.pollingActive) {
      console.log('[Restore] 当前节点为 Master，正在拉起微信消息长轮询...');
      iLink.startLongPolling();
    }

    // 立即向集群中所有对端备机并发推送，全集群恢复一致
    if (clusterManager.peerUrls.length > 0) {
      clusterManager.syncToPeers(incoming).catch(() => {});
    }

    res.json({
      success: true,
      message: '鉴权票据已成功导入还原并同步至全集群！',
      state: {
        botId: incoming.botId,
        userId: incoming.userId,
        hasContextToken: Boolean(incoming.contextToken),
        remainingQuota: iLink.remainingQuota,
        updatedAt: incoming.updatedAt
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 动态更新 Webhook 触发配置 (URL 与秘钥)
router.post('/admin/update-trigger-config', requireApiKey, (req, res) => {
  try {
    const { url, key } = req.body || {};
    saveTriggerConfig(url, key);
    res.json({
      success: true,
      message: 'Webhook 触发配置已成功更新并持久化',
      config: {
        url: config.triggerWebhookUrl,
        authConfigured: Boolean(config.triggerAuthKey)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. 双机高可用集群接口 (Blitz Cloud <-> Miget)
// 备节点接收 Master 推送的最新状态并落盘
router.post('/api/cluster/sync', requireApiKey, (req, res) => {
  const incoming = req.body;
  const senderRole = req.headers['x-cluster-sender-role'] || req.body?.__clusterRole;
  const senderPriority = parseInt(req.headers['x-cluster-sender-priority'] || req.body?.__clusterPriority || '0', 10);
  const ok = clusterManager.handleIncomingSync(incoming, senderRole, senderPriority);
  if (ok) {
    res.json({ success: true, message: '状态已同步落盘', timestamp: Date.now() });
  } else {
    res.status(400).json({ success: false, message: '无效的状态数据' });
  }
});

// 查询当前节点状态与全量数据（供备机启动或恢复时主动拉取）
router.get('/api/cluster/state', requireApiKey, (req, res) => {
  const currentState = storage.get() || iLink.state;
  res.json({
    success: true,
    role: clusterManager.role,
    priority: clusterManager.nodePriority,
    lastRoleChangeAt: clusterManager.lastRoleChangeAt,
    state: currentState,
    timestamp: Date.now()
  });
});

// 手动从对端主动拉取最新状态并安全落盘
router.post('/api/cluster/pull', requireApiKey, async (req, res) => {
  try {
    const targetPeer = req.query.peer || req.body?.peer || null;
    await clusterManager.pullStateFromPeers(targetPeer, true);
    res.json({
      success: true,
      message: '已向集群对端主动拉取并安全合并最新状态',
      state: storage.get() || iLink.state
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 获取集群节点状态
router.get('/api/cluster/status', requireApiKey, (req, res) => {
  res.json({
    success: true,
    ...clusterManager.getStatus()
  });
});

// 手动切换角色：晋升为 Master
router.post('/api/cluster/promote', requireApiKey, async (req, res) => {
  await clusterManager.promoteToMaster('管理端手动调用 API 晋升');
  res.json({ success: true, role: clusterManager.role, message: '已手动晋升为 Master' });
});

// 手动切换角色：降级为 Standby
router.post('/api/cluster/demote', requireApiKey, async (req, res) => {
  await clusterManager.demoteToStandby('管理端手动调用 API 降级');
  res.json({ success: true, role: clusterManager.role, message: '已手动降级为 Standby' });
});

// 5. 渲染管理页面（读取独立 html 模板，彻底规避模板转义与 Cloudflare 脚本语法错误）
function getAdminHtml() {
  const htmlTpl = fs.readFileSync(adminHtmlPath, 'utf-8');
  return htmlTpl
    .replaceAll('{{ROUTE_PREFIX}}', config.routePrefix)
    .replaceAll('{{BATCH_WINDOW_MS}}', String(config.batchWindowMs));
}

function handleRootPage(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getAdminHtml());
}

// 根路径返回 200 空白页面（用于云平台探活与保活唤醒，同时隐藏后台管理入口）
function handleBlankRoot(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send('');
}

// 根路径直通返回 200 空白页面（无需前缀）
app.get('/', handleBlankRoot);
router.get('/', handleBlankRoot);

// 只有在配置的 ROUTE_PREFIX 下的 /admin 才能访问网关管理页面
router.get('/admin', handleRootPage);

// 将所有核心功能统一挂载在配置的前缀下（默认 /coral）
app.use(config.routePrefix, router);

// 安全隔离：对于任何未带 /coral 前缀的访问，直接返回 404，不泄露任何服务特征
app.use((req, res) => {
  res.status(404).send('Not Found');
});

// 优雅停机
function handleShutdown(signal) {
  console.log(`[Server] 接收到 ${signal}，正在优雅关停集群与定时任务...`);
  clusterManager.stop();
  reminderService.stop();
  iLink.stopLongPolling();
  process.exit(0);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

// 服务启动（显式绑定 0.0.0.0 以适配 blitz.cloud 容器网络接入）
app.listen(config.port, '0.0.0.0', async () => {
  console.log(`[Server] ClawBot 微信通知网关服务已启动！`);
  console.log(`[Server] 访问前缀: ${config.routePrefix}`);
  console.log(`[Server] 根页面: http://127.0.0.1:${config.port}/`);
  console.log(`[Server] 健康检查: http://127.0.0.1:${config.port}/health`);
  console.log(`[Server] 管理后台: http://127.0.0.1:${config.port}${config.routePrefix}/admin`);
  console.log(`[Server] 推送接口: http://127.0.0.1:${config.port}${config.routePrefix}/api/send`);
  console.log(`[Server] 消息合批窗口: ${config.batchWindowMs}ms | 单会话硬配额: ${config.maxQuota}条`);

  // 初始化集群管理器（自动决策 Master/Standby 角色，仅主节点拉起长轮询与守护任务）
  await clusterManager.init();

  if (!iLink.state.botToken && clusterManager.role === 'master') {
    console.log(`[Server] 尚未绑定微信 Bot，请访问 http://127.0.0.1:${config.port}${config.routePrefix}/admin 扫码`);
  }
});
