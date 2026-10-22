import express from 'express';
import { config } from './config.js';
import { iLink } from './ilink-client.js';
import { requireApiKey, apiLimiter } from './middleware.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/', apiLimiter);

// 1. 保活与外部健康检查（无鉴权，供 Uptime Kuma / blitz.cloud 探测）
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    gateway_state: iLink.statusDescription,
    timestamp: Date.now()
  });
});

// 2. 查看当前网关状态
app.get('/api/status', requireApiKey, (req, res) => {
  res.json({
    status: iLink.statusDescription,
    userId: iLink.state.userId,
    botId: iLink.state.botId,
    hasContextToken: Boolean(iLink.state.contextToken)
  });
});

// 3. 核心接口：发送通知
app.post('/api/send', requireApiKey, async (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: '字段 text 必须存在且为字符串' });
  }

  try {
    const result = await iLink.sendMessage(text);
    res.json({ success: true, result });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// 4. 配对管理前端页面（需在 URL 带上 ?api_key=xxx）
app.get('/admin', requireApiKey, (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>ClawBot 网关配对管理</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 40px; background: #f5f7fa; }
    .card { background: white; padding: 24px; border-radius: 8px; max-width: 480px; margin: 0 auto; box-shadow: 0 2px 10px rgba(0,0,0,0.05); }
    #qrcode { margin: 20px 0; text-align: center; min-height: 200px; display: flex; align-items: center; justify-content: center; }
    .status { padding: 10px; border-radius: 4px; margin-bottom: 16px; font-weight: bold; text-align: center; }
    .READY { background: #e6f7eb; color: #1e7e34; }
    .WAITING_CONTEXT { background: #fff3cd; color: #856404; }
    .UNPAIRED { background: #f8d7da; color: #721c24; }
    button { width: 100%; padding: 10px; background: #0070f3; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>微信 ClawBot 配对管理</h2>
    <div id="statusDiv" class="status">正在加载状态...</div>
    <div id="qrcode"></div>
    <div id="tip" style="font-size: 13px; color: #666; line-height: 1.5;"></div>
    <button id="actionBtn" onclick="initLogin()" style="margin-top: 15px;">获取绑定二维码</button>
  </div>
  <script>
    const apiKey = new URLSearchParams(window.location.search).get('api_key');
    let pollTimer = null;

    async function checkState() {
      const res = await fetch('/api/status', { headers: { 'X-API-Key': apiKey } });
      const data = await res.json();
      const div = document.getElementById('statusDiv');
      div.className = 'status ' + data.status;
      
      if (data.status === 'READY') {
        div.innerText = '● 状态就绪 (READY)';
        document.getElementById('tip').innerHTML = '服务已处于可用状态，可直接调用 <code>/api/send</code> 推送消息。';
        document.getElementById('qrcode').innerHTML = '';
      } else if (data.status === 'WAITING_CONTEXT') {
        div.innerText = '▲ 待激活会话 (WAITING_CONTEXT)';
        document.getElementById('tip').innerHTML = '<strong>已扫码授权！</strong> 请现在用手机微信打开该 Bot 聊天框，随意发送一句话（如“激活”）以捕获 ContextToken。';
        document.getElementById('qrcode').innerHTML = '';
      } else {
        div.innerText = '× 未绑定 (UNPAIRED)';
        document.getElementById('tip').innerText = '尚未绑定账号，请点击下方按钮扫码。';
      }
    }

    async function initLogin() {
      const btn = document.getElementById('actionBtn');
      btn.disabled = true;
      document.getElementById('qrcode').innerHTML = '正在拉取微信二维码...';
      
      const res = await fetch('/admin/get-qrcode?api_key=' + encodeURIComponent(apiKey));
      const data = await res.json();
      
      document.getElementById('qrcode').innerHTML = '<img src="' + data.qrcode_img_content + '" style="max-width: 220px;" />';
      
      clearInterval(pollTimer);
      pollTimer = setInterval(async () => {
        const sRes = await fetch('/admin/check-qrcode?qrcode=' + encodeURIComponent(data.qrcode) + '&api_key=' + encodeURIComponent(apiKey));
        const sData = await sRes.json();
        if (sData.status === 'confirmed') {
          clearInterval(pollTimer);
          btn.disabled = false;
          checkState();
        }
      }, 2000);
    }

    setInterval(checkState, 4000);
    checkState();
  </script>
</body>
</html>
  `);
});

// 管理端配套二维码交互路由
app.get('/admin/get-qrcode', requireApiKey, async (req, res) => {
  try {
    const data = await iLink.fetchQrCode();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/check-qrcode', requireApiKey, async (req, res) => {
  try {
    const { qrcode } = req.query;
    const data = await iLink.checkQrStatus(qrcode);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 优雅停机
process.on('SIGTERM', () => {
  console.log('接收到 SIGTERM，停止长轮询并准备关停...');
  iLink.pollingActive = false;
  if (iLink.abortController) iLink.abortController.abort();
  process.exit(0);
});

app.listen(config.port, () => {
  console.log(`[Server] 服务已启动，端口: ${config.port}`);
  if (iLink.state.botToken) {
    iLink.startLongPolling();
  }
});
