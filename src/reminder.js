import { storage } from './storage.js';
import { config } from './config.js';

// 将时间戳格式化为北京时间字符串: YYYY-MM-DD HH:mm:ss
export function formatBeijingTime(timestamp) {
  if (!timestamp) return '无';
  // 北京时间为 UTC+8，中国无夏令时，固定偏移 8 小时
  const d = new Date(Number(timestamp) + 8 * 3600 * 1000);
  const Y = d.getUTCFullYear();
  const M = String(d.getUTCMonth() + 1).padStart(2, '0');
  const D = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${Y}-${M}-${D} ${h}:${m}:${s}`;
}

/**
 * 格式化外部 Webhook 的 Authorization 头部凭据：
 * 头部格式必须为 Authorization: Bearer <token>
 * 用户配置填写的秘钥系统会自动在前面补齐 chb_ 前缀 (例如 my_key -> Bearer chb_my_key)
 */
export function formatTriggerAuthHeader(rawKey) {
  if (!rawKey || typeof rawKey !== 'string') return '';
  let token = rawKey.trim();
  if (token.startsWith('Bearer ')) {
    token = token.slice(7).trim();
  }
  if (!token.startsWith('chb_')) {
    token = `chb_${token}`;
  }
  return `Bearer ${token}`;
}

/**
 * 根据 Token 到期时间计算计划微信提醒时间（全部按北京时间 UTC+8 计算）：
 * 1. 若 Token 在 22:00 到第二天 12:00 过期，则在 22:00 发送提醒；
 *    - 00:00:00 ~ 12:00:00 到期：属于前一天 22:00 ~ 当天 12:00 区间，提醒时间为【前一天 22:00】；
 *    - 22:00:01 ~ 23:59:59 到期：属于当天 22:00 ~ 次日 12:00 区间，提醒时间为【当天 22:00】；
 * 2. 其它时间（12:00:01 ~ 22:00:00）：提前 2 小时提醒我回复。
 */
export function calculateReminderTime(expireTimestamp) {
  if (!expireTimestamp) return null;
  const exp = Number(expireTimestamp);

  // 转换为北京时间
  const d = new Date(exp + 8 * 3600 * 1000);
  const Y = d.getUTCFullYear();
  const M = d.getUTCMonth();
  const D = d.getUTCDate();
  const H = d.getUTCHours();
  const Min = d.getUTCMinutes();
  const Sec = d.getUTCSeconds();

  const timeInMinutes = H * 60 + Min + Sec / 60;

  let reminderTimestamp;
  if (timeInMinutes <= 720) {
    // 北京时间 00:00:00 ~ 12:00:00 到期 -> 提醒时间为前一天 22:00:00
    // 当天 00:00:00 北京时间对应 UTC 为 Date.UTC(Y, M, D, -8, 0, 0)
    // 减去 2 小时即为前一天 22:00:00 北京时间
    const dayStartUtc = Date.UTC(Y, M, D, -8, 0, 0);
    reminderTimestamp = dayStartUtc - 2 * 3600 * 1000;
  } else if (timeInMinutes > 1320) {
    // 北京时间 22:00:01 ~ 23:59:59 到期 -> 提醒时间为当天 22:00:00
    const dayStartUtc = Date.UTC(Y, M, D, -8, 0, 0);
    reminderTimestamp = dayStartUtc + 22 * 3600 * 1000;
  } else {
    // 其它时间（12:00:01 ~ 22:00:00）-> 提前 2 小时提醒
    reminderTimestamp = exp - 2 * 3600 * 1000;
  }

  // 安全兜底：提醒时间必须在过期时间之前（至少提前 1 分钟）
  if (reminderTimestamp >= exp) {
    reminderTimestamp = exp - 60 * 1000;
  }

  return reminderTimestamp;
}

export class TokenReminderService {
  constructor() {
    this.ilink = null;
    this.timer = null;
    this.checkIntervalMs = 30000; // 每 30 秒轮询检查一次
    this.lastFailureTime = 0;
    this.lastWebhookFailureTime = 0;
  }

  start(ilinkClient) {
    this.ilink = ilinkClient;
    if (this.timer) {
      clearInterval(this.timer);
    }

    console.log('[Reminder] 微信 Token 到期定时守护任务已启动 (轮询周期: 30s, 时区: 北京时间 UTC+8)');
    console.log('[Reminder] 1. 微信消息提醒: 22:00 ~ 次日 12:00 到期则 22:00 提醒；其它时间提前 2 小时提醒');
    console.log(`[Reminder] 2. 外部 Webhook 触发: 到期前半小时 POST -> ${config.triggerWebhookUrl}`);

    // 启动定期检查
    this.timer = setInterval(() => {
      // 1. 微信到期前提醒
      this.checkAndTrigger(false).catch((err) => {
        console.error('[Reminder] 定时检查微信提醒异常:', err.message);
      });
      // 2. 到期前半小时外部 Webhook 任务触发
      this.checkAndTriggerWebhook(false).catch((err) => {
        console.error('[Reminder] 定时检查到期 Webhook 异常:', err.message);
      });
    }, this.checkIntervalMs);

    // 服务拉起后稍作延迟即执行首次检查（避开启动瞬态）
    setTimeout(() => {
      this.checkAndTrigger(false).catch(() => { });
      this.checkAndTriggerWebhook(false).catch(() => { });
    }, 3000);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[Reminder] 定时任务守护已停止');
    }
  }

  // 获取当前状态信息供接口与管理后台使用
  getStatus() {
    if (!this.ilink) {
      return { enabled: false, message: '未初始化' };
    }

    const state = this.ilink.state || {};
    const hasToken = Boolean(state.contextToken && state.contextTokenExpireAt);
    const expireAt = hasToken ? Number(state.contextTokenExpireAt) : null;
    const isExpired = expireAt ? Date.now() >= expireAt : true;

    // 微信提醒计算
    let nextReminderAt = null;
    if (hasToken && !isExpired) {
      nextReminderAt = calculateReminderTime(expireAt);
    }
    const isSent = Boolean(
      state.contextToken &&
      state.reminderSentToken &&
      state.reminderSentToken === state.contextToken
    );

    // 到期前半小时 Webhook 计算 (提前 30 分钟)
    const webhookTriggerAt = expireAt ? (expireAt - 30 * 60 * 1000) : null;
    const isWebhookTriggered = Boolean(
      state.contextToken &&
      state.webhookTriggeredToken &&
      state.webhookTriggeredToken === state.contextToken
    );

    const authHeader = formatTriggerAuthHeader(config.triggerAuthKey);

    return {
      enabled: true,
      rule: '北京时间 22:00~次日12:00 到期则 22:00 提醒，其它时间提前 2 小时提醒',
      hasActiveToken: hasToken && !isExpired,
      tokenExpireAt: expireAt,
      tokenExpireAtBeijing: formatBeijingTime(expireAt),
      nextReminderAt,
      nextReminderAtBeijing: formatBeijingTime(nextReminderAt),
      isSent,
      sentAt: isSent ? state.reminderSentAt : null,
      sentAtBeijing: isSent ? formatBeijingTime(state.reminderSentAt) : null,
      remainingQuota: this.ilink.remainingQuota,
      statusDescription: !hasToken
        ? '未获取 Token'
        : isExpired
          ? 'Token 已过期'
          : isSent
            ? '已发送提醒 (等待微信回复刷新)'
            : nextReminderAt
              ? `计划于 ${formatBeijingTime(nextReminderAt)} 提醒`
              : '待定',

      // 到期前半小时触发 Webhook 状态
      webhook: {
        url: config.triggerWebhookUrl,
        authConfigured: Boolean(config.triggerAuthKey),
        authKeyConfigured: Boolean(config.triggerAuthKey),
        maskedAuthHeader: authHeader ? 'Bearer chb_***' : '未配置',
        triggerAt: webhookTriggerAt,
        triggerAtBeijing: formatBeijingTime(webhookTriggerAt),
        isTriggered: isWebhookTriggered,
        triggeredAt: isWebhookTriggered ? state.webhookTriggeredAt : null,
        triggeredAtBeijing: isWebhookTriggered ? formatBeijingTime(state.webhookTriggeredAt) : null,
        lastStatus: state.webhookLastStatus || null,
        lastError: state.webhookLastError || null,
        statusDescription: !hasToken
          ? '未获取 Token'
          : isExpired
            ? 'Token 已过期'
            : isWebhookTriggered
              ? `已于 ${formatBeijingTime(state.webhookTriggeredAt)} 触发成功 (HTTP ${state.webhookLastStatus || 200})`
              : webhookTriggerAt
                ? `计划于 ${formatBeijingTime(webhookTriggerAt)} 自动触发 (到期前半小时)`
                : '待定'
      }
    };
  }

  // 构造提醒消息文本
  buildReminderMessage(expireAt) {
    const expireTimeStr = formatBeijingTime(expireAt);
    return {
      title: 'ClawBot 会话保活提醒',
      text: [
        '⚠️ 微信 Token 即将过期提醒：',
        '',
        `您的当前会话预计将于 【${expireTimeStr}】 (北京时间) 到期。`,
        '为保障通知网关推送服务不中断，请在微信向本机器人回复任意内容（如回复“1”或“收到”），即可自动满血刷新 24 小时有效期与推送配额。',
        '',
        '（若本周期内已完成回复刷新，请忽略此条通知）'
      ].join('\n')
    };
  }

  /**
   * 1. 检查并在符合条件时触发发送微信提醒
   * @param {boolean} force - 是否强制发送（用于后台测试）
   */
  async checkAndTrigger(force = false) {
    if (!this.ilink) return false;

    const state = this.ilink.state;
    if (!state.botToken) {
      if (force) throw new Error('Bot 尚未扫码配对，无法发送');
      return false;
    }

    if (!state.contextToken || !state.contextTokenExpireAt) {
      if (force) throw new Error('尚未获取到有效的 context_token，请先在微信向 Bot 发送任意消息');
      return false;
    }

    const now = Date.now();
    const expireAt = Number(state.contextTokenExpireAt);

    // 如果 Token 已过期，微信接口已无法外发消息
    if (now >= expireAt) {
      if (force) throw new Error('会话 Token 已经过期，请先在微信回复任意字符以满血激活');
      return false;
    }

    // 检查是否已经为当前 Token 发送过提醒（避免频繁轰炸消耗额度）
    const alreadySent = Boolean(
      state.reminderSentToken && state.reminderSentToken === state.contextToken
    );
    if (!force && alreadySent) {
      return false;
    }

    // 计算计划提醒时间
    const reminderTime = calculateReminderTime(expireAt);
    if (!reminderTime) return false;

    // 非强制模式下，检查是否到了提醒时间
    if (!force && now < reminderTime) {
      return false;
    }

    // 检查是否有可用配额
    if (this.ilink.remainingQuota <= 0) {
      console.warn('[Reminder] 达到微信提醒时间，但本轮推送配额已耗尽，无法自动外发提醒，等待用户在微信回复重置');
      return false;
    }

    // 避免网络异常时短时间内频繁重试（重试冷却 2 分钟）
    if (!force && this.lastFailureTime && now - this.lastFailureTime < 120000) {
      return false;
    }

    const { title, text } = this.buildReminderMessage(expireAt);
    const expireStr = formatBeijingTime(expireAt);
    const planStr = formatBeijingTime(reminderTime);

    console.log(`[Reminder] 触发 Token 到期微信提醒任务！Token 到期时间: ${expireStr} | 计划提醒时间: ${planStr} | 强制测试: ${force}`);

    try {
      // immediate: true 跳过合批队列，立即发出
      const result = await this.ilink.sendMessage(text, title, true);

      // 发送成功，记录当前 Token 的发送状态并持久化
      state.reminderSentToken = state.contextToken;
      state.reminderSentAt = Date.now();
      storage.set(state);

      console.log(`[Reminder] ★★★ Token 到期提醒已成功发送至微信！等待用户回复刷新 (剩余配额: ${this.ilink.remainingQuota}) ★★★`);
      return { success: true, result };
    } catch (err) {
      this.lastFailureTime = Date.now();
      console.error(`[Reminder] 发送 Token 到期提醒失败:`, err.message);
      if (force) throw err;
      return false;
    }
  }

  /**
   * 2. 检查并在 Token 到期前半小时执行一次 POST Webhook 请求
   *    URL: http://job.coral.cc.cd/api/trigger/tasks/6
   *    头部: Authorization: Bearer chb_<key>
   * @param {boolean} force - 是否强制触发（用于后台测试）
   */
  async checkAndTriggerWebhook(force = false) {
    if (!this.ilink) return false;

    const state = this.ilink.state;

    if (!state.contextToken || !state.contextTokenExpireAt) {
      if (force) throw new Error('尚未获取到有效的 context_token，请先激活会话后再测试');
      return false;
    }

    const now = Date.now();
    const expireAt = Number(state.contextTokenExpireAt);

    if (now >= expireAt) {
      if (force) throw new Error('会话 Token 已经过期，无法触发任务');
      return false;
    }

    // 到期前半小时（30 分钟）
    const advanceMs = 30 * 60 * 1000;
    const triggerTime = expireAt - advanceMs;

    // 检查是否已经为当前 Token 执行过该 Webhook 任务
    const alreadyTriggered = Boolean(
      state.webhookTriggeredToken && state.webhookTriggeredToken === state.contextToken
    );
    if (!force && alreadyTriggered) {
      return false;
    }

    // 非强制模式下，检查当前时间是否达到到期前半小时
    if (!force && now < triggerTime) {
      return false;
    }

    // 避免目标服务故障时短时间内频繁重试（重试冷却 2 分钟）
    if (!force && this.lastWebhookFailureTime && now - this.lastWebhookFailureTime < 120000) {
      return false;
    }

    const targetUrl = config.triggerWebhookUrl || 'http://job.coral.cc.cd/api/trigger/tasks/6';
    const authHeader = formatTriggerAuthHeader(config.triggerAuthKey);

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'ClawBot-Notifier/1.0.0'
    };
    if (authHeader) {
      headers['Authorization'] = authHeader;
    }

    const remainingMinutes = Math.max(0, Math.round((expireAt - now) / 60000));
    const payload = {
      source: 'clawbot',
      event: 'token_expiring_soon',
      tokenExpireAt: expireAt,
      tokenExpireAtBeijing: formatBeijingTime(expireAt),
      remainingMinutes,
      timestamp: now
    };

    console.log(`[Webhook] 触发 Token 到期前半小时 POST 请求 -> ${targetUrl} | 剩余时间: ${remainingMinutes}分钟 | Authorization: ${authHeader ? (authHeader.slice(0, 16) + '***') : '无'} | 强制测试: ${force}`);

    try {
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });

      const resText = await res.text();
      let resData;
      try { resData = JSON.parse(resText); } catch { resData = resText; }

      if (!res.ok) {
        this.lastWebhookFailureTime = Date.now();
        state.webhookLastStatus = res.status;
        const errDetail = typeof resData === 'object' && resData.error ? resData.error : resText;
        state.webhookLastError = `HTTP ${res.status}: ${errDetail}`;
        storage.set(state);

        console.error(`[Webhook] 外部任务执行返回错误状态 [HTTP ${res.status}]:`, errDetail);
        if (force) {
          throw new Error(`HTTP ${res.status}: ${errDetail}`);
        }
        return false;
      }

      // 执行成功，标记当前 Token 已触发并持久化
      state.webhookTriggeredToken = state.contextToken;
      state.webhookTriggeredAt = Date.now();
      state.webhookLastStatus = res.status;
      state.webhookLastError = null;
      storage.set(state);

      console.log(`[Webhook] ★★★ Token 到期前半小时任务已成功执行！HTTP ${res.status} ★★★`);
      return { success: true, status: res.status, data: resData };
    } catch (err) {
      this.lastWebhookFailureTime = Date.now();
      state.webhookLastError = err.message;
      storage.set(state);
      console.error(`[Webhook] 触发外部任务网络通信异常:`, err.message);
      if (force) throw err;
      return false;
    }
  }
}

export const reminderService = new TokenReminderService();
