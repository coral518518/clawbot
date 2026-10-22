import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { iLink } from './ilink-client.js';
import { requireApiKey, apiLimiter } from './middleware.js';

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

// 针对 blitz.cloud 与 Cloudflare 边缘代理禁用动态接口缓存
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// 1. 保活与外部健康检查（无鉴权，便于外部监控如 Uptime Kuma 探测）
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    gateway_state: iLink.statusDescription,
    quota: {
      remaining: iLink.remainingQuota,
      used: iLink.state.contextTokenUsedCount || 0,
      total: config.maxQuota
    },
    expire_remaining_hours: (iLink.remainingTimeMs / 3600000).toFixed(1),
    timestamp: Date.now()
  });
});

// 2. 查看当前网关详细状态（包含配额与失效自动流转信息）
router.get('/api/status', requireApiKey, (req, res) => {
  res.json({
    success: true,
    status: iLink.statusDescription,
    userId: iLink.state.userId || null,
    botId: iLink.state.botId || null,
    hasContextToken: Boolean(iLink.state.contextToken),
    quota: {
      used: Number(iLink.state.contextTokenUsedCount) || 0,
      remaining: iLink.remainingQuota,
      total: config.maxQuota
    },
    expireAt: iLink.state.contextTokenExpireAt || null,
    expireRemainingHours: (iLink.remainingTimeMs / 3600000).toFixed(1),
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
    const { data, captured } = await iLink.fetchUpdatesOnce(reset);
    res.json({
      success: true,
      capturedToken: captured,
      status: iLink.statusDescription,
      hasContextToken: Boolean(iLink.state.contextToken),
      msgsCount: Array.isArray(data.msgs) ? data.msgs.length : 0,
      ret: data.ret,
      errmsg: data.errmsg || null
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

// 5. 渲染管理页面（读取独立 html 模板，彻底规避模板转义与 Cloudflare 脚本语法错误）
function getAdminHtml() {
  const htmlTpl = fs.readFileSync(adminHtmlPath, 'utf-8');
  return htmlTpl
    .replaceAll('{{ROUTE_PREFIX}}', config.routePrefix)
    .replaceAll('{{BATCH_WINDOW_MS}}', String(config.batchWindowMs));
}

router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getAdminHtml());
});

router.get('/admin', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getAdminHtml());
});

// 将所有核心功能统一挂载在配置的前缀下（默认 /coral）
app.use(config.routePrefix, router);

// 安全隔离：对于任何未带 /coral 前缀的访问，直接返回 404，不泄露任何服务特征
app.use((req, res) => {
  res.status(404).send('Not Found');
});

// 优雅停机
function handleShutdown(signal) {
  console.log(`[Server] 接收到 ${signal}，正在优雅关停长轮询并注销...`);
  iLink.pollingActive = false;
  if (iLink.abortController) {
    try { iLink.abortController.abort(); } catch {}
  }
  process.exit(0);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

// 服务启动（显式绑定 0.0.0.0 以适配 blitz.cloud 容器网络接入）
app.listen(config.port, '0.0.0.0', () => {
  console.log(`[Server] ClawBot 微信通知网关服务已启动！`);
  console.log(`[Server] 访问前缀: ${config.routePrefix}`);
  console.log(`[Server] 管理后台: http://127.0.0.1:${config.port}${config.routePrefix}/admin`);
  console.log(`[Server] 健康检查: http://127.0.0.1:${config.port}${config.routePrefix}/health`);
  console.log(`[Server] 推送接口: http://127.0.0.1:${config.port}${config.routePrefix}/api/send`);
  console.log(`[Server] 消息合批窗口: ${config.batchWindowMs}ms | 单会话硬配额: ${config.maxQuota}条`);

  if (iLink.state.botToken) {
    console.log('[Server] 发现已有授权记录，正在拉起后台长轮询保活回路...');
    iLink.startLongPolling();
  } else {
    console.log(`[Server] 尚未绑定微信 Bot，请访问 http://127.0.0.1:${config.port}${config.routePrefix}/admin 扫码`);
  }
});
