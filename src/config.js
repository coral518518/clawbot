import path from 'path';

export const config = {
  port: parseInt(process.env.PORT || '8080', 10),
  // 外部调用 /api/send 和管理接口所需的固定密钥
  apiKey: process.env.API_KEY || 'default-secret-change-me',
  // 持久化存储路径，建议在 blitz.cloud 挂载至 Volume
  dataDir: process.env.DATA_DIR || path.resolve(process.cwd(), 'data'),
  ilinkBaseUrl: process.env.ILINK_BASE_URL || 'https://ilinkai.weixin.qq.com',
  // 长轮询保活超时（毫秒），超期由看门狗主动重启轮询
  pollWatchdogTimeoutMs: 60 * 1000
};

if (config.apiKey === 'default-secret-change-me' && process.env.NODE_ENV === 'production') {
  console.warn('[SECURITY WARNING] 正在使用默认 API_KEY，请在环境变量中设置独立安全密钥！');
}
