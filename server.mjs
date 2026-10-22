import express from 'express';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json());

const DATA_DIR = process.env.DATA_DIR || './data';
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const BASE_URL = 'https://ilinkai.weixin.qq.com';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let authData = fs.existsSync(AUTH_FILE) ? JSON.parse(fs.readFileSync(AUTH_FILE)) : null;

// 通用请求头生成函数
function getHeaders() {
  const uin = Buffer.from(String(Math.floor(Math.random() * 4294967295))).toString('base64');
  return {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': uin,
    'Authorization': `Bearer ${authData?.bot_token}`
  };
}

// 1. 登录二维码接口（可在浏览器直接打开扫码）
app.get('/login', async (req, res) => {
  const resp = await fetch(`${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`);
  const data = await resp.json();
  
  // 异步轮询扫码结果
  pollLogin(data.qrcode);
  
  res.send(`<h3>请使用手机微信扫描二维码绑定：</h3><img src="${data.qrcode_img_content}" />`);
});

async function pollLogin(qrcode) {
  let confirmed = false;
  while (!confirmed) {
    try {
      const resp = await fetch(`${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${qrcode}`, {
        headers: { 'iLink-App-ClientVersion': '1' }
      });
      const data = await resp.json();
      if (data.status === 'confirmed') {
        authData = {
          bot_token: data.bot_token,
          bot_id: data.ilink_bot_id,
          user_id: data.ilink_user_id,
          context_token: null,
          sync_buf: ''
        };
        fs.writeFileSync(AUTH_FILE, JSON.stringify(authData, null, 2));
        console.log('登录成功，已保存鉴权凭证！');
        confirmed = true;
        startLongPolling();
      } else if (data.status === 'expired') {
        console.log('二维码已过期');
        break;
      }
    } catch (e) {
      console.error('轮询出错，稍后重试', e);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}

// 2. 长轮询：维持连接 & 截获最新的 context_token
async function startLongPolling() {
  if (!authData?.bot_token) return;
  console.log('启动 iLink 消息长轮询...');

  while (true) {
    try {
      const resp = await fetch(`${BASE_URL}/ilink/bot/getupdates`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          get_updates_buf: authData.sync_buf || '',
          base_info: { channel_version: '1.0.2' }
        })
      });
      const data = await resp.json();
      if (data.ret === 0) {
        authData.sync_buf = data.get_updates_buf;
        if (data.msgs && data.msgs.length > 0) {
          for (const msg of data.msgs) {
            // 只要收到微信端发来的消息，立即捕获最新的 context_token
            if (msg.context_token) {
              authData.context_token = msg.context_token;
              fs.writeFileSync(AUTH_FILE, JSON.stringify(authData, null, 2));
              console.log('已刷新并缓存会话 context_token！');
            }
          }
        }
      }
    } catch (err) {
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// 3. 代码发消息 Webhook 接口
app.post('/send', async (req, res) => {
  const { text } = req.body;
  if (!authData?.bot_token || !authData?.context_token) {
    return res.status(400).json({ 
      error: 'Bot 未就绪或未捕获 context_token，请在手机微信向 Bot 随意发送一句话激活。' 
    });
  }

  const payload = {
    msg: {
      to_user_id: authData.user_id,
      message_type: 2,
      message_state: 2,
      context_token: authData.context_token,
      item_list: [{ type: 1, text_item: { text } }]
    }
  };

  const resp = await fetch(`${BASE_URL}/ilink/bot/sendmessage`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(payload)
  });
  const result = await resp.json();
  res.json(result);
});

// 健康检查接口（供外部保活 ping）
app.get('/health', (req, res) => res.send('OK'));

app.listen(8080, () => {
  console.log('服务监听在 8080 端口');
  if (authData?.bot_token) startLongPolling();
});
