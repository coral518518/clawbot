import { config } from './config.js';
import { storage } from './storage.js';

// 消息合并与合批队列器
class MessageBatcher {
  constructor(senderFn) {
    this.senderFn = senderFn;
    this.queue = [];
    this.timer = null;
  }

  enqueue(item) {
    return new Promise((resolve, reject) => {
      this.queue.push({ ...item, resolve, reject, timestamp: Date.now() });

      // 如果未设置聚合窗口或为 0，则立即触发
      if (!config.batchWindowMs || config.batchWindowMs <= 0) {
        this.flush();
        return;
      }

      // 如果尚未启动等待定时器，则开启合批窗口
      if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), config.batchWindowMs);
      }
    });
  }

  async flush() {
    clearTimeout(this.timer);
    this.timer = null;

    if (this.queue.length === 0) return;

    const items = [...this.queue];
    this.queue = [];

    // 单条消息正常发送
    if (items.length === 1) {
      try {
        const result = await this.senderFn(items[0].text, items[0].title);
        items[0].resolve({ ...result, batched: false, count: 1 });
      } catch (err) {
        items[0].reject(err);
      }
      return;
    }

    // 多条消息聚合为单条合并通知（极大节省 10 条配额）
    try {
      const mergedTitle = `合并通知 (共 ${items.length} 条)`;
      const mergedBody = items.map((it, idx) => {
        const d = new Date(it.timestamp);
        const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
        const prefix = it.title ? `【${it.title}】` : '';
        return `${idx + 1}. ${prefix}${it.text} [${timeStr}]`;
      }).join('\n\n');

      console.log(`[Batcher] 聚合 ${items.length} 条高频消息，合并为 1 条微信通知发出，仅消耗 1 次配额`);
      const result = await this.senderFn(mergedBody, mergedTitle);

      for (const it of items) {
        it.resolve({ ...result, batched: true, count: items.length });
      }
    } catch (err) {
      for (const it of items) {
        it.reject(err);
      }
    }
  }
}

export class ILinkClient {
  constructor() {
    this.state = storage.get() || {
      botToken: null,
      botId: null,
      userId: null,
      contextToken: null,
      contextTokenUsedCount: 0,
      contextTokenCreatedAt: null,
      contextTokenExpireAt: null,
      invalidationReason: null,
      syncBuf: '',
      lastActiveTime: null
    };
    this.pollingActive = false;
    this.abortController = null;
    this.watchdogTimer = null;
    this.reconnectAttempts = 0;

    // 绑定合批处理器
    this.batcher = new MessageBatcher((text, title) => this._sendRawMessage(text, title));
  }

  // 剩余可用配额（满额通常为 10 条）
  get remainingQuota() {
    if (!this.state.contextToken) return 0;
    const used = Number(this.state.contextTokenUsedCount || 0);
    return Math.max(0, config.maxQuota - used);
  }

  // 剩余有效时间（毫秒）
  get remainingTimeMs() {
    if (!this.state.contextToken || !this.state.contextTokenExpireAt) return 0;
    return Math.max(0, Number(this.state.contextTokenExpireAt) - Date.now());
  }

  // 判断当前 context_token 是否有效（必须未过期且有配额）
  get isContextTokenValid() {
    if (!this.state.botToken || !this.state.contextToken) return false;
    if (this.remainingQuota <= 0) return false;
    if (this.remainingTimeMs <= 0) return false;
    return true;
  }

  get isReady() {
    return this.isContextTokenValid;
  }

  // 失效状态自动流转
  get statusDescription() {
    if (!this.state.botToken) return 'UNPAIRED'; // 待扫码
    if (!this.isContextTokenValid) return 'WAITING_CONTEXT'; // 配额用尽 / 超过24h / 待激活
    return 'READY'; // 完全就绪可用
  }

  // 获取失效详细原因
  get invalidationDetail() {
    if (!this.state.botToken) return '尚未扫码配对账号';
    if (!this.state.contextToken) return '已扫码，等待微信端发送任意消息以激活首次会话';
    if (this.remainingQuota <= 0) return `本轮 ${config.maxQuota} 条推送配额已耗尽，请在微信向 Bot 发送任意消息以重置`;
    if (this.remainingTimeMs <= 0) return '会话已超过 24 小时未互动过期，请在微信向 Bot 发送任意消息以重置';
    return this.state.invalidationReason || '正常可用';
  }

  _getHeaders() {
    const randomUin = Buffer.from(String(Math.floor(Math.random() * 4294967295))).toString('base64');
    const headers = {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'X-WECHAT-UIN': randomUin,
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': '1'
    };
    if (this.state.botToken) {
      headers['Authorization'] = `Bearer ${this.state.botToken}`;
    }
    return headers;
  }

  // 生成每条通知必带的保活状态签名：配额剩x条,有效x小时
  _buildFooter(remainingQuotaAfterThis) {
    const remainingMs = this.remainingTimeMs;
    let timeStr = '';
    if (remainingMs > 3600000) {
      const hours = (remainingMs / 3600000).toFixed(1);
      timeStr = `${hours} 小时`;
    } else {
      const minutes = Math.max(1, Math.round(remainingMs / 60000));
      timeStr = `${minutes} 分钟`;
    }

    // 临界状态（配额仅剩 <= 1 条，或有效时限 <= 2 小时）自动追加回复重置提醒
    if (remainingQuotaAfterThis <= 1 || remainingMs <= 2 * 3600000) {
      return `\n\n⚠️ 配额剩 ${remainingQuotaAfterThis} 条,有效 ${timeStr}(回复任意重置)`;
    } else {
      return `\n\n📌 配额剩 ${remainingQuotaAfterThis} 条,有效 ${timeStr}`;
    }
  }

  // 1. 获取配对二维码
  async fetchQrCode() {
    const res = await fetch(`${config.ilinkBaseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) {
      throw new Error(`获取二维码失败: HTTP ${res.status} ${res.statusText}`);
    }
    return await res.json();
  }

  // 2. 检查扫码状态
  async checkQrStatus(qrcode) {
    if (!qrcode) throw new Error('缺少 qrcode 参数');
    const res = await fetch(`${config.ilinkBaseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, {
      headers: {
        'Accept': 'application/json',
        'iLink-App-ClientVersion': '1'
      }
    });
    if (!res.ok) {
      throw new Error(`检查扫码状态失败: HTTP ${res.status} ${res.statusText}`);
    }
    const data = await res.json();

    if (data.status === 'confirmed') {
      this.state.botToken = data.bot_token;
      this.state.botId = data.ilink_bot_id;
      this.state.userId = data.ilink_user_id;
      this.state.syncBuf = '';
      this.state.contextToken = null;
      this.state.contextTokenUsedCount = 0;
      this.state.contextTokenCreatedAt = null;
      this.state.contextTokenExpireAt = null;
      this.state.invalidationReason = '已扫码完成，请在微信向 Bot 发送任意文本以获取激活 Token';
      this.state.lastActiveTime = Date.now();
      storage.set(this.state);
      console.log(`[iLink] 微信扫码授权成功！BotId: ${this.state.botId}, UserId: ${this.state.userId}`);

      this.restartLongPolling();
    }
    return data;
  }

  // 3. 启动后台长轮询保活回路
  startLongPolling() {
    if (this.pollingActive || !this.state.botToken) return;
    this.pollingActive = true;
    console.log('[iLink] 启动消息长轮询保活回路...');
    this._runPollingLoop();
  }

  restartLongPolling() {
    this.pollingActive = false;
    if (this.abortController) {
      try { this.abortController.abort(); } catch { }
    }
    clearTimeout(this.watchdogTimer);
    this.reconnectAttempts = 0;
    setTimeout(() => {
      this.startLongPolling();
    }, 200);
  }

  async _runPollingLoop() {
    while (this.pollingActive && this.state.botToken) {
      this.abortController = new AbortController();

      // 看门狗设置
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = setTimeout(() => {
        if (this.abortController) {
          this.abortController.abort();
        }
      }, config.pollWatchdogTimeoutMs);

      try {
        const res = await fetch(`${config.ilinkBaseUrl}/ilink/bot/getupdates`, {
          method: 'POST',
          headers: this._getHeaders(),
          body: JSON.stringify({
            get_updates_buf: this.state.syncBuf || '',
            base_info: { channel_version: '1.0.2' }
          }),
          signal: this.abortController.signal
        });

        clearTimeout(this.watchdogTimer);

        if (res.status === 401) {
          console.error('[iLink] Bot Token 已失效或被收回 (HTTP 401)，停止轮询');
          this.pollingActive = false;
          this.state.invalidationReason = 'Bot Token 已失效 (401)，需重新扫码';
          storage.set(this.state);
          break;
        }

        if (!res.ok) {
          throw new Error(`getupdates 响应异常: HTTP ${res.status}`);
        }

        const data = await res.json();
        this.reconnectAttempts = 0;

        if (data && data.ret !== 0) {
          console.warn(`[iLink] getupdates 响应异常状态: ret=${data.ret}, errmsg=${data.errmsg || '无'}`);
        }

        if (data && data.ret === 0) {
          let hasUpdated = false;
          if (data.get_updates_buf) {
            this.state.syncBuf = data.get_updates_buf;
            hasUpdated = true;
          }
          if (Array.isArray(data.msgs) && data.msgs.length > 0) {
            console.log(`[iLink] getupdates 接收到 ${data.msgs.length} 条入站事件/消息，正在处理...`);
            for (const msg of data.msgs) {
              // 兼容 direct 或嵌套的 context_token
              const token = msg.context_token || (msg.msg && msg.msg.context_token) || (msg.context && msg.context.context_token);
              if (token) {
                // 捕获用户在微信端的主动回复 -> 满血重置 10 条配额与 24 小时倒计时！
                this.state.contextToken = token;
                this.state.contextTokenUsedCount = 0; // 重置已用额度
                this.state.contextTokenCreatedAt = Date.now();
                this.state.contextTokenExpireAt = Date.now() + 24 * 3600 * 1000; // 重置 24 小时时效
                this.state.invalidationReason = null;
                hasUpdated = true;
                console.log('[iLink] 成功捕获微信回复 context_token！10条配额与24小时有效期已满血重置！网关自动恢复为 READY 状态！');
              }
              const sender = msg.from_user_id || (msg.msg && msg.msg.from_user_id);
              if (sender) {
                this.state.userId = sender;
                hasUpdated = true;
              }
            }
          }
          if (hasUpdated) {
            this.state.lastActiveTime = Date.now();
            storage.set(this.state);
          }
        }
      } catch (err) {
        clearTimeout(this.watchdogTimer);

        if (!this.pollingActive) break;

        if (err.name === 'AbortError') {
          console.warn('[iLink] 轮询请求超出保活时限，看门狗正在刷新长连接...');
        } else {
          this.reconnectAttempts++;
          const backoff = Math.min(1000 * Math.pow(2, Math.min(this.reconnectAttempts, 5)), 30000);
          console.error(`[iLink] 轮询遇到异常 (${err.message})，将在 ${backoff}ms 后重试 [第${this.reconnectAttempts}次]`);
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }
  }

  // 4. 底层发送文本通知（附带配额签名与状态流转）
  async _sendRawMessage(text, title = null) {
    if (!this.state.botToken) {
      throw new Error('Bot 尚未配对，请先通过 /coral/admin 扫码绑定');
    }

    // 检查 24 小时与配额限制
    if (!this.isContextTokenValid) {
      const reason = this.invalidationDetail;
      throw new Error(`当前无法推送 [${reason}]`);
    }

    let finalContent = String(text || '').trim();
    if (title && String(title).trim()) {
      finalContent = `【${String(title).trim()}】\n${finalContent}`;
    }

    if (!finalContent) {
      throw new Error('推送内容不能为空');
    }

    // 计算发完此条消息后，剩余的配额
    const remainingAfter = Math.max(0, this.remainingQuota - 1);

    // 自动追加保活状态签名：配额剩x条,有效x小时
    const footer = this._buildFooter(remainingAfter);
    finalContent += footer;

    // 限制单条消息最大长度
    if (finalContent.length > 4000) {
      finalContent = finalContent.slice(0, 3960) + '\n...(已截断)' + footer;
    }

    const payload = {
      msg: {
        to_user_id: this.state.userId,
        message_type: 2,
        message_state: 2,
        context_token: this.state.contextToken,
        item_list: [{ type: 1, text_item: { text: finalContent } }]
      }
    };

    const res = await fetch(`${config.ilinkBaseUrl}/ilink/bot/sendmessage`, {
      method: 'POST',
      headers: this._getHeaders(),
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      throw new Error(`iLink 网络通信失败: HTTP ${res.status} ${res.statusText}`);
    }

    const result = await res.json();

    if (result.ret !== 0) {
      const errMsg = result.errmsg || '未知错误';
      // 捕获微信服务端流控/配额耗尽/Token 失效（常见 ret: -2 或 -1）
      if (result.ret === -2 || result.ret === -1 || /context|token|expire|quota|limit|freq/i.test(errMsg)) {
        this.state.contextToken = null;
        this.state.invalidationReason = `微信接口拦截 [Code: ${result.ret}]: ${errMsg} (已自动流转为待激活，请在微信回复任意字符重置)`;
        storage.set(this.state);
        console.warn(`[iLink] 检测到配额用尽或 Token 失效，状态已自动流转为 WAITING_CONTEXT！`);
        throw new Error(`微信推送失败 [Code: ${result.ret}]: 会话凭据失效或配额超限，请在手机微信向 Bot 回复任意字符以满血激活 (${errMsg})`);
      }
      throw new Error(`iLink 推送失败 [Code: ${result.ret}]: ${errMsg}`);
    }

    // 发送成功，计数递增
    this.state.contextTokenUsedCount = (Number(this.state.contextTokenUsedCount) || 0) + 1;
    this.state.lastActiveTime = Date.now();

    // 如果正好达到 10 条上限，自动流转为 WAITING_CONTEXT
    if (this.state.contextTokenUsedCount >= config.maxQuota) {
      this.state.invalidationReason = `本轮 ${config.maxQuota} 条推送配额已全部用完，状态已自动流转为 WAITING_CONTEXT，请在微信回复任意内容恢复`;
      console.warn(`[iLink] 本轮 ${config.maxQuota} 条配额已用完，网关状态自动流转为 WAITING_CONTEXT`);
    }

    storage.set(this.state);
    return result;
  }

  // 对外推送统一入口：支持即时发送或智能合批
  async sendMessage(text, title = null, immediate = false) {
    if (immediate) {
      return await this._sendRawMessage(text, title);
    }
    return await this.batcher.enqueue({ text, title });
  }

  // 批量数组一次性合并推送
  async sendBatch(messages, batchTitle = null) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('消息列表不能为空');
    }

    const combinedTitle = batchTitle || `批量推送 (共 ${messages.length} 条)`;
    const combinedBody = messages.map((m, idx) => {
      const t = typeof m === 'string' ? m : (m.text || m.content || m.message || '');
      const subTitle = typeof m === 'object' && m.title ? `【${m.title}】` : '';
      return `${idx + 1}. ${subTitle}${t}`;
    }).join('\n\n');

    return await this._sendRawMessage(combinedBody, combinedTitle);
  }

  // 5. 解绑注销
  logout() {
    this.pollingActive = false;
    if (this.abortController) {
      try { this.abortController.abort(); } catch { }
    }
    clearTimeout(this.watchdogTimer);
    this.state = {
      botToken: null,
      botId: null,
      userId: null,
      contextToken: null,
      contextTokenUsedCount: 0,
      contextTokenCreatedAt: null,
      contextTokenExpireAt: null,
      invalidationReason: null,
      syncBuf: '',
      lastActiveTime: null
    };
    storage.clear();
    console.log('[iLink] 已清除本地登录与授权凭据');
  }
}

export const iLink = new ILinkClient();
