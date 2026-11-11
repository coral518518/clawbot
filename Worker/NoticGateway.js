import { withPrismAuth } from "./prism-auth.js";

/**
 * ==============================================================================
 * Cloudflare Worker: Telegram 协议全兼容通知中转网关 (Notice Gateway)
 * ==============================================================================
 * 
 * 核心特性：
 * 1. 【100% 兼容 Telegram Bot API 规范】：
 *    - 支持路径：/bot<token>/sendMessage、/sendMessage、/bot<token>/sendPhoto、/sendPhoto、/bot<token>/getMe、/getMe
 *    - 支持请求体：application/json、application/x-www-form-urlencoded、multipart/form-data (支持本地图片二进制上传与网络图片直链)
 *    - 支持 Telegram 原生图文合一 (sendPhoto + caption / photo)
 *    - 响应体格式与 Telegram 官方完全一致 ({"ok": true, "result": {...}})，无缝对接各类监控报警脚本
 * 2. 【多渠道支持】：
 *    - Telegram (TG，支持纯文本与图文合一消息)
 *    - Discord (Webhook，支持文字与图片附件/Embed)
 *    - 飞书 (Feishu Webhook，支持可选签名校验与图文)
 *    - 钉钉 (DingTalk Webhook，支持可选加签 secret 与 Markdown 图文)
 *    - WxPusher (微信推送服务，支持 UID / Topic 路由与图片渲染)
 * 3. 【灵活渠道路由与故障容灾降级 (Fallback)】：
 *    - 主通道支持单发或多通道广播 (如: "wxpusher" 或 "tg,wxpusher")
 *    - 失败自动触发备用降级通道 (如主通道挂了自动转飞书/钉钉/WxPusher)
 *    - 支持通过 URL 参数 (?channel=...&fallback=...)、Header、或请求体临时覆盖路由
 * 4. 【安全分层防护体系】：
 *    - 网页控制台 (GET /)：强制通过 Prism OAuth 登录鉴权，未经授权无法查看或操作控制台；
 *    - 通知发信接口 (POST /*)：免登放行，由独立的 TG_BOT_TOKEN 与 TG_CHAT_ID 比对鉴权。
 * 
 * 配置优先级：URL参数 / 请求头 > Worker 环境变量 (env) > 脚本默认配置 (DEFAULT_CONFIG)
 * ==============================================================================
 */

// 默认配置（可在此直接填写；推荐在 Cloudflare 环境变量中配置单个 CONFIG_JSON 整体覆盖；亦支持配置同名单独变量）
const DEFAULT_CONFIG = {
    // 默认主发送渠道（多个用英文逗号分隔，可选：tg, discord, feishu, dingtalk, wxpusher, coral, coral2）
    DEFAULT_CHANNELS: "wxpusher",

    // 默认失败降级渠道（当主渠道全部失败后触发，留空则不降级）
    FALLBACK_CHANNELS: "tg",

    // 降级通知时是否在内容前追加告警说明
    APPEND_FALLBACK_NOTICE: true,

    // --- Coral 自定义通知渠道配置 (实例 1) ---
    // 接口规范: POST <CORAL_WEBHOOK_URL>/coral/api/send
    // Headers: x-api-key: <CORAL_API_KEY>
    // Body: {"title":"...","text":"...","immediate":false}
    CORAL_WEBHOOK_URL: "",          // Coral Webhook 地址 (例如: https://your-server.com/coral/api/send 或基地址)
    CORAL_API_KEY: "",              // 接口鉴权密钥 (通过 Header: x-api-key 传递)
    CORAL_DEFAULT_TITLE: "通知提醒", // 默认标题 (若未单独指定 title 且无法从正文提取时使用)
    CORAL_IMMEDIATE: false,         // 是否即时加急 (默认 false)

    // --- Coral 2 自定义通知渠道配置 (实例 2，共用同一套底层接口逻辑) ---
    CORAL2_WEBHOOK_URL: "",         // Coral 2 Webhook 地址 (例如: https://your-server-2.com/coral/api/send 或基地址)
    CORAL2_API_KEY: "",             // 接口鉴权密钥 (通过 Header: x-api-key 传递)
    CORAL2_DEFAULT_TITLE: "通知提醒",// 默认标题
    CORAL2_IMMEDIATE: false,        // 是否即时加急 (默认 false)

    // --- 接口鉴权秘钥 & Telegram 配置 ---
    // 若填写则开启接口鉴权：客户端请求必须携带匹配的 token 与 chat_id，否则拒绝访问 (401)
    // （当主/备渠道包含 Telegram 时，此两项亦同时作为向 TG 官方推送的凭证）
    TG_BOT_TOKEN: "",                // 接口鉴权 Token（客户端通过路径 /bot<token>/、Header 或参数传递）
    TG_CHAT_ID: "",                  // 接口鉴权 Chat ID（客户端通过 chat_id 传递）
    TG_API_HOST: "api.telegram.org", // 支持自定义 TG 反代域名

    // --- Discord 配置 ---
    DISCORD_WEBHOOK_URL: "",         // 完整的 Discord Webhook 地址

    // --- 飞书 (Feishu) 配置 ---
    FEISHU_WEBHOOK_URL: "",          // 飞书机器人 Webhook 地址
    FEISHU_SECRET: "",               // 飞书安全设置中的加签密钥（若未开启加签可留空）

    // --- 钉钉 (DingTalk) 配置 ---
    DINGTALK_WEBHOOK_URL: "",        // 钉钉机器人 Webhook 地址 (包含 access_token)
    DINGTALK_SECRET: "",             // 钉钉机器人安全设置中的加签 secret（若未开启可留空）

    // --- WxPusher 配置 ---
    WXPUSHER_APP_TOKEN: "",          // WxPusher 的 appToken
    WXPUSHER_UIDS: "",               // 默认推送 UID（多个用英文逗号分隔，例如: UID_xxxx,UID_yyyy）
    WXPUSHER_TOPIC_IDS: "",          // 默认推送 Topic ID（多个用逗号隔开，可选）
};

/**
 * 包装 Prism 鉴权与业务路由分发
 * 规则：除了通知发送接口（/sendMessage 或所有 POST 发信操作）免登外，其余访问（如控制台 GET /）必须通过 Prism OAuth 鉴权
 */
const prismAuthHandler = withPrismAuth(handleBusiness, {
    isPublic(url, request) {
        // 1. 绝对不能放行鉴权内部核心路由：
        // /auth/callback（登录成功跳回换 Token）和 /__logout（主动登出清理 Cookie）
        if (url.pathname === "/auth/callback" || url.pathname === "/__logout") {
            return false;
        }

        // 2. 跨域预检请求直接放行
        if (request.method === "OPTIONS") {
            return true;
        }

        // 3. 所有消息通知发送接口免登放行（接口自带 TG_BOT_TOKEN / TG_CHAT_ID 独立鉴权比对）
        // 包括 POST 请求，或路径包含 sendMessage、sendPhoto、/bot... 的发信接口
        if (
            request.method === "POST" ||
            url.pathname.endsWith("/sendMessage") ||
            url.pathname.endsWith("/sendmessage") ||
            url.pathname.endsWith("/sendPhoto") ||
            url.pathname.endsWith("/sendphoto") ||
            url.pathname.includes("/bot")
        ) {
            return true;
        }

        // 4. 静态公共资源放行
        if (url.pathname === "/favicon.ico") {
            return true;
        }

        // 5. 其余所有访问（特别是浏览器 GET / 访问控制台面板）必须强制通过 Prism 鉴权登录
        return false;
    }
});

export default {
    /**
     * Worker 主入口
     */
    async fetch(request, env, ctx) {
        // 初始化并缓存全局配置（如包含 PRISM 变量亦会自动合并注入 env，全局仅解析一次）
        resolveConfig(env);

        // 委托给 Prism 鉴权中间件进行拦截与认证
        return prismAuthHandler(request, env, ctx);
    }
};

/**
 * 核心业务处理逻辑（在通过 Prism 鉴权或命中 isPublic 免登白名单后调用）
 */
async function handleBusiness(request, env, ctx, user) {
    const url = new URL(request.url);

    // 处理跨域预检
    if (request.method === "OPTIONS") {
        return handleCors();
    }

    try {
        // 1. 浏览器访问主页：在线调试控制台（已通过 Prism 登录验证，携带 user 身份）
        if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
            return renderDashboard(request, env, user);
        }

        // 2. 消息通知发送接口 (支持 POST /sendMessage、POST /sendPhoto、POST /bot<token>/... 或直接 POST /)
        if (
            request.method === "POST" ||
            url.pathname.endsWith("/sendMessage") ||
            url.pathname.endsWith("/sendPhoto") ||
            url.pathname.includes("/bot")
        ) {
            return await handleSendMessage(request, env, url);
        }

        return jsonResponse({ ok: false, error_code: 404, description: "Not Found" }, 404);
    } catch (err) {
        return jsonResponse({
            ok: false,
            error_code: 500,
            description: `Gateway Internal Error: ${err.message || String(err)}`
        }, 500);
    }
}

/**
 * 处理通知发送请求 (包含比对鉴权与多渠道路由)
 */
async function handleSendMessage(request, env, url) {
    // 1. 合并环境配置
    const cfg = resolveConfig(env);

    // 2. 解析请求体 (短路极速直达)
    const payload = await parseRequestBody(request);

    // 提取客户端传递的 Token (优先从 /bot<token>/ 路径提取，极大降低无用 Header/Query 检索开销)
    const tokenFromPathMatch = url.pathname.match(/\/bot([^\/]+)/i);
    let pathToken = null;
    let clientToken = null;
    if (tokenFromPathMatch) {
        pathToken = tokenFromPathMatch[1];
        if (pathToken.includes("%")) {
            try { pathToken = decodeURIComponent(pathToken); } catch (_) { }
        }
        clientToken = pathToken;
    } else {
        const authHeader = request.headers.get("authorization") || "";
        if (authHeader.toLowerCase().startsWith("bearer ")) {
            clientToken = authHeader.substring(7).trim();
        } else {
            clientToken = request.headers.get("token")
                || request.headers.get("x-token")
                || request.headers.get("x-bot-token")
                || url.searchParams.get("token")
                || url.searchParams.get("bot_token")
                || payload.token
                || payload.bot_token
                || "";
            if (clientToken && clientToken.includes("%")) {
                try { clientToken = decodeURIComponent(clientToken); } catch (_) { }
            }
        }
    }
    clientToken = (clientToken || "").trim();

    // 提取核心字段 (支持 body 任意命名，短路解码 HTML 实体)
    const rawText = payload.caption || payload.text || payload.message || payload.content || url.searchParams.get("caption") || url.searchParams.get("text") || "";
    const text = decodeHtmlEntities(rawText);
    const parseMode = payload.parse_mode || url.searchParams.get("parse_mode") || "Markdown";

    // 提取图片字段 (支持 File/Blob 二进制对象、网络图片直链 URL、TG file_id)
    const photo = payload.photo || payload.image || payload.image_url || payload.file || url.searchParams.get("photo") || url.searchParams.get("image") || null;

    // 提取 chat_id (短路匹配 Body -> Query -> Header)
    let incomingChatId = payload.chat_id !== undefined && payload.chat_id !== null ? String(payload.chat_id).trim() : "";
    if (!incomingChatId) {
        incomingChatId = (url.searchParams.get("chat_id") || request.headers.get("x-chat-id") || "").trim();
    }
    if (incomingChatId.includes("%")) {
        try { incomingChatId = decodeURIComponent(incomingChatId).trim(); } catch (_) { }
    }

    // 3. 【简单比对鉴权】
    // 若配置了 TG_BOT_TOKEN，则比对客户端 Token
    if (cfg.TG_BOT_TOKEN && clientToken !== String(cfg.TG_BOT_TOKEN).trim()) {
        return jsonResponse({
            ok: false,
            error_code: 401,
            description: "Unauthorized: Invalid or missing bot token"
        }, 401);
    }

    // 若配置了 TG_CHAT_ID，则比对客户端 Chat ID
    if (cfg.TG_CHAT_ID && incomingChatId !== String(cfg.TG_CHAT_ID).trim()) {
        return jsonResponse({
            ok: false,
            error_code: 401,
            description: "Unauthorized: Invalid or missing chat_id"
        }, 401);
    }

    // 校验：文本与图片不可同时为空
    if (!text && !photo) {
        return jsonResponse({
            ok: false,
            error_code: 400,
            description: "Bad Request: message text and photo are both empty (expected 'text', 'caption', or 'photo' field)"
        }, 400);
    }

    // 3. 确定发送通道与降级通道
    // 优先级：URL 查询参数 > Header 标头 > chat_id 语法指示 > 环境变量默认值
    let primaryChannelsStr = url.searchParams.get("channel") ||
        url.searchParams.get("channels") ||
        request.headers.get("x-channel") ||
        request.headers.get("x-channels") || "";

    let fallbackChannelsStr = url.searchParams.get("fallback") ||
        url.searchParams.get("fallback_channel") ||
        request.headers.get("x-fallback") ||
        request.headers.get("x-fallback-channel") || "";

    // 语法糖：允许在 chat_id 里面显式指定通道，例如 chat_id="@wxpusher" 或 "channel:feishu|fallback:wxpusher"
    if (incomingChatId.startsWith("channel:")) {
        const parts = incomingChatId.split("|");
        for (const part of parts) {
            if (part.startsWith("channel:")) primaryChannelsStr = part.replace("channel:", "").trim();
            if (part.startsWith("fallback:")) fallbackChannelsStr = part.replace("fallback:", "").trim();
        }
    } else if (["wxpusher", "feishu", "dingtalk", "discord", "tg", "telegram", "coral", "coral2"].includes(incomingChatId.toLowerCase())) {
        primaryChannelsStr = incomingChatId.toLowerCase();
    }

    // 若未指定则回退到配置默认值
    const primaryChannels = parseChannelList(primaryChannelsStr || cfg.DEFAULT_CHANNELS);
    const fallbackChannels = parseChannelList(fallbackChannelsStr || cfg.FALLBACK_CHANNELS);

    // 构建消息上下文对象
    const msgContext = {
        title: payload.title || "",
        text,
        photo,
        parseMode,
        chatId: incomingChatId,
        pathToken,
        rawPayload: payload,
        cfg,
        requestUrl: url,
        immediate: payload.immediate
    };

    // 4. 执行主要通道发送
    const primaryResults = await dispatchToChannels(primaryChannels, msgContext, false);
    const isPrimaryAllFailed = primaryResults.length > 0 && primaryResults.every(r => !r.success);

    let fallbackResults = [];
    let fallbackTriggered = false;

    // 5. 判断是否触发降级通道
    if (isPrimaryAllFailed && fallbackChannels.length > 0) {
        fallbackTriggered = true;
        const errorsSummary = primaryResults.map(r => `[${r.channel}] ${r.error}`).join("; ");

        // 如果配置允许，在降级推送内容中附带降级原因说明
        const fallbackMsgContext = { ...msgContext };
        if (cfg.APPEND_FALLBACK_NOTICE) {
            fallbackMsgContext.text = `⚠️【通知网关降级告警】\n主渠道 [${primaryChannels.join(", ")}] 发送失败：${errorsSummary}\n\n---\n以下为原消息内容：\n${text}`;
        }

        fallbackResults = await dispatchToChannels(fallbackChannels, fallbackMsgContext, true);
    }

    // 6. 综合判定返回结果
    const anySuccess = primaryResults.some(r => r.success) || fallbackResults.some(r => r.success);

    if (anySuccess) {
        // 按照 Telegram 标准返回成功，并附带各渠道递送报告
        return jsonResponse({
            ok: true,
            result: {
                message_id: Math.floor(Date.now() / 1000),
                date: Math.floor(Date.now() / 1000),
                chat: {
                    id: !isNaN(Number(incomingChatId)) && incomingChatId !== "" ? Number(incomingChatId) : (incomingChatId || 0),
                    type: "private"
                },
                text: text,
                caption: text,
                gateway_report: {
                    primary_channels: primaryChannels,
                    primary_results: primaryResults,
                    fallback_triggered: fallbackTriggered,
                    fallback_channels: fallbackChannels,
                    fallback_results: fallbackResults
                }
            }
        });
    } else {
        // 全部渠道（包含降级渠道）均失败
        const allErrors = [...primaryResults, ...fallbackResults]
            .map(r => `[${r.channel}${r.isFallback ? " (fallback)" : ""}]: ${r.error}`)
            .join(" | ");

        return jsonResponse({
            ok: false,
            error_code: 502,
            description: `All dispatch channels failed: ${allErrors}`,
            gateway_report: {
                primary_results: primaryResults,
                fallback_results: fallbackResults
            }
        }, 502);
    }
}

/**
 * 遍历通道列表进行推送发送 (单通道直接发，多通道 Promise.all 并行广播极大提升响应速度)
 */
async function dispatchToChannels(channels, context, isFallback = false) {
    const validChannels = channels.map(c => c.trim().toLowerCase()).filter(Boolean);
    if (validChannels.length === 0) return [];

    if (validChannels.length === 1) {
        return [await dispatchSingleChannel(validChannels[0], context, isFallback)];
    }

    return await Promise.all(validChannels.map(ch => dispatchSingleChannel(ch, context, isFallback)));
}

async function dispatchSingleChannel(ch, context, isFallback) {
    const res = { channel: ch, isFallback, success: false, error: null, data: null };
    try {
        switch (ch) {
            case "tg":
            case "telegram":
                res.data = await sendTelegram(context);
                res.success = true;
                break;

            case "discord":
                res.data = await sendDiscord(context);
                res.success = true;
                break;

            case "feishu":
            case "lark":
                res.data = await sendFeishu(context);
                res.success = true;
                break;

            case "dingtalk":
            case "ding":
                res.data = await sendDingTalk(context);
                res.success = true;
                break;

            case "wxpusher":
            case "wxpush":
                res.data = await sendWxPusher(context);
                res.success = true;
                break;

            case "coral":
            case "coralapi":
                res.data = await sendCoral(context);
                res.success = true;
                break;

            case "coral2":
            case "coral2api":
                res.data = await sendCoral2(context);
                res.success = true;
                break;

            default:
                throw new Error(`Unsupported channel: '${ch}'`);
        }
    } catch (err) {
        res.success = false;
        res.error = err.message || String(err);
    }
    return res;
}

// ==============================================================================
// 渠道具体适配器实现 (Adapters)
// ==============================================================================

/**
 * 安全解析外部 HTTP 响应为 JSON
 * 当外部上游服务发生宕机、超时、返回 HTML/纯文本（如 Cloudflare 522/502/504 错误页）时，
 * 避免抛出隐晦的 SyntaxError: Unexpected token 'e'... 而是格式化为清晰的人类可读报错
 */
async function parseSafeJson(response, serviceName) {
    const rawText = await response.text();
    let data;
    try {
        data = JSON.parse(rawText);
    } catch {
        let statusHint = `HTTP ${response.status}`;
        if (response.status === 522) {
            statusHint += " (Cloudflare 522 源站连接超时 Connection Timed Out)";
        } else if (response.status === 502) {
            statusHint += " (Bad Gateway 网关错误)";
        } else if (response.status === 504) {
            statusHint += " (Gateway Timeout 网关超时)";
        }
        const snippet = rawText.trim().replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").substring(0, 120);
        throw new Error(`${serviceName} 响应异常 [${statusHint}]: ${snippet || "非 JSON 响应"}`);
    }
    return data;
}

/**
 * 1. Telegram 适配器 (支持纯文本 sendMessage 与图文一体 sendPhoto)
 */
async function sendTelegram({ text, photo, parseMode, chatId, pathToken, cfg }) {
    const token = pathToken || cfg.TG_BOT_TOKEN;
    const isTgChatId = chatId && (!isNaN(Number(chatId)) || (typeof chatId === "string" && chatId.startsWith("@")));
    const targetChatId = isTgChatId ? chatId : cfg.TG_CHAT_ID;

    if (!token) {
        throw new Error("TG_BOT_TOKEN is not configured (neither in URL path nor in env)");
    }
    if (!targetChatId) {
        throw new Error("TG_CHAT_ID is not provided (neither in request body nor in env)");
    }

    // 若包含图片，使用 Telegram 官方 sendPhoto 接口规范发送图文一体消息
    if (photo) {
        const tgUrl = `https://${cfg.TG_API_HOST}/bot${token}/sendPhoto`;
        // Telegram 限制 caption 字符数为 1024，超长进行安全截断
        const safeCaption = text && text.length > 1000 ? text.substring(0, 1000) + "\n...(truncated)" : (text || "");
        
        let sendFile = photo;
        let isFileObject = typeof photo === "object" && photo !== null && typeof photo.arrayBuffer === "function";

        let mimeType = "";
        // 若 photo 是网络 HTTP(S) URL，尝试由 Cloudflare Worker 预先拉取图片二进制
        // 核心作用：
        // 1. 规避外部图床防盗链或屏蔽 Telegram 服务器爬虫 IP (导致 Telegram 报错: wrong type of the web page content)
        // 2. 规避 Content-Disposition: attachment 强制下载响应
        // 3. 直接转为标准 multipart/form-data 二进制上传给 Telegram，成功率 100%
        if (!isFileObject && typeof photo === "string" && (photo.startsWith("http://") || photo.startsWith("https://"))) {
            try {
                const imgFetchRes = await fetch(photo, {
                    headers: {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
                    },
                    signal: AbortSignal.timeout(8000)
                });
                if (imgFetchRes.ok) {
                    const cType = (imgFetchRes.headers.get("content-type") || "").toLowerCase();
                    const cLen = parseInt(imgFetchRes.headers.get("content-length") || "0", 10);
                    // 确认是图片流且体积在 15MB 限制内
                    if ((cType.startsWith("image/") || cType.includes("octet-stream")) && (!cLen || cLen <= 15 * 1024 * 1024)) {
                        const blob = await imgFetchRes.blob();
                        if (blob && blob.size > 0 && blob.size <= 15 * 1024 * 1024) {
                            sendFile = blob;
                            isFileObject = true;
                            mimeType = cType;
                        }
                    }
                }
            } catch (_) {
                // 预取失败时，优雅回退到 Telegram 自行下载 URL
            }
        }

        if (isFileObject) {
            // 通过 multipart/form-data 转发本地上传的文件或 Worker 预拉取的二进制流
            const extName = mimeType.includes("png") ? "photo.png" : (mimeType.includes("webp") ? "photo.webp" : "photo.jpg");
            const uploadFileName = (sendFile && sendFile.name) || extName;
            const formData = new FormData();
            formData.append("chat_id", targetChatId);
            formData.append("photo", sendFile, uploadFileName);
            if (safeCaption) {
                formData.append("caption", safeCaption);
                if (parseMode) formData.append("parse_mode", parseMode);
            }

            let response = await fetch(tgUrl, {
                method: "POST",
                body: formData
            });

            let resJson = await parseSafeJson(response, "Telegram");

            // 若因 Markdown 语法解析报错，自动去除 parse_mode 纯文本重试兜底
            if (!response.ok && resJson && resJson.description && resJson.description.toLowerCase().includes("can't parse entities")) {
                const retryForm = new FormData();
                retryForm.append("chat_id", targetChatId);
                retryForm.append("photo", sendFile, (sendFile && sendFile.name) || "photo.jpg");
                if (safeCaption) retryForm.append("caption", safeCaption);
                response = await fetch(tgUrl, {
                    method: "POST",
                    body: retryForm
                });
                resJson = await parseSafeJson(response, "Telegram");
            }

            if (!response.ok || !resJson.ok) {
                throw new Error(`Telegram API Error: ${resJson.description || response.statusText}`);
            }
            return resJson;
        } else {
            // photo 为网络图片 URL 或 Telegram file_id
            const payload = {
                chat_id: targetChatId,
                photo: String(photo).trim(),
                caption: safeCaption,
                parse_mode: parseMode || "Markdown"
            };

            let response = await fetch(tgUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            let resJson = await parseSafeJson(response, "Telegram");

            if (!response.ok && resJson && resJson.description && resJson.description.toLowerCase().includes("can't parse entities")) {
                delete payload.parse_mode;
                response = await fetch(tgUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
                resJson = await parseSafeJson(response, "Telegram");
            }

            // 若 Telegram 提示 wrong type of the web page content (说明 URL 返回了 HTML 网页而非图片)
            // 自动降级为带网页预览的 sendMessage 发送，确保消息 100% 成功送达
            if (!response.ok && resJson && resJson.description && resJson.description.toLowerCase().includes("wrong type of the web page content")) {
                const fallbackText = safeCaption ? `${safeCaption}\n\n🔗 ${photo}` : `🔗 ${photo}`;
                return await sendTelegramTextMessage({
                    text: fallbackText,
                    parseMode: "Markdown",
                    targetChatId,
                    token,
                    cfg
                });
            }

            if (!response.ok || !resJson.ok) {
                throw new Error(`Telegram API Error: ${resJson.description || response.statusText}`);
            }
            return resJson;
        }
    }

    // 纯文本消息逻辑 (Telegram 单条消息文本上限 4096 字符)
    return await sendTelegramTextMessage({
        text,
        parseMode,
        targetChatId,
        token,
        cfg
    });
}

/**
 * 辅助函数：发送 Telegram 纯文本消息 (封装 parse_mode 容错与重试)
 */
async function sendTelegramTextMessage({ text, parseMode, targetChatId, token, cfg }) {
    const safeText = text && text.length > 4000 ? text.substring(0, 4000) + "\n...(truncated)" : (text || "");
    const tgUrl = `https://${cfg.TG_API_HOST}/bot${token}/sendMessage`;
    const payload = {
        chat_id: targetChatId,
        text: safeText,
        parse_mode: parseMode || "Markdown",
        disable_web_page_preview: false
    };

    let response = await fetch(tgUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    let resJson = await parseSafeJson(response, "Telegram");

    // 若由于 Markdown 语法解析失败，自动去除 parse_mode 重试纯文本发送兜底
    if (!response.ok && resJson && resJson.description && resJson.description.toLowerCase().includes("can't parse entities")) {
        delete payload.parse_mode;
        response = await fetch(tgUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        resJson = await parseSafeJson(response, "Telegram");
    }

    if (!response.ok || !resJson.ok) {
        throw new Error(`Telegram API Error: ${resJson.description || response.statusText}`);
    }
    return resJson;
}

/**
 * 2. Discord 适配器 (支持纯文本与文件附件/网络图片 Embed)
 */
async function sendDiscord({ text, photo, cfg, requestUrl }) {
    // 允许通过 Query 参数传递自定义 Webhook 地址：?discord_webhook=...
    const webhookUrl = requestUrl.searchParams.get("discord_webhook") || cfg.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) {
        throw new Error("DISCORD_WEBHOOK_URL is not configured");
    }

    // Discord 限制单条消息最大 2000 字符，超长则适当截断
    const safeText = text && text.length > 1950 ? text.substring(0, 1950) + "\n...(truncated)" : (text || "");
    const isFileObject = typeof photo === "object" && photo !== null && typeof photo.arrayBuffer === "function";

    let response;
    if (isFileObject) {
        const formData = new FormData();
        formData.append("payload_json", JSON.stringify({
            content: safeText,
            username: "NoticeGateway"
        }));
        formData.append("files[0]", photo, photo.name || "image.png");
        response = await fetch(webhookUrl, {
            method: "POST",
            body: formData
        });
    } else if (typeof photo === "string" && (photo.startsWith("http://") || photo.startsWith("https://"))) {
        response = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                content: safeText,
                username: "NoticeGateway",
                embeds: [{ image: { url: photo } }]
            })
        });
    } else {
        response = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                content: safeText,
                username: "NoticeGateway"
            })
        });
    }

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Discord Webhook Error [HTTP ${response.status}]: ${errText}`);
    }
    return { status: response.status, statusText: response.statusText };
}

/**
 * 3. 飞书 (Feishu / Lark) 适配器
 */
async function sendFeishu({ text, photo, cfg, requestUrl }) {
    const webhookUrl = requestUrl.searchParams.get("feishu_webhook") || cfg.FEISHU_WEBHOOK_URL;
    const secret = requestUrl.searchParams.get("feishu_secret") || cfg.FEISHU_SECRET;

    if (!webhookUrl) {
        throw new Error("FEISHU_WEBHOOK_URL is not configured");
    }

    let msgContent = text || "";
    if (typeof photo === "string" && (photo.startsWith("http://") || photo.startsWith("https://"))) {
        msgContent = msgContent ? `${msgContent}\n\n图片链接: ${photo}` : `图片链接: ${photo}`;
    } else if (photo && typeof photo === "object") {
        msgContent = msgContent ? `${msgContent}\n\n[图片附件: ${photo.name || "image"}]` : `[图片附件: ${photo.name || "image"}]`;
    }

    // 飞书文本限制，超长进行安全截断
    const safeText = msgContent.length > 19000 ? msgContent.substring(0, 19000) + "\n...(truncated)" : msgContent;

    const payload = {
        msg_type: "text",
        content: {
            text: safeText
        }
    };

    // 支持飞书签名校验
    if (secret) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const sign = await generateFeishuSign(secret, timestamp);
        payload.timestamp = timestamp;
        payload.sign = sign;
    }

    const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    const resJson = await parseSafeJson(response, "Feishu");
    if (!response.ok || resJson.code !== 0) {
        throw new Error(`Feishu API Error [code ${resJson.code}]: ${resJson.msg || "unknown error"}`);
    }
    return resJson;
}

/**
 * 4. 钉钉 (DingTalk) 适配器
 */
async function sendDingTalk({ text, photo, title, cfg, requestUrl }) {
    let webhookUrl = requestUrl.searchParams.get("dingtalk_webhook") || cfg.DINGTALK_WEBHOOK_URL;
    const secret = requestUrl.searchParams.get("dingtalk_secret") || cfg.DINGTALK_SECRET;

    if (!webhookUrl) {
        throw new Error("DINGTALK_WEBHOOK_URL is not configured");
    }

    // 支持钉钉加签逻辑
    if (secret) {
        webhookUrl = await appendDingTalkSign(webhookUrl, secret);
    }

    // 若包含图片 URL，使用 markdown 模式渲染图文
    let payload;
    if (typeof photo === "string" && (photo.startsWith("http://") || photo.startsWith("https://"))) {
        const mdText = text ? `${text}\n\n![image](${photo})` : `![image](${photo})`;
        const safeText = mdText.length > 19000 ? mdText.substring(0, 19000) + "\n...(truncated)" : mdText;
        payload = {
            msgtype: "markdown",
            markdown: {
                title: title || "通知提醒",
                text: safeText
            }
        };
    } else {
        const rawText = text || (photo && typeof photo === "object" ? `[图片附件: ${photo.name || "image"}]` : "");
        const safeText = rawText.length > 19000 ? rawText.substring(0, 19000) + "\n...(truncated)" : rawText;
        payload = {
            msgtype: "text",
            text: {
                content: safeText
            }
        };
    }

    const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    const resJson = await parseSafeJson(response, "DingTalk");
    if (!response.ok || resJson.errcode !== 0) {
        throw new Error(`DingTalk API Error [errcode ${resJson.errcode}]: ${resJson.errmsg || "unknown error"}`);
    }
    return resJson;
}

/**
 * 5. WxPusher 适配器 (微信公众号推送)
 * 接口规范: POST https://wxpusher.zjiecode.com/api/send/message
 * Payload: {"appToken":"xxx","content":"xxx","uids":["UID_xxx"]}
 */
async function sendWxPusher({ text, photo, parseMode, chatId, cfg, requestUrl, title, immediate, rawPayload }) {
    const appToken = requestUrl.searchParams.get("wxpusher_token") || cfg.WXPUSHER_APP_TOKEN;
    if (!appToken) {
        throw new Error("WXPUSHER_APP_TOKEN is not configured");
    }

    // 提取 UID 列表 (兼容数组与逗号隔开的字符串配置，优先支持请求体指定)
    let uids = [];
    if (chatId && typeof chatId === "string" && chatId.startsWith("UID_")) {
        uids = [chatId.trim()];
    } else if (rawPayload && (rawPayload.uids || rawPayload.uid)) {
        const u = rawPayload.uids || rawPayload.uid;
        uids = Array.isArray(u) ? u.map(s => String(s).trim()).filter(Boolean) : String(u).split(",").map(s => s.trim()).filter(Boolean);
    } else {
        const rawUids = requestUrl.searchParams.get("wxpusher_uids") || cfg.WXPUSHER_UIDS;
        if (Array.isArray(rawUids)) {
            uids = rawUids.map(u => String(u).trim()).filter(Boolean);
        } else if (typeof rawUids === "string" && rawUids.trim()) {
            uids = rawUids.split(",").map(u => u.trim()).filter(Boolean);
        }
    }

    // 提取 Topic ID 列表 (兼容数组、数字与字符串配置，支持请求体指定)
    let topicIds = [];
    if (rawPayload && (rawPayload.topicIds || rawPayload.topic_ids || rawPayload.topicId)) {
        const t = rawPayload.topicIds || rawPayload.topic_ids || rawPayload.topicId;
        const list = Array.isArray(t) ? t : String(t).split(",");
        topicIds = list.map(item => Number(String(item).trim())).filter(n => !isNaN(n));
    } else {
        const rawTopics = requestUrl.searchParams.get("wxpusher_topics") || cfg.WXPUSHER_TOPIC_IDS;
        if (Array.isArray(rawTopics)) {
            topicIds = rawTopics.map(t => Number(t)).filter(n => !isNaN(n));
        } else if (typeof rawTopics === "string" && rawTopics.trim()) {
            topicIds = rawTopics.split(",").map(t => Number(t.trim())).filter(n => !isNaN(n));
        } else if (typeof rawTopics === "number" && !isNaN(rawTopics)) {
            topicIds = [rawTopics];
        }
    }

    if (uids.length === 0 && topicIds.length === 0) {
        throw new Error("WxPusher Error: Neither 'uids' nor 'topicIds' is provided");
    }

    // 适配富文本格式：Markdown 为 3，HTML 为 2，纯文本为 1
    let contentType = 1;
    const pMode = (parseMode || "").toLowerCase();
    if (pMode.includes("markdown")) {
        contentType = 3;
    } else if (pMode.includes("html")) {
        contentType = 2;
    }

    // 组装带图片的推送正文
    let contentText = text || "";
    if (typeof photo === "string" && (photo.startsWith("http://") || photo.startsWith("https://"))) {
        if (contentType === 2) {
            contentText = `<img src="${photo}" style="max-width:100%;border-radius:6px;" /><br/>${contentText}`;
        } else {
            contentType = 3; // 自动提升为 Markdown 渲染图片
            contentText = `![image](${photo})\n\n${contentText}`;
        }
    } else if (photo && typeof photo === "object") {
        contentText = `[图片附件: ${photo.name || "image"}]\n\n${contentText}`;
    }

    // 生成微信卡片摘要 (summary)，优先使用独立 title，超长安全截断
    let baseSummary = "";
    if (title && typeof title === "string" && title.trim()) {
        baseSummary = title.replace(/<[^>]+>/g, "").replace(/[*_#`]/g, "").trim().substring(0, 80);
    } else {
        baseSummary = (text || "图片通知")
            .replace(/<[^>]+>/g, "")
            .replace(/[*_#`]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .substring(0, 80);
    }

    // 根据 immediate 参数精细控制卡片外显标识：
    // - immediate 为 true: 追加 🔥即时回复 提醒用户即时交互维持 ClawBot 会话
    // - immediate 为 false: 保持原样干净摘要，不打扰用户
    // - immediate 未指定时: 保持原有向后兼容追加 🔥即时回复
    let finalSummary = baseSummary;
    if (immediate === true) {
        finalSummary = baseSummary ? `${baseSummary} 🔥即时回复` : "🔥即时回复";
    } else if (immediate === false) {
        finalSummary = baseSummary || "通知消息";
    } else {
        finalSummary = baseSummary ? `${baseSummary} 🔥即时回复` : "🔥即时回复";
    }

    const payload = {
        appToken: appToken,
        content: contentText,
        summary: finalSummary,
        contentType: contentType,
        uids: uids,
        topicIds: topicIds
    };

    let response;
    // 遇到网络抖动或 522/502/504 服务器连接超时进行最多 1 次重试 (间隔 500ms)
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            response = await fetch("https://wxpusher.zjiecode.com/api/send/message", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            // 若遇 5xx 服务器临时故障且为第 1 次尝试，等待 500ms 后自动重试
            if (response.status >= 500 && attempt === 1) {
                await new Promise(r => setTimeout(r, 500));
                continue;
            }
            break;
        } catch (fetchErr) {
            if (attempt === 1) {
                await new Promise(r => setTimeout(r, 500));
                continue;
            }
            throw new Error(`WxPusher 网络请求失败: ${fetchErr.message}`);
        }
    }

    const resJson = await parseSafeJson(response, "WxPusher");
    // WxPusher 规范: code === 1000 表示提交成功
    if (!response.ok || resJson.code !== 1000) {
        throw new Error(`WxPusher API Error [code ${resJson.code}]: ${resJson.msg || "unknown error"}`);
    }
    return resJson;
}

/**
 * 6. Coral 协议通用适配器核心实现 (供 coral 与 coral2 等多实例共享一套代码，杜绝冗余)
 * 接口规范: POST <WEBHOOK_URL>/coral/api/send
 * Headers: x-api-key: <API_KEY>
 * Payload: {"title":"...","text":"...","immediate":false}
 */
async function sendCoralCompatible({
    serviceName = "Coral",
    webhookUrl,
    apiKey,
    defaultTitle,
    defaultImmediate,
    text,
    photo,
    requestUrl,
    rawPayload
}) {
    if (!webhookUrl) {
        throw new Error(`${serviceName}_WEBHOOK_URL is not configured (neither in URL params nor in env)`);
    }

    // 智能处理 URL：若用户仅填了域名或根路径，自动追加 /coral/api/send
    if (!webhookUrl.includes("/coral/api/send")) {
        webhookUrl = webhookUrl.replace(/\/+$/, "") + "/coral/api/send";
    }

    // 1. 提取标题 (title)
    // 优先级：显式参数 (payload.title 或 ?title=) > 智能从文本首行/【...】提取 > 默认配置
    let title = (rawPayload && rawPayload.title) || requestUrl.searchParams.get("title") || "";
    let cleanText = text;

    if (!title) {
        // 支持识别开头方括号【标题】内容
        const bracketMatch = text.match(/^\s*【([^】\n]+)】\s*([\s\S]*)$/);
        if (bracketMatch) {
            title = bracketMatch[1].trim();
            cleanText = bracketMatch[2].trim() || title;
        } else {
            // 支持从第一行提取简短标题（不超过 60 字符），剩余部分作为正文
            const firstNewline = text.indexOf("\n");
            if (firstNewline > 0) {
                const firstLine = text.substring(0, firstNewline).trim();
                if (firstLine.length > 0 && firstLine.length <= 60) {
                    title = firstLine.replace(/^[#*`\s]+|[#*`\s]+$/g, "");
                    cleanText = text.substring(firstNewline + 1).trim() || text;
                }
            }
        }
    }

    if (!title) {
        title = defaultTitle || "通知网关提醒";
    }

    // 若包含图片 URL，在正文中追加展示
    // 注意：微信 / ClawBot 不支持 Markdown 图片标签语法 ![图片](url)，会将其解析为 alt 文本 "图片"，导致丢失真实图片链接。
    // 因此在正文以可点击直链展示，并在请求体中透传 image / image_url / photo 字段供 ClawBot 原生使用
    if (typeof photo === "string" && (photo.startsWith("http://") || photo.startsWith("https://"))) {
        cleanText = cleanText ? `${cleanText}\n\n图片链接: ${photo}` : `图片链接: ${photo}`;
    } else if (photo && typeof photo === "object") {
        cleanText = cleanText ? `${cleanText}\n\n[图片附件: ${photo.name || "image"}]` : `[图片附件: ${photo.name || "image"}]`;
    }

    // 2. 提取 immediate 参数
    // 优先级：请求体 immediate > URL 参数 immediate=true/false > 默认配置 (false)
    let immediate = false;
    if (rawPayload && rawPayload.immediate !== undefined && rawPayload.immediate !== null) {
        immediate = typeof rawPayload.immediate === "boolean" ? rawPayload.immediate : String(rawPayload.immediate).toLowerCase() === "true";
    } else if (requestUrl.searchParams.has("immediate")) {
        immediate = requestUrl.searchParams.get("immediate") === "true";
    } else if (defaultImmediate !== undefined) {
        immediate = typeof defaultImmediate === "boolean" ? defaultImmediate : String(defaultImmediate).toLowerCase() === "true";
    }

    // 3. 构造请求头与报文体
    const headers = {
        "Content-Type": "application/json"
    };
    if (apiKey) {
        headers["x-api-key"] = apiKey;
    }

    const payload = {
        title: title,
        text: cleanText,
        immediate: immediate
    };

    if (photo && typeof photo === "string") {
        payload.image = photo;
        payload.image_url = photo;
        payload.photo = photo;
        payload.url = photo;
    }

    // 4. 发送 HTTP POST 请求 (如遇 5xx 服务器临时故障进行最多 1 次重试)
    let response;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            response = await fetch(webhookUrl, {
                method: "POST",
                headers: headers,
                body: JSON.stringify(payload)
            });

            if (response.status >= 500 && attempt === 1) {
                await new Promise(r => setTimeout(r, 500));
                continue;
            }
            break;
        } catch (fetchErr) {
            if (attempt === 1) {
                await new Promise(r => setTimeout(r, 500));
                continue;
            }
            throw new Error(`${serviceName} 网络请求失败: ${fetchErr.message}`);
        }
    }

    const resJson = await parseSafeJson(response, serviceName);
    if (!response.ok) {
        throw new Error(`${serviceName} API Error [HTTP ${response.status}]: ${JSON.stringify(resJson)}`);
    }
    return resJson;
}

/**
 * Coral 渠道适配器 (实例 1)
 */
async function sendCoral(context) {
    const { cfg, requestUrl } = context;
    const webhookUrl = requestUrl.searchParams.get("coral_url") ||
        requestUrl.searchParams.get("coral_webhook") ||
        cfg.CORAL_WEBHOOK_URL;
    const apiKey = requestUrl.searchParams.get("coral_key") ||
        requestUrl.searchParams.get("coral_api_key") ||
        cfg.CORAL_API_KEY;

    return await sendCoralCompatible({
        ...context,
        serviceName: "Coral",
        webhookUrl,
        apiKey,
        defaultTitle: cfg.CORAL_DEFAULT_TITLE,
        defaultImmediate: cfg.CORAL_IMMEDIATE
    });
}

/**
 * Coral 2 渠道适配器 (实例 2，共用同一套底层发送逻辑)
 */
async function sendCoral2(context) {
    const { cfg, requestUrl } = context;
    const webhookUrl = requestUrl.searchParams.get("coral2_url") ||
        requestUrl.searchParams.get("coral2_webhook") ||
        cfg.CORAL2_WEBHOOK_URL;
    const apiKey = requestUrl.searchParams.get("coral2_key") ||
        requestUrl.searchParams.get("coral2_api_key") ||
        cfg.CORAL2_API_KEY;

    return await sendCoralCompatible({
        ...context,
        serviceName: "Coral 2",
        webhookUrl,
        apiKey,
        defaultTitle: cfg.CORAL2_DEFAULT_TITLE,
        defaultImmediate: cfg.CORAL2_IMMEDIATE
    });
}

// ==============================================================================
// 签名与加密辅助函数 (Web Crypto API)
// ==============================================================================

/**
 * 飞书加签算法: HMAC-SHA256, key = timestamp + "\n" + secret, data = ""
 */
async function generateFeishuSign(secret, timestamp) {
    const enc = new TextEncoder();
    const stringToSign = `${timestamp}\n${secret}`;
    const key = await crypto.subtle.importKey(
        "raw",
        enc.encode(stringToSign),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, new Uint8Array(0));
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

/**
 * 钉钉加签算法: HMAC-SHA256, key = secret, data = timestamp + "\n" + secret
 */
async function appendDingTalkSign(webhookUrl, secret) {
    const timestamp = Date.now();
    const stringToSign = `${timestamp}\n${secret}`;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        "raw",
        enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, enc.encode(stringToSign));
    const base64Sign = btoa(String.fromCharCode(...new Uint8Array(signature)));

    const url = new URL(webhookUrl);
    url.searchParams.set("timestamp", timestamp.toString());
    url.searchParams.set("sign", base64Sign);
    return url.toString();
}

// ==============================================================================
// 请求解析与工具辅助函数
// ==============================================================================

/**
 * 解析各种格式的请求报文 (标准 JSON 直通，无多余循环与内存拷贝)
 */
async function parseRequestBody(request) {
    if (request.method === "GET" || request.method === "HEAD") {
        return {};
    }

    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
        try {
            return (await request.json()) || {};
        } catch (_) {
            return {};
        }
    }

    if (
        contentType.includes("application/x-www-form-urlencoded") ||
        contentType.includes("multipart/form-data")
    ) {
        try {
            const formData = await request.formData();
            const result = {};
            for (const [key, value] of formData.entries()) {
                // 保留完整的 File / Blob 二进制对象，避免被丢弃为文件名字符串
                result[key] = (value && typeof value === "object" && typeof value.arrayBuffer === "function")
                    ? value
                    : (typeof value === "string" ? value : String(value));
            }
            return result;
        } catch (_) {
            return {};
        }
    }

    // 纯文本兜底
    try {
        const text = await request.text();
        if (text) {
            try {
                return JSON.parse(text);
            } catch {
                return { text };
            }
        }
    } catch (_) { }

    return {};
}

/**
 * 合并环境变量与默认配置 (带 Worker 实例级内存缓存，每个生命周期只解析一次)
 * 优先级：单个独立环境变量 > CONFIG_JSON 整体配置 > 代码内置 DEFAULT_CONFIG
 */
function resolveConfig(env) {
    if (!env) return { ...DEFAULT_CONFIG };
    if (env._resolvedConfig) return env._resolvedConfig;

    let cfg = { ...DEFAULT_CONFIG };

    // 1. 支持整体读取 JSON 变量 (变量名支持 CONFIG_JSON 或 CONFIG)
    const rawJson = env.CONFIG_JSON || env.CONFIG;
    if (rawJson) {
        try {
            const parsed = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                for (const [k, v] of Object.entries(parsed)) {
                    if (v !== undefined && v !== null) {
                        cfg[k] = typeof DEFAULT_CONFIG[k] === "boolean" ? String(v).toLowerCase() === "true" : v;
                        // 同时赋给 env 供 PrismWorker 读取 PRISM 相关配置
                        if (env[k] === undefined) env[k] = v;
                    }
                }
            }
        } catch (e) {
            console.error("Failed to parse CONFIG_JSON:", e.message);
        }
    }

    // 2. 依然兼容单个环境变量设置/覆盖（优先级更高）
    for (const key of Object.keys(DEFAULT_CONFIG)) {
        if (env[key] !== undefined && env[key] !== null && env[key] !== "") {
            cfg[key] = typeof DEFAULT_CONFIG[key] === "boolean" ? String(env[key]).toLowerCase() === "true" : env[key];
        }
    }

    // 兼容 CORAL_API_KEY / API_KEY 环境变量别名
    if (!cfg.CORAL_API_KEY && (env.CORAL_API_KEY || env.API_KEY)) {
        cfg.CORAL_API_KEY = env.CORAL_API_KEY || env.API_KEY;
    }

    // 写入内存缓存，后续请求 0 开销直达
    env._resolvedConfig = cfg;
    return cfg;
}

/**
 * 解析通道列表（兼容逗号分隔字符串与配置数组）
 */
function parseChannelList(input) {
    if (!input) return [];
    if (Array.isArray(input)) return input.map(s => String(s).trim().toLowerCase()).filter(Boolean);
    return String(input).split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * 解码 HTML 实体（特别是 &#x8d26; 十六进制实体与 &#36134; 十进制实体）
 * 短路优化：若字符串不包含 '&'，立即返回，0 正则开销
 */
function decodeHtmlEntities(str) {
    if (!str || typeof str !== "string" || !str.includes("&")) return str;
    return str
        .replace(/&#x([0-9a-fA-F]+);?/g, (_, hex) => {
            try {
                return String.fromCodePoint(parseInt(hex, 16));
            } catch {
                return _;
            }
        })
        .replace(/&#([0-9]+);?/g, (_, dec) => {
            try {
                return String.fromCodePoint(parseInt(dec, 10));
            } catch {
                return _;
            }
        })
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, " ");
}

// 预定义通用 JSON 响应头，避免高频请求重复创建对象
const JSON_HEADERS = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*"
};

/**
 * 输出标准紧凑 JSON 响应 (去除美化缩进，大幅节省带宽与序列化耗时)
 */
function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: JSON_HEADERS
    });
}

/**
 * 处理 CORS 预检
 */
function handleCors() {
    return new Response(null, {
        status: 204,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Max-Age": "86400"
        }
    });
}

// ==============================================================================
// 现代化 Web 测试控制台页面 (Dashboard)
// ==============================================================================
function renderDashboard(request, env, user) {
    const cfg = resolveConfig(env);
    const host = request.headers.get("host") || "your-worker.workers.dev";
    const protocol = request.headers.get("x-forwarded-proto") || "https";
    const baseUrl = `${protocol}://${host}`;

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>通知中转网关 (Notice Gateway) - TG 协议兼容</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --code-bg: #090d16;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      padding: 30px 20px;
      line-height: 1.6;
    }
    .container { max-width: 960px; margin: 0 auto; }
    header { margin-bottom: 24px; border-bottom: 1px solid var(--border); padding-bottom: 16px; }
    h1 { font-size: 24px; display: flex; align-items: center; gap: 10px; color: #fff; }
    .badge {
      font-size: 12px;
      padding: 3px 8px;
      background: rgba(59, 130, 246, 0.2);
      border: 1px solid var(--primary);
      border-radius: 9999px;
      color: #93c5fd;
    }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px; }
    @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.2);
    }
    .card-title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 14px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .form-group { margin-bottom: 14px; }
    label { display: block; font-size: 13px; color: var(--text-muted); margin-bottom: 6px; }
    input, select, textarea {
      width: 100%;
      background: var(--code-bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 9px 12px;
      border-radius: 6px;
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
    }
    input:focus, select:focus, textarea:focus { border-color: var(--primary); }
    button {
      background: var(--primary);
      color: #fff;
      border: none;
      padding: 10px 18px;
      border-radius: 6px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
      width: 100%;
      font-size: 14px;
    }
    button:hover { background: var(--primary-hover); }
    .status-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .status-table td { padding: 8px 6px; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .status-table td:first-child { color: var(--text-muted); width: 140px; }
    .status-tag {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 500;
    }
    .tag-ok { background: rgba(16, 185, 129, 0.2); color: #6ee7b7; border: 1px solid rgba(16, 185, 129, 0.3); }
    .tag-empty { background: rgba(148, 163, 184, 0.2); color: #cbd5e1; }
    pre {
      background: var(--code-bg);
      border: 1px solid var(--border);
      padding: 12px;
      border-radius: 8px;
      font-size: 12px;
      overflow-x: auto;
      color: #e2e8f0;
      font-family: Consolas, Monaco, "Courier New", monospace;
    }
    .code-block { margin-top: 10px; position: relative; }
    .copy-btn {
      position: absolute;
      top: 6px;
      right: 6px;
      background: rgba(255,255,255,0.1);
      width: auto;
      padding: 3px 8px;
      font-size: 11px;
    }
    #resBox { margin-top: 14px; display: none; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
        <h1>🔔 通知中转网关 (Notice Gateway) <span class="badge">TG API 100% 兼容</span></h1>
        ${user ? `
        <div style="display: flex; align-items: center; gap: 10px; font-size: 13px;">
          <span style="color: #93c5fd; background: rgba(59, 130, 246, 0.15); padding: 4px 10px; border-radius: 6px; border: 1px solid rgba(59, 130, 246, 0.3);">
            👤 <strong>${user.name || user.email || user.username || user.preferred_username || user.sub || "已登录"}</strong>
          </span>
          <a href="/__logout" style="color: #f87171; text-decoration: none; padding: 4px 10px; border: 1px solid rgba(239, 68, 68, 0.4); border-radius: 6px; font-size: 12px; background: rgba(239, 68, 68, 0.1);">
            退出登录
          </a>
        </div>` : ''}
      </div>
      <p style="color: var(--text-muted); font-size: 14px; margin-top: 6px;">
        已部署在 Cloudflare Workers。可完美接收 Telegram 格式报文，并转发到 Telegram、WxPusher、飞书、钉钉、Discord、Coral (支持双实例)，支持主备自动降级。
      </p>
    </header>

    <div class="grid">
      <!-- 在线测试表单 -->
      <div class="card">
        <div class="card-title">🧪 在线推送测试</div>
        <form id="testForm">
          <div class="form-group">
            <label>主推送渠道 (可多选，逗号隔开，支持 coral, coral2)：</label>
            <input type="text" id="channel" value="${cfg.DEFAULT_CHANNELS}" placeholder="例如: wxpusher 或 coral 或 coral,coral2" />
          </div>
          <div class="form-group">
            <label>失败降级渠道 (主渠道失败时触发)：</label>
            <input type="text" id="fallback" value="${cfg.FALLBACK_CHANNELS}" placeholder="例如: coral2 或 feishu 或 dingtalk" />
          </div>
          <div class="form-group">
            <label>消息标题 (title，可选)：</label>
            <input type="text" id="title" value="测试告警" placeholder="输入消息标题 (Coral / Coral2 / WxPusher 渠道将优先使用)..." />
          </div>
          <div class="form-group">
            <label>消息内容 (text / caption)：</label>
            <textarea id="text" rows="3" placeholder="输入测试内容...">通知网关的测试消息 🚀</textarea>
          </div>
          <div class="form-group">
            <label>图片地址 (photo，可选，支持网络图片直链 URL)：</label>
            <input type="text" id="photo" value="" placeholder="输入图片直链 URL (如: https://.../pic.png，留空则纯文本)" />
          </div>
          <div class="form-group" style="display: flex; align-items: center; gap: 8px;">
            <input type="checkbox" id="immediate" style="width: auto; cursor: pointer;" />
            <label for="immediate" style="margin-bottom: 0; cursor: pointer; font-size: 13px;">即时加急 (immediate: true)</label>
          </div>
          <div class="form-group">
            <label>鉴权 Token (若开启 TG_BOT_TOKEN 需输入)：</label>
            <input type="text" id="token" value="" placeholder="若开启了鉴权请输入，未开启留空" />
          </div>
          <div class="form-group">
            <label>接收方 ID (chat_id / UID，可选)：</label>
            <input type="text" id="chat_id" value="" placeholder="若开启了 TG_CHAT_ID 或指定 WxPusher UID 可填" />
          </div>
          <button type="submit" id="submitBtn">立即发送测试</button>
        </form>

        <div id="resBox">
          <label style="margin-top: 14px; display: block;">网关响应结果：</label>
          <pre id="resContent"></pre>
        </div>
      </div>

      <!-- 渠道状态概览 -->
      <div class="card">
        <div class="card-title">⚙️ 渠道与鉴权配置状态</div>
        <table class="status-table">
          <tr>
            <td>网页端安全防护</td>
            <td>
              <span class="status-tag tag-ok">
                🔒 Prism OAuth 鉴权保护中
              </span>
            </td>
          </tr>
          <tr>
            <td>配置读取模式</td>
            <td>
              <span class="status-tag tag-ok">
                ${env && (env.CONFIG_JSON || env.CONFIG) ? "JSON 整体配置 (CONFIG_JSON)" : "单变量 / 默认配置"}
              </span>
            </td>
          </tr>
          <tr>
            <td>接口鉴权状态</td>
            <td>
              <span class="status-tag ${(cfg.TG_BOT_TOKEN || cfg.TG_CHAT_ID) ? "tag-ok" : "tag-empty"}">
                ${(cfg.TG_BOT_TOKEN && cfg.TG_CHAT_ID) ? "严格鉴权 (Token + Chat ID 双重比对)" : (cfg.TG_BOT_TOKEN ? "仅比对 Token" : (cfg.TG_CHAT_ID ? "仅比对 Chat ID" : "未开启鉴权 (公开)"))}
              </span>
            </td>
          </tr>
          <tr>
            <td>默认主渠道</td>
            <td><strong style="color: #60a5fa;">${cfg.DEFAULT_CHANNELS || "未设置"}</strong></td>
          </tr>
          <tr>
            <td>默认降级渠道</td>
            <td><strong style="color: #f59e0b;">${cfg.FALLBACK_CHANNELS || "未设置"}</strong></td>
          </tr>
          <tr>
            <td>Coral Webhook 地址</td>
            <td>
              <span class="status-tag ${cfg.CORAL_WEBHOOK_URL ? "tag-ok" : "tag-empty"}">
                ${cfg.CORAL_WEBHOOK_URL ? "已配置" : "未配置"}
              </span>
            </td>
          </tr>
          <tr>
            <td>Coral API Key (x-api-key)</td>
            <td>
              <span class="status-tag ${cfg.CORAL_API_KEY ? "tag-ok" : "tag-empty"}">
                ${cfg.CORAL_API_KEY ? "已配置" : "未配置"}
              </span>
            </td>
          </tr>
          <tr>
            <td>Coral 2 Webhook 地址</td>
            <td>
              <span class="status-tag ${cfg.CORAL2_WEBHOOK_URL ? "tag-ok" : "tag-empty"}">
                ${cfg.CORAL2_WEBHOOK_URL ? "已配置" : "未配置"}
              </span>
            </td>
          </tr>
          <tr>
            <td>Coral 2 API Key (x-api-key)</td>
            <td>
              <span class="status-tag ${cfg.CORAL2_API_KEY ? "tag-ok" : "tag-empty"}">
                ${cfg.CORAL2_API_KEY ? "已配置" : "未配置"}
              </span>
            </td>
          </tr>
          <tr>
            <td>WxPusher AppToken</td>
            <td>
              <span class="status-tag ${cfg.WXPUSHER_APP_TOKEN ? "tag-ok" : "tag-empty"}">
                ${cfg.WXPUSHER_APP_TOKEN ? "已配置" : "未配置"}
              </span>
            </td>
          </tr>
          <tr>
            <td>Telegram 渠道凭证</td>
            <td>
              <span class="status-tag ${cfg.TG_BOT_TOKEN ? "tag-ok" : "tag-empty"}">
                ${cfg.TG_BOT_TOKEN ? "已配置" : "未配置"}
              </span>
            </td>
          </tr>
          <tr>
            <td>飞书 Webhook</td>
            <td>
              <span class="status-tag ${cfg.FEISHU_WEBHOOK_URL ? "tag-ok" : "tag-empty"}">
                ${cfg.FEISHU_WEBHOOK_URL ? "已配置" : "未配置"}
              </span>
            </td>
          </tr>
          <tr>
            <td>钉钉 Webhook</td>
            <td>
              <span class="status-tag ${cfg.DINGTALK_WEBHOOK_URL ? "tag-ok" : "tag-empty"}">
                ${cfg.DINGTALK_WEBHOOK_URL ? "已配置" : "未配置"}
              </span>
            </td>
          </tr>
          <tr>
            <td>Discord Webhook</td>
            <td>
              <span class="status-tag ${cfg.DISCORD_WEBHOOK_URL ? "tag-ok" : "tag-empty"}">
                ${cfg.DISCORD_WEBHOOK_URL ? "已配置" : "未配置"}
              </span>
            </td>
          </tr>
        </table>

        <div style="margin-top: 16px; font-size: 12px; color: var(--text-muted);">
          💡 提示：推荐在 Cloudflare Worker 控制台「设置 -> 变量」中配置单个 <strong>CONFIG_JSON</strong> 变量，包含全部 JSON 配置，一次性整体生效！
        </div>
      </div>
    </div>

    <!-- API 使用示例 -->
    <div class="card">
      <div class="card-title">📖 通知接口调用示例 (支持 TG 协议与各渠道指定)</div>
      
      <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 8px;">
        任意监控或脚本均可直接配置该网关地址，支持多渠道广播与失败降级：
      </p>

      <div class="code-block">
        <pre><code># 1. 转发至 Coral 自定义通知渠道 (/coral/api/send)：
curl -X POST "${baseUrl}/sendMessage?channel=coral" \\
  -H "Authorization: Bearer &lt;YOUR_BOT_TOKEN&gt;" \\
  -H "Content-Type: application/json" \\
  -d '{"chat_id": "&lt;YOUR_CHAT_ID&gt;", "text": "【系统监控】服务 CPU 负载已恢复正常"}'

# 2. 转发至 Coral 2 (第二实例) 或配置双机容灾降级 (主用 coral，挂了自动切 coral2)：
curl -X POST "${baseUrl}/sendMessage?channel=coral&fallback=coral2" \\
  -H "Authorization: Bearer &lt;YOUR_BOT_TOKEN&gt;" \\
  -H "Content-Type: application/json" \\
  -d '{"chat_id": "&lt;YOUR_CHAT_ID&gt;", "text": "双机容灾测试消息"}'

# 3. 双机并行广播推送 (同时发送到 coral 和 coral2)：
curl -X POST "${baseUrl}/sendMessage?channel=coral,coral2" \\
  -H "Authorization: Bearer &lt;YOUR_BOT_TOKEN&gt;" \\
  -H "Content-Type: application/json" \\
  -d '{"chat_id": "&lt;YOUR_CHAT_ID&gt;", "text": "双机并行推送通知"}'

# 4. Telegram 官方 sendPhoto 图文一体发送 (本地图片二进制上传)：
curl -X POST "${baseUrl}/bot&lt;YOUR_BOT_TOKEN&gt;/sendPhoto" \\
  -F "chat_id=&lt;YOUR_CHAT_ID&gt;" \\
  -F "photo=@/path/to/screenshot.png" \\
  -F "caption=服务告警配图说明"

# 5. Telegram 官方 sendPhoto 图文一体发送 (网络图片直链 URL)：
curl -X POST "${baseUrl}/bot&lt;YOUR_BOT_TOKEN&gt;/sendPhoto" \\
  -H "Content-Type: application/json" \\
  -d '{
    "chat_id": "&lt;YOUR_CHAT_ID&gt;",
    "photo": "https://example.com/alert.png",
    "caption": "服务告警：CPU 负载过高！"
  }'

# 6. 标准 Telegram 风格纯文本请求：
curl -X POST "${baseUrl}/bot&lt;YOUR_BOT_TOKEN&gt;/sendMessage" \\
  -H "Content-Type: application/json" \\
  -d '{"chat_id": "&lt;YOUR_CHAT_ID&gt;", "text": "服务告警：CPU 负载过高！"}'</code></pre>
      </div>
    </div>
  </div>

  <script>
    // 清理此前可能遗留在本地浏览器的缓存，确保页面默认不回显任何秘钥
    try {
      localStorage.removeItem('notice_gw_token');
      localStorage.removeItem('notice_gw_chat_id');
    } catch (_) {}

    document.getElementById('testForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('submitBtn');
      const resBox = document.getElementById('resBox');
      const resContent = document.getElementById('resContent');

      btn.disabled = true;
      btn.innerText = '正在发送中...';
      resBox.style.display = 'block';
      resContent.innerText = '发送请求中，请稍候...';

      const title = document.getElementById('title').value.trim();
      const text = document.getElementById('text').value;
      const photo = document.getElementById('photo').value.trim();
      const immediate = document.getElementById('immediate').checked;
      const channel = document.getElementById('channel').value.trim();
      const fallback = document.getElementById('fallback').value.trim();
      const token = document.getElementById('token').value.trim();
      const chatId = document.getElementById('chat_id').value.trim();

      const pathPrefix = token ? ('/bot' + token) : '';
      let url = pathPrefix + (photo ? '/sendPhoto' : '/sendMessage');
      const queryParts = [];
      if (channel) queryParts.push('channel=' + encodeURIComponent(channel));
      if (fallback) queryParts.push('fallback=' + encodeURIComponent(fallback));
      if (chatId) queryParts.push('chat_id=' + encodeURIComponent(chatId));
      if (queryParts.length) url += '?' + queryParts.join('&');

      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      if (chatId) headers['x-chat-id'] = chatId;

      const bodyData = { text: text };
      if (photo) {
        bodyData.photo = photo;
        bodyData.caption = text;
      }
      if (title) bodyData.title = title;
      if (immediate) bodyData.immediate = immediate;
      if (chatId) bodyData.chat_id = chatId;

      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(bodyData)
        });

        const data = await resp.json();
        resContent.innerText = JSON.stringify(data, null, 2);
      } catch (err) {
        resContent.innerText = '请求失败: ' + err.message;
      } finally {
        btn.disabled = false;
        btn.innerText = '立即发送测试';
      }
    });
  </script>
</body>
</html>`;

    return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" }
    });
}
