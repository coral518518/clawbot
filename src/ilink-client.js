import { config } from './config.js';
import { storage } from './storage.js';

export class ILinkClient {
  constructor() {
    this.state = storage.get() || {
      botToken: null,
      botId: null,
      userId: null,
      contextToken: null,
      syncBuf: ''
    };
    this.pollingActive = false;
    this.abortController = null;
    this.watchdogTimer = null;
    this.reconnectAttempts = 0;
  }

  get isReady() {
    return Boolean(this.state.botToken && this.state.contextToken);
  }

  get statusDescription() {
    if (!this.state.botToken) return 'UNPAIRED'; // 待扫码
    if (!this.state.contextToken) return 'WAITING_CONTEXT'; // 已扫码，等待微信端发任意消息激活
    return 'READY'; // 完全就绪
  }

  _getHeaders() {
    const randomUin = Buffer.from(String(Math.floor(Math.random() * 4294967295))).toString('base64');
    return {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'X-WECHAT-UIN': randomUin,
      'Authorization': `Bearer ${this.state.botToken}`
    };
  }

  // 1. 获取配对二维码
  async fetchQrCode() {
    const res = await fetch(`${config.ilinkBaseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`);
    if (!res.ok) throw new Error(`获取二维码失败: HTTP ${res.status}`);
    return await res.json();
  }

  // 2. 检查扫码状态
  async checkQrStatus(qrcode) {
    const res = await fetch(`${config.ilinkBaseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, {
      headers: { 'iLink-App-ClientVersion': '1' }
    });
    if (!res.ok) throw new Error(`检查扫码状态失败: HTTP ${res.status}`);
    const data = await res.json();

    if (data.status === 'confirmed') {
      this.state.botToken = data.bot_token;
      this.state.botId = data.ilink_bot_id;
      this.state.userId = data.ilink_user_id;
      this.state.syncBuf = '';
      this.state.contextToken = null;
      storage.set(this.state);
      this.startLongPolling();
    }
    return data;
  }

  // 3. 启动后台长轮询回路
  startLongPolling() {
    if (this.pollingActive || !this.state.botToken) return;
    this.pollingActive = true;
    console.log('[iLink] 启动消息长轮询回路...');
    this._runPollingLoop();
  }

  async _runPollingLoop() {
    while (this.pollingActive && this.state.botToken) {
      this._resetWatchdog();
      this.abortController = new AbortController();

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

        if (res.status === 401) {
          console.error('[iLink] Bot Token 已失效，停止轮询');
          this.pollingActive = false;
          break;
        }

        const data = await res.json();
        this.reconnectAttempts = 0; // 重置退避计数

        if (data.ret === 0) {
          if (data.get_updates_buf) {
            this.state.syncBuf = data.get_updates_buf;
          }
          if (data.msgs && data.msgs.length > 0) {
            for (const msg of data.msgs) {
              // 截获入站消息携带的最新 context_token
              if (msg.context_token) {
                this.state.contextToken = msg.context_token;
                storage.set(this.state);
                console.log('[iLink] 已更新 context_token，网关已处于 READY 状态');
              }
            }
          }
          storage.set(this.state);
        }
      } catch (err) {
        if (err.name === 'AbortError') {
          console.warn('[iLink] 轮询请求因超时被看门狗中断，正在重连...');
        } else {
          this.reconnectAttempts++;
          const backoff = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
          console.error(`[iLink] 轮询出错 (${err.message})，将在 ${backoff}ms 后重试`);
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }
  }

  _resetWatchdog() {
    clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      if (this.abortController) {
        this.abortController.abort(); // 终止假死的网络连接
      }
    }, config.pollWatchdogTimeoutMs);
  }

  // 4. 发送文本通知
  async sendMessage(text) {
    if (!this.state.botToken) {
      throw new Error('Bot 尚未配对，请先通过 /admin 扫码');
    }
    if (!this.state.contextToken) {
      throw new Error('尚未获取到 context_token，请先在微信向 Bot 发送任意文本激活会话');
    }

    const payload = {
      msg: {
        to_user_id: this.state.userId,
        message_type: 2,
        message_state: 2,
        context_token: this.state.contextToken,
        item_list: [{ type: 1, text_item: { text } }]
      }
    };

    const res = await fetch(`${config.ilinkBaseUrl}/ilink/bot/sendmessage`, {
      method: 'POST',
      headers: this._getHeaders(),
      body: JSON.stringify(payload)
    });

    const result = await res.json();
    if (result.ret !== 0) {
      throw new Error(`iLink 推送失败 [Code: ${result.ret}]: ${result.errmsg || '未知错误'}`);
    }
    return result;
  }

  logout() {
    this.pollingActive = false;
    if (this.abortController) this.abortController.abort();
    clearTimeout(this.watchdogTimer);
    this.state = { botToken: null, botId: null, userId: null, contextToken: null, syncBuf: '' };
    storage.clear();
  }
}

export const iLink = new ILinkClient();
