import path from 'path';
import fs from 'fs';

// 尝试加载根目录下的 .env 文件（Node.js >= 20.6.0 原生支持）
try {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
  }
} catch {
  // 忽略 .env 文件不存在或解析错误
}

// 规范化路由前缀（确保以 / 开头，且结尾不带 /）
function normalizePrefix(prefix) {
  if (!prefix) return '/coral';
  let p = prefix.trim();
  if (!p.startsWith('/')) p = '/' + p;
  if (p.endsWith('/') && p.length > 1) p = p.slice(0, -1);
  return p;
}

export const config = {
  port: parseInt(process.env.PORT || '8080', 10),
  // 基础访问前缀：默认 /coral，所有外部接口和管理页面均在此前缀下
  routePrefix: normalizePrefix(process.env.ROUTE_PREFIX || '/coral'),
  // 外部调用 /api/send 和管理接口所需的固定密钥
  apiKey: process.env.API_KEY || 'default-secret-change-me',
  // 持久化存储路径
  dataDir: process.env.DATA_DIR || path.resolve(process.cwd(), 'data'),
  ilinkBaseUrl: process.env.ILINK_BASE_URL || 'https://ilinkai.weixin.qq.com',
  // 长轮询保活超时（毫秒），超期由看门狗主动重启轮询
  pollWatchdogTimeoutMs: parseInt(process.env.POLL_TIMEOUT_MS || '60000', 10),
  // 微信单会话硬限制配额（默认 10 条）
  maxQuota: parseInt(process.env.MAX_QUOTA || '10', 10),
  // 消息合并与合批等待窗口（毫秒，默认 2500ms，设为 0 则不合并即时发送）
  batchWindowMs: parseInt(process.env.BATCH_WINDOW_MS || '2500', 10),
  // 到期前半小时 Webhook 任务触发配置
  triggerWebhookUrl: process.env.TRIGGER_WEBHOOK_URL || 'http://job.coral.cc.cd/api/trigger/tasks/5',
  triggerAuthKey: process.env.TRIGGER_AUTH_KEY || ''
};

// 尝试从持久化配置文件加载保存的 trigger 配置
function loadSavedTriggerConfig() {
  try {
    const triggerConfigFile = path.resolve(config.dataDir, 'trigger_config.json');
    if (fs.existsSync(triggerConfigFile)) {
      const data = JSON.parse(fs.readFileSync(triggerConfigFile, 'utf-8'));
      if (data.triggerWebhookUrl) config.triggerWebhookUrl = data.triggerWebhookUrl;
      if (data.triggerAuthKey !== undefined) config.triggerAuthKey = data.triggerAuthKey;
    }
  } catch (err) {
    console.error('[Config] 读取 trigger_config.json 失败:', err.message);
  }
}

loadSavedTriggerConfig();

export function saveTriggerConfig(url, key) {
  if (url) config.triggerWebhookUrl = url.trim();
  if (key !== undefined) config.triggerAuthKey = key.trim();
  try {
    if (!fs.existsSync(config.dataDir)) {
      fs.mkdirSync(config.dataDir, { recursive: true });
    }
    const triggerConfigFile = path.resolve(config.dataDir, 'trigger_config.json');
    fs.writeFileSync(triggerConfigFile, JSON.stringify({
      triggerWebhookUrl: config.triggerWebhookUrl,
      triggerAuthKey: config.triggerAuthKey
    }, null, 2), 'utf-8');
    console.log('[Config] 已成功持久化 trigger_config.json 配置');
  } catch (err) {
    console.error('[Config] 保存 trigger_config.json 失败:', err.message);
  }
}

if (config.apiKey === 'default-secret-change-me' && process.env.NODE_ENV === 'production') {
  console.warn('[SECURITY WARNING] 正在使用默认 API_KEY，请在环境变量或 .env 中设置独立高强度密钥！');
}
