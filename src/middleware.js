import rateLimit from 'express-rate-limit';
import { config } from './config.js';

// API 速率限制（防止外部爆破或频繁调用）
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120, // 每分钟最多 120 次
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后重试' }
});

// 固定 API Key 鉴权中间件（支持 Header 或 Bearer）
export function requireApiKey(req, res, next) {
  const headerKey = req.headers['x-api-key'];
  const authHeader = req.headers['authorization'];
  let bearerKey = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    bearerKey = authHeader.substring(7).trim();
  }

  const token = headerKey || bearerKey || req.query.api_key;

  if (!token || token !== config.apiKey) {
    return res.status(401).json({ error: '未授权：无效或缺失 API Key' });
  }
  next();
}
