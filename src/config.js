import path from 'path';
import fs from 'fs';
import os from 'os';

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

// 规范化并确保存储目录可用，若目标目录无写入权限（如非 root 容器环境）则自动回退至系统临时目录
function resolveDataDir() {
  const envDir = process.env.DATA_DIR;
  const initialDir = envDir
    ? (path.isAbsolute(envDir) ? envDir : path.resolve(process.cwd(), envDir))
    : path.resolve(process.cwd(), 'data');

  try {
    if (!fs.existsSync(initialDir)) {
      fs.mkdirSync(initialDir, { recursive: true });
    }
    // 测试是否具有写权限
    fs.accessSync(initialDir, fs.constants.W_OK);
    return initialDir;
  } catch (err) {
    console.warn(`[Config] 预设存储目录 (${initialDir}) 创建或写入权限不足 (${err.message})`);
    const fallbackDir = path.join(os.tmpdir(), 'clawbot-data');
    try {
      if (!fs.existsSync(fallbackDir)) {
        fs.mkdirSync(fallbackDir, { recursive: true });
      }
      fs.accessSync(fallbackDir, fs.constants.W_OK);
      console.warn(`[Config] 已自动切换至临时存储目录: ${fallbackDir} (提示: 临时目录重启后数据可能丢失，生产环境建议在平台挂载持久卷并配置 DATA_DIR)`);
      return fallbackDir;
    } catch (fallbackErr) {
      console.error('[Config] 临时存储目录亦无法使用:', fallbackErr.message);
      return initialDir;
    }
  }
}

// 解析集群对端列表（支持逗号分隔的 PEER_URLS 或单对端 PEER_URL）
function parsePeerUrls() {
  const raw = process.env.PEER_URLS || process.env.PEER_URL || '';
  return raw
    .split(',')
    .map(u => u.trim().replace(/\/+$/, ''))
    .filter(u => u.length > 0);
}

// 解析节点优先级权重（用于多节点故障转移选举，数值越高优先级越高）
function resolveNodePriority(role) {
  if (process.env.NODE_PRIORITY !== undefined && process.env.NODE_PRIORITY !== '') {
    const p = parseInt(process.env.NODE_PRIORITY, 10);
    if (!isNaN(p)) return p;
  }
  if (role === 'master') return 100;
  if (role === 'standby') return 50;
  return 50;
}

const parsedNodeRole = (process.env.NODE_ROLE || 'auto').trim().toLowerCase();
const parsedPeerUrls = parsePeerUrls();

export const config = {
  port: parseInt(process.env.PORT || '5000', 10),
  // 基础访问前缀：默认 /coral，所有外部接口和管理页面均在此前缀下
  routePrefix: normalizePrefix(process.env.ROUTE_PREFIX || '/coral'),
  // 外部调用 /api/send 和管理接口所需的固定密钥
  apiKey: process.env.API_KEY || 'default-secret-change-me',
  // 持久化存储路径（已包含自动回退保护）
  dataDir: resolveDataDir(),
  ilinkBaseUrl: process.env.ILINK_BASE_URL || 'https://ilinkai.weixin.qq.com',
  // 长轮询保活超时（毫秒），超期由看门狗主动重启轮询
  pollWatchdogTimeoutMs: parseInt(process.env.POLL_TIMEOUT_MS || '60000', 10),
  // 微信单会话硬限制配额（默认 10 条）
  maxQuota: parseInt(process.env.MAX_QUOTA || '10', 10),
  // 消息合并与合批等待窗口（毫秒，默认 2500ms，设为 0 则不合并即时发送）
  batchWindowMs: parseInt(process.env.BATCH_WINDOW_MS || '2500', 10),
  // 到期前半小时 Webhook 任务触发配置
  triggerWebhookUrl: process.env.TRIGGER_WEBHOOK_URL || 'http://job.coral.cc.cd/api/trigger/tasks/6',
  triggerAuthKey: process.env.TRIGGER_AUTH_KEY || '',
  // 每日远端冷备接口（主节点每日将最新凭证备份至此，以防全集群被清空）
  dailyBackupUrl: process.env.DAILY_BACKUP_URL || 'https://d1.coral001.de5.net/redis/set/clawbot',
  // 多机高可用集群配置 (如 Netrun.io <-> Miget <-> Blitz Cloud 跨云热备)
  peerUrls: parsedPeerUrls,
  peerUrl: parsedPeerUrls[0] || '', // 向后兼容旧代码引用
  nodeRole: parsedNodeRole, // 'master' | 'standby' | 'auto'
  nodePriority: resolveNodePriority(parsedNodeRole), // 默认：master=100, standby=50
  clusterHeartbeatIntervalMs: parseInt(process.env.CLUSTER_HEARTBEAT_INTERVAL_MS || '15000', 10)
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
