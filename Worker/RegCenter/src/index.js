import puppeteer from '@cloudflare/puppeteer';

const getRandomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randomSleep = (minMs, maxMs) => new Promise((resolve) => setTimeout(resolve, getRandomInt(minMs, maxMs)));

function generateBezierCurve(p0, p1, p2, p3, steps) {
    const points = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const u = 1 - t;
        const tt = t * t;
        const uu = u * u;
        const uuu = uu * u;
        const ttt = tt * t;

        let x = uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x;
        let y = uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y;

        if (i > 0 && i < steps) {
            x += (Math.random() - 0.5) * 1.6;
            y += (Math.random() - 0.5) * 1.6;
        }
        points.push({ x: Math.round(x), y: Math.round(y) });
    }
    return points;
}

async function humanMouseMove(page, startX, startY, endX, endY) {
    const p1 = {
        x: startX + (endX - startX) * 0.25,
        y: startY + (endY - startY) * 0.25 + getRandomInt(-25, 25),
    };
    const p2 = {
        x: startX + (endX - startX) * 0.75,
        y: startY + (endY - startY) * 0.75 + getRandomInt(-25, 25),
    };

    const steps = getRandomInt(20, 30);
    const trajectory = generateBezierCurve({ x: startX, y: startY }, p1, p2, { x: endX, y: endY }, steps);

    for (const pt of trajectory) {
        await page.mouse.move(pt.x, pt.y);
        await new Promise((r) => setTimeout(r, getRandomInt(7, 15)));
    }
}

/**
 * 纯 HTTP 模式轻量级唤醒兜底（当 Cloudflare Browser Rendering 触发 429 限流或额度用尽时自动接管）
 * 直接解析休眠页面上的 blitz-wake token 并提交 GET 唤醒请求，0 消耗浏览器会话配额
 */
async function directHttpWake(targetUrl) {
    console.log(`[HTTP Wake Fallback] Checking target: ${targetUrl}`);
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
    };

    const res = await fetch(targetUrl, { headers });
    const html = await res.text();
    console.log(`[HTTP Wake Fallback] Response HTTP status: ${res.status}`);

    // 从页面提取隐藏表单中的 blitz-wake token
    const tokenMatch = html.match(/name=["']blitz-wake["']\s+value=["']([^"']+)["']/i) ||
        html.match(/value=["']([^"']+)["']\s+name=["']blitz-wake["']/i);

    if (tokenMatch && tokenMatch[1]) {
        const token = tokenMatch[1];
        console.log(`[HTTP Wake Fallback] Asleep page detected! Token: ${token.slice(0, 8)}...`);
        const wakeUrl = new URL(targetUrl);
        wakeUrl.searchParams.set('blitz-wake', token);

        console.log(`[HTTP Wake Fallback] Sending GET wake request: ${wakeUrl.toString()}`);
        const wakeRes = await fetch(wakeUrl.toString(), { headers });
        const wakeText = await wakeRes.text();
        const isWaking = wakeText.includes('waking up') || wakeText.includes('Starting container');
        console.log(`[HTTP Wake Fallback] Wake request returned status: ${wakeRes.status}, isWaking=${isWaking}`);

        // 轮询 3 次确认冷启动进展
        for (let i = 1; i <= 3; i++) {
            await randomSleep(3000, 4000);
            try {
                const checkRes = await fetch(targetUrl, { headers });
                const checkText = await checkRes.text();
                const stillAsleep = checkText.includes('This app is asleep');
                const stillWaking = checkText.includes('waking up') || checkText.includes('Starting container');
                console.log(`[HTTP Wake Fallback] Poll ${i}: status=${checkRes.status}, stillAsleep=${stillAsleep}, stillWaking=${stillWaking}`);
                if (!stillAsleep && !stillWaking && checkRes.status === 200) {
                    console.log(`[HTTP Wake Fallback] Container is online and healthy!`);
                    break;
                }
            } catch (pollErr) {
                console.warn(`[HTTP Wake Fallback] Poll warning:`, pollErr.message);
            }
        }
        return true;
    } else if (html.includes('This app is asleep')) {
        console.warn(`[HTTP Wake Fallback] Page is asleep but token was not found in regex.`);
        return false;
    } else {
        console.log(`[HTTP Wake Fallback] Project is already awake (status ${res.status}).`);
        return true;
    }
}

/**
 * 完整 Puppeteer 拟人浏览器保活（作为 HTTP 唤醒无法奏效时的终极兜底）
 */
async function browserKeepAlive(targetUrl, env) {
    if (!env.MY_BROWSER) {
        console.warn('[Keep-Alive] MY_BROWSER binding is not available. Skipping browser keep-alive.');
        return;
    }

    let browser = null;

    try {
        // 1. 尝试复用已有活跃浏览器会话，避免触发 429 并发上限限制
        try {
            if (typeof puppeteer.sessions === 'function') {
                const sessions = await puppeteer.sessions(env.MY_BROWSER);
                if (sessions && sessions.length > 0) {
                    for (const s of sessions) {
                        try {
                            console.log(`[Keep-Alive] Reusing existing active browser session: ${s.sessionId}`);
                            browser = await puppeteer.connect(env.MY_BROWSER, s.sessionId);
                            break;
                        } catch (connErr) {
                            console.warn(`[Keep-Alive] Reusing session ${s.sessionId} failed: ${connErr.message}`);
                        }
                    }
                }
            }
        } catch (sessErr) {
            console.warn(`[Keep-Alive] Session check error: ${sessErr.message}`);
        }

        // 2. 若无可用活跃会话，启动新浏览器实例
        if (!browser) {
            browser = await puppeteer.launch(env.MY_BROWSER, {
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-blink-features=AutomationControlled',
                    '--lang=zh-CN,zh',
                ],
            });
        }

        const page = await browser.newPage();
        const viewWidth = getRandomInt(1380, 1440);
        const viewHeight = getRandomInt(820, 880);

        await page.setViewport({
            width: viewWidth,
            height: viewHeight,
            deviceScaleFactor: 1,
            hasTouch: false,
            isLandscape: true,
            isMobile: false,
        });

        await page.evaluateOnNewDocument((vw, vh) => {
            const nativeToString = Function.prototype.toString;
            const nativeRegistry = new WeakMap();

            const patchToString = (fn, name, isGetter = false) => {
                const fnName = isGetter ? `get ${name}` : name;
                Object.defineProperty(fn, 'name', { value: fnName, configurable: true });
                Object.defineProperty(fn, 'length', { value: 0, configurable: true });
                nativeRegistry.set(fn, `function ${fnName}() { [native code] }`);
                return fn;
            };

            Function.prototype.toString = function () {
                if (nativeRegistry.has(this)) return nativeRegistry.get(this);
                return nativeToString.call(this);
            };
            nativeRegistry.set(Function.prototype.toString, 'function toString() { [native code] }');

            try {
                delete Object.getPrototypeOf(navigator).webdriver;
            } catch (_) { }

            const webdriverGetter = patchToString(function webdriver() { return undefined; }, 'webdriver', true);
            Object.defineProperty(Navigator.prototype, 'webdriver', {
                get: webdriverGetter,
                set: undefined,
                enumerable: true,
                configurable: true,
            });

            Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 8, enumerable: true });
            Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 8, enumerable: true });
            Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Win32', enumerable: true });
            Object.defineProperty(Navigator.prototype, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'], enumerable: true });

            const outerW = vw + 16;
            const outerH = vh + 79;
            Object.defineProperty(window, 'outerWidth', { get: () => outerW });
            Object.defineProperty(window, 'outerHeight', { get: () => outerH });
            Object.defineProperty(window.screen, 'availWidth', { get: () => 1920 });
            Object.defineProperty(window.screen, 'availHeight', { get: () => 1040 });
            Object.defineProperty(window.screen, 'width', { get: () => 1920 });
            Object.defineProperty(window.screen, 'height', { get: () => 1080 });

            const setupWebGL = (proto) => {
                const rawGetParam = proto.getParameter;
                proto.getParameter = patchToString(function getParameter(param) {
                    try {
                        if (param === 37445) return 'Google Inc. (NVIDIA)';
                        if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
                        return rawGetParam.apply(this, arguments);
                    } catch (e) {
                        throw new TypeError("Failed to execute 'getParameter' on 'WebGLRenderingContext': 1 argument required.");
                    }
                }, 'getParameter');
            };

            if (window.WebGLRenderingContext) setupWebGL(WebGLRenderingContext.prototype);
            if (window.WebGL2RenderingContext) setupWebGL(WebGL2RenderingContext.prototype);
        }, viewWidth, viewHeight);

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
        );
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
            'Sec-Ch-Ua': '"Google Chrome";v="130", "Chromium";v="130", "Not?A_Brand";v="24"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"',
        });

        console.log(`[Keep-Alive] Opening target URL: ${targetUrl}`);
        const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        console.log(`[Keep-Alive] Initial HTTP status: ${response ? response.status() : 0}`);

        await randomSleep(800, 1500);

        // 检查是否处于 blitz 休眠拦截页
        const sleepState = await page.evaluate(() => {
            const asleepCard = document.querySelector('[data-kind="asleep"]');
            const wakeForm = document.querySelector('form input[name="blitz-wake"]');
            const title = document.title || '';
            const bodyText = (document.body && document.body.innerText) || '';
            const isAsleep = Boolean(
                asleepCard ||
                wakeForm ||
                title.includes('asleep') ||
                bodyText.includes('This app is asleep') ||
                bodyText.includes('Wake it up')
            );
            return {
                isAsleep,
                title,
                hasWakeForm: Boolean(wakeForm),
            };
        });

        console.log(`[Keep-Alive] Page status: isAsleep=${sleepState.isAsleep}, title="${sleepState.title}"`);

        let curX = getRandomInt(100, 200);
        let curY = getRandomInt(120, 220);
        await page.mouse.move(curX, curY);

        if (sleepState.isAsleep) {
            console.log(`[Keep-Alive] Blitz instance is ASLEEP! Locating 'Wake it up' button...`);
            const wakeBtnHandle = await page.$('[data-kind="asleep"] button, form input[name="blitz-wake"] ~ p button, form button[type="submit"], button.btn');

            let clicked = false;
            if (wakeBtnHandle) {
                const box = await wakeBtnHandle.boundingBox();
                if (box) {
                    const btnX = box.x + box.width / 2 + getRandomInt(-6, 6);
                    const btnY = box.y + box.height / 2 + getRandomInt(-4, 4);
                    console.log(`[Keep-Alive] Simulating human Bezier mouse trajectory to button at (${Math.round(btnX)}, ${Math.round(btnY)})...`);
                    await humanMouseMove(page, curX, curY, btnX, btnY);
                    curX = btnX;
                    curY = btnY;
                    await randomSleep(200, 500);
                    console.log(`[Keep-Alive] Clicking 'Wake it up' button...`);
                    await page.mouse.click(btnX, btnY, { delay: getRandomInt(80, 140) });
                    clicked = true;
                } else {
                    console.log(`[Keep-Alive] Button bounding box not available, triggering handle.click()...`);
                    await wakeBtnHandle.click();
                    clicked = true;
                }
            }

            await randomSleep(1500, 2500);
            const stillAsleepCheck = await page.evaluate(() => {
                return Boolean(document.querySelector('[data-kind="asleep"]') || document.querySelector('input[name="blitz-wake"]'));
            });

            if (stillAsleepCheck) {
                console.log(`[Keep-Alive] Still on asleep page, executing form.submit() fallback...`);
                await page.evaluate(() => {
                    const form = document.querySelector('form input[name="blitz-wake"]')?.closest('form') || document.querySelector('form');
                    if (form) form.submit();
                });
            }

            // 等待容器冷启动完成
            console.log(`[Keep-Alive] Waiting for container cold start to complete...`);
            const maxWaitMs = 35000;
            const startWait = Date.now();

            while (Date.now() - startWait < maxWaitMs) {
                await randomSleep(2000, 3000);
                const check = await page.evaluate(() => {
                    const title = document.title || '';
                    const body = (document.body && document.body.innerText) || '';
                    const asleep = Boolean(document.querySelector('[data-kind="asleep"]') || body.includes('This app is asleep'));
                    const waking = Boolean(title.includes('waking up') || body.includes('waking up') || body.includes('Starting container'));
                    return { title, asleep, waking };
                });

                console.log(`[Keep-Alive] Polling container status: title="${check.title}", asleep=${check.asleep}, waking=${check.waking}`);

                if (!check.asleep && !check.waking) {
                    console.log(`[Keep-Alive] Cold start finished! Project is online.`);
                    break;
                }
            }
        } else {
            console.log(`[Keep-Alive] Project is already online (not asleep).`);
        }

        // 模拟真人交互活跃度
        await randomSleep(800, 1500);
        let targetX = getRandomInt(350, 650);
        let targetY = getRandomInt(250, 480);
        await humanMouseMove(page, curX, curY, targetX, targetY);

        const isSafeNode = await page.evaluate((x, y) => {
            const el = document.elementFromPoint(x, y);
            if (!el) return false;
            const tag = el.tagName.toUpperCase();
            if (['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'FORM', 'IFRAME'].includes(tag)) return false;
            if (el.closest('a') || el.closest('button')) return false;
            return true;
        }, targetX, targetY);

        if (isSafeNode) {
            await randomSleep(200, 400);
            await page.mouse.click(targetX, targetY, { delay: getRandomInt(60, 100) });
        }

        await randomSleep(400, 700);
        await page.evaluate(() => window.scrollBy({ top: 260, behavior: 'smooth' }));
        await randomSleep(500, 800);
        await page.evaluate(() => window.scrollBy({ top: -80, behavior: 'smooth' }));

        await randomSleep(3000, 5000);
        console.log('[Keep-Alive] Keep-alive ping finished successfully.');
    } catch (err) {
        console.error('[Keep-Alive] Execution failure during keep-alive:', err.message);

        if (err.message && (err.message.includes('429') || err.message.includes('Unable to create new browser') || err.message.includes('Rate limit exceeded'))) {
            console.log('[Keep-Alive] Cloudflare browser rate limited (429). Triggering direct HTTP token-wake fallback...');
            try {
                await directHttpWake(targetUrl);
                console.log('[Keep-Alive] Fallback direct HTTP wake completed.');
            } catch (fallbackErr) {
                console.error('[Keep-Alive] Fallback direct HTTP wake failed:', fallbackErr.message);
            }
        }
    } finally {
        if (browser) {
            try {
                await browser.close();
            } catch (closeErr) {
                console.error('Browser close error:', closeErr.message);
            }
        }
    }
}

/**
 * 针对 Cloudflare 免费额度深度优化的智能探活：
 * 1. 先用轻量 HTTP GET 探活（毫秒级、0 浏览器会话消耗）；
 * 2. 若实例正常在线（HTTP 200 且无休眠特征），直接退出，绝不调用昂贵的 Puppeteer；
 * 3. 若发现休眠（含 blitz-wake 表单），优先用 directHttpWake (0 浏览器配额) 快速唤醒；
 * 4. 仅在 HTTP 唤醒无法解决时，才启动 Puppeteer 无头浏览器。
 */
async function smartKeepAlive(targetUrl, env) {
    if (!targetUrl) return false;
    console.log(`[Smart Keep-Alive] Probing target: ${targetUrl}`);
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    };

    try {
        const probeRes = await fetch(targetUrl, { headers, signal: AbortSignal.timeout(5000) });
        const text = await probeRes.text();
        const lower = text.toLowerCase();
        const isAsleep = lower.includes('this app is asleep') ||
            lower.includes('data-kind="asleep"') ||
            lower.includes('blitz-wake') ||
            lower.includes('starting container') ||
            lower.includes('waking up');

        if (probeRes.ok && !isAsleep) {
            console.log(`[Smart Keep-Alive] Target ${targetUrl} is ALREADY ONLINE (HTTP ${probeRes.status}). Skipped browser launch, 0 quota used!`);
            return true;
        }

        console.log(`[Smart Keep-Alive] Target ${targetUrl} is ASLEEP (status ${probeRes.status}). Attempting zero-quota direct HTTP wake...`);
        const httpWakeSuccess = await directHttpWake(targetUrl);
        if (httpWakeSuccess) {
            console.log(`[Smart Keep-Alive] Direct HTTP wake SUCCEEDED for ${targetUrl}! Skipped browser launch.`);
            return true;
        }
    } catch (probeErr) {
        console.warn(`[Smart Keep-Alive] HTTP probe error for ${targetUrl}: ${probeErr.message}`);
    }

    // 终极兜底：仅在 HTTP 探活与唤醒均未能解决时，才启动 Puppeteer
    if (env.MY_BROWSER) {
        console.log(`[Smart Keep-Alive] Falling back to Puppeteer Browser Rendering for ${targetUrl}...`);
        await browserKeepAlive(targetUrl, env);
    }
}

// ==============================================================================
// 动态服务注册中心 (Service Registry) - 轻量持久化与内存缓存
// 针对 Cloudflare 免费层级深度优化：内存缓存 + 45s 写入防抖，杜绝超额
// ==============================================================================
const DEFAULT_STORAGE_API = 'https://d1.coral001.de5.net/redis';
const REGISTRY_STORAGE_KEY = 'clawbot_registry';
const NODE_EXPIRE_TTL_MS = 180000; // 3 分钟未上报心跳视为失联剔除
const REMOTE_FLUSH_INTERVAL_MS = 45000; // 写入远端防抖间隔（45 秒），每日写入量 < 2000 次

let memoryRegistry = null; // Map<url, NodeInfo>
let lastRemoteFetchTime = 0;
let lastRemoteFlushTime = 0;

/**
 * 获取注册中心最新活跃节点列表
 */
async function getRegistryNodes(env, forceRefresh = false) {
    const now = Date.now();
    // 1. 若内存缓存且距上次远端拉取小于 25 秒，直接使用内存缓存
    if (!forceRefresh && memoryRegistry && now - lastRemoteFetchTime < 25000) {
        pruneExpiredNodes(memoryRegistry);
        return Array.from(memoryRegistry.values());
    }

    // 2. 从远端 D1 / Redis REST 接口同步最新全网状态
    const storageApi = env.STORAGE_API_URL || DEFAULT_STORAGE_API;
    try {
        const res = await fetch(`${storageApi}/get/${REGISTRY_STORAGE_KEY}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
            },
            signal: AbortSignal.timeout(6000)
        });
        if (res.ok) {
            const data = await res.json();
            if (data && data.value) {
                let parsed = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
                if (typeof parsed === 'string') {
                    try { parsed = JSON.parse(parsed); } catch { }
                }
                if (Array.isArray(parsed)) {
                    if (!memoryRegistry) memoryRegistry = new Map();
                    for (const item of parsed) {
                        if (item && item.url) {
                            const existing = memoryRegistry.get(item.url);
                            // 保留更新的心跳时间戳，避免并发覆盖
                            if (!existing || (item.lastSeen || 0) >= (existing.lastSeen || 0)) {
                                memoryRegistry.set(item.url, item);
                            }
                        }
                    }
                }
            }
        }
    } catch (err) {
        console.warn(`[Registry] 拉取远端节点表告警 (${err.message})，回退至内存缓存`);
    }

    if (!memoryRegistry) memoryRegistry = new Map();
    lastRemoteFetchTime = now;
    pruneExpiredNodes(memoryRegistry);
    return Array.from(memoryRegistry.values());
}

/**
 * 剔除失联超期的节点
 */
function pruneExpiredNodes(map) {
    const now = Date.now();
    for (const [url, node] of map.entries()) {
        if (now - (node.lastSeen || 0) > NODE_EXPIRE_TTL_MS) {
            console.log(`[Registry] 节点 (${url}) 超过 3 分钟未上报，已被自动移出活跃集群`);
            map.delete(url);
        }
    }
}

/**
 * 持久化注册表状态至远端存储 (D1 / Redis REST)
 */
async function saveRegistryNodes(env) {
    const storageApi = env.STORAGE_API_URL || DEFAULT_STORAGE_API;
    const nodes = memoryRegistry ? Array.from(memoryRegistry.values()) : [];

    try {
        await fetch(`${storageApi}/set/${REGISTRY_STORAGE_KEY}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
            },
            body: JSON.stringify(nodes),
            signal: AbortSignal.timeout(6000)
        });
        lastRemoteFlushTime = Date.now();
    } catch (err) {
        console.warn(`[Registry] 持久化至远端失败: ${err.message}`);
    }
}

function scheduleRegistryFlush(env, ctx, immediate = false) {
    const flushPromise = saveRegistryNodes(env);
    if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(flushPromise);
    }
}

// 定时触发探活（可配置于 wrangler.toml [triggers] crons）
export async function scheduled(event, env, ctx) {
    const targets = new Set();
    if (env.BLITZ_APP_URL && !env.BLITZ_APP_URL.includes('your-blitz-instance')) {
        targets.add(env.BLITZ_APP_URL);
    }

    try {
        const registeredNodes = await getRegistryNodes(env);
        for (const node of registeredNodes) {
            if (node.url) targets.add(node.url);
        }
    } catch { }

    if (targets.size === 0) {
        console.log('[Scheduled] No targets configured or registered.');
        return;
    }

    console.log(`[Scheduled] Keep-alive cycle starting for ${targets.size} target(s): ${Array.from(targets).join(', ')}`);
    for (const target of targets) {
        try {
            await smartKeepAlive(target, env);
        } catch (err) {
            console.error(`[Scheduled] Error keeping alive ${target}:`, err.message);
        }
    }
}

export async function fetch(req, env, ctx) {
    const url = new URL(req.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const targetUrl = env.BLITZ_APP_URL || 'https://clawbot.coral.blitz.cloud';
    const isConfigured = Boolean(targetUrl && !targetUrl.includes('your-blitz-instance'));
    const prefix = (env.ROUTE_PREFIX || '/coral').replace(/\/+$/, '');

    // 跨域支持
    if (req.method === 'OPTIONS') {
        return new Response(null, {
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, x-api-key, Authorization',
            }
        });
    }

    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json; charset=utf-8'
    };

    // 密钥校验辅助函数
    const isAuthorized = () => {
        const expectedKey = env.API_KEY;
        if (!expectedKey) return true; // 未在 Worker 配置 API_KEY 则放行
        const incomingKey = req.headers.get('x-api-key') || url.searchParams.get('api_key');
        return incomingKey === expectedKey;
    };

    // 1. 动态服务注册与心跳接口: POST /coral/api/registry/heartbeat 或 POST /api/registry/heartbeat
    if ((pathname === `${prefix}/api/registry/heartbeat` || pathname === '/api/registry/heartbeat' ||
        pathname === `${prefix}/heartbeat` || pathname === '/heartbeat') && req.method === 'POST') {
        if (!isAuthorized()) {
            return new Response(JSON.stringify({ success: false, error: 'Unauthorized: invalid API key' }), {
                status: 401,
                headers: corsHeaders
            });
        }

        const body = await req.json().catch(() => ({}));
        let nodeUrl = (body.url || '').trim().replace(/\/+$/, '');

        // 若请求体未提供自身 URL，尝试从请求头反向识别
        if (!nodeUrl) {
            const origin = req.headers.get('origin');
            if (origin && !origin.includes('localhost') && !origin.includes('127.0.0.1')) {
                nodeUrl = origin.trim().replace(/\/+$/, '');
            }
        }

        if (!nodeUrl) {
            return new Response(JSON.stringify({
                success: false,
                error: '缺少节点 url 字段，请在节点环境配置 SELF_URL (如 https://clawbot-miget.yourdomain.com)'
            }), { status: 400, headers: corsHeaders });
        }

        await getRegistryNodes(env);

        const nodeInfo = {
            url: nodeUrl,
            priority: Number(body.priority) || 50,
            role: body.role || 'standby',
            status: body.status || 'RUNNING',
            hasContextToken: Boolean(body.hasContextToken),
            remainingQuota: Number(body.remainingQuota) ?? 10,
            lastSeen: Date.now(),
            clientIp: req.headers.get('cf-connecting-ip') || null
        };

        memoryRegistry.set(nodeUrl, nodeInfo);
        await saveRegistryNodes(env);

        const allNodes = Array.from(memoryRegistry.values());
        // 对端列表：剔除调用方自身的其他所有存活对端
        const peers = allNodes
            .map(n => n.url)
            .filter(u => u && u !== nodeUrl);

        return new Response(JSON.stringify({
            success: true,
            selfUrl: nodeUrl,
            peers,
            nodes: allNodes,
            count: allNodes.length,
            timestamp: Date.now()
        }, null, 2), { headers: corsHeaders });
    }

    // 2. 动态拉取对端列表接口: GET /coral/api/registry/peers 或 GET /api/registry/peers
    if ((pathname === `${prefix}/api/registry/peers` || pathname === '/api/registry/peers') && req.method === 'GET') {
        const exclude = (url.searchParams.get('exclude') || '').trim().replace(/\/+$/, '');
        const allNodes = await getRegistryNodes(env, true);
        const peers = allNodes.map(n => n.url).filter(u => u && u !== exclude);

        return new Response(JSON.stringify({
            success: true,
            peers,
            count: peers.length,
            timestamp: Date.now()
        }, null, 2), { headers: corsHeaders });
    }

    // 3. 查看全集群节点状态: GET /coral/api/registry/nodes 或 GET /api/registry/nodes 或 /api/registry/status
    if (pathname === `${prefix}/api/registry/nodes` || pathname === '/api/registry/nodes' ||
        pathname === `${prefix}/api/registry/status` || pathname === '/api/registry/status') {
        const allNodes = await getRegistryNodes(env, true);
        return new Response(JSON.stringify({
            success: true,
            count: allNodes.length,
            nodes: allNodes,
            timestamp: Date.now()
        }, null, 2), { headers: corsHeaders });
    }

    // 4. 节点优雅退出注销接口: POST /coral/api/registry/unregister 或 POST /api/registry/unregister
    if ((pathname === `${prefix}/api/registry/unregister` || pathname === '/api/registry/unregister') && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        const nodeUrl = (body.url || '').trim().replace(/\/+$/, '');
        if (nodeUrl && memoryRegistry && memoryRegistry.has(nodeUrl)) {
            memoryRegistry.delete(nodeUrl);
            await saveRegistryNodes(env);
            console.log(`[Registry] 节点 (${nodeUrl}) 已优雅注销下线`);
        }
        return new Response(JSON.stringify({ success: true, message: 'Node unregistered successfully' }), { headers: corsHeaders });
    }

    // 5. 核心高可用透明推送网关代理：POST /coral/api/send 或 POST /api/send (兼顾 GET /api/send)
    // 供 NoticGateway 或外部监控直接对接：自动路由至当前存活的 Master 节点；若 Master 502/休眠，毫秒级热切 Standby！
    if (pathname === `${prefix}/api/send` || pathname === '/api/send') {
        if (!isAuthorized()) {
            return new Response(JSON.stringify({ success: false, error: 'Unauthorized: invalid API key' }), {
                status: 401,
                headers: corsHeaders
            });
        }

        const registeredNodes = await getRegistryNodes(env);
        // 按 Master 优先、权重降序排列
        const candidates = [...registeredNodes];
        candidates.sort((a, b) => {
            const aMaster = a.role === 'master' ? 1 : 0;
            const bMaster = b.role === 'master' ? 1 : 0;
            if (aMaster !== bMaster) return bMaster - aMaster;
            return (b.priority || 0) - (a.priority || 0);
        });

        const targetUrls = candidates.map(c => c.url).filter(Boolean);
        if (targetUrls.length === 0 && env.BLITZ_APP_URL) {
            targetUrls.push(env.BLITZ_APP_URL);
        }

        if (targetUrls.length === 0) {
            return new Response(JSON.stringify({
                success: false,
                error: '集群中暂无已注册的在线节点，无法转发发送通知'
            }), { status: 503, headers: corsHeaders });
        }

        const rawBody = (req.method === 'POST' || req.method === 'PUT') ? await req.text().catch(() => '') : null;
        const forwardHeaders = new Headers(req.headers);
        forwardHeaders.delete('host');
        forwardHeaders.delete('cf-connecting-ip');
        forwardHeaders.delete('cf-ray');

        let lastRes = null;
        let lastError = null;

        for (let i = 0; i < targetUrls.length; i++) {
            const baseNodeUrl = targetUrls[i].replace(/\/+$/, '');
            const targetSendUrl = `${baseNodeUrl}${prefix}/api/send${url.search}`;

            try {
                const proxyRes = await fetch(targetSendUrl, {
                    method: req.method,
                    headers: forwardHeaders,
                    body: rawBody,
                    signal: AbortSignal.timeout(6000)
                });

                if (proxyRes.ok) {
                    const resData = await proxyRes.text();
                    return new Response(resData, {
                        status: proxyRes.status,
                        headers: {
                            'Content-Type': proxyRes.headers.get('content-type') || 'application/json',
                            'x-dispatched-node': baseNodeUrl,
                            'x-failover-attempt': String(i + 1)
                        }
                    });
                }

                console.warn(`[Proxy Send] 候选节点 ${i + 1}/${targetUrls.length} (${baseNodeUrl}) 返回 HTTP ${proxyRes.status}，自动尝试下一备用节点...`);
                // 后台异步触发一次唤醒
                if (ctx && typeof ctx.waitUntil === 'function') {
                    ctx.waitUntil(smartKeepAlive(baseNodeUrl, env));
                }
                lastRes = proxyRes;
            } catch (err) {
                console.warn(`[Proxy Send] 候选节点 ${i + 1}/${targetUrls.length} (${baseNodeUrl}) 连接异常 (${err.message})，自动尝试下一备用节点...`);
                lastError = err;
            }
        }

        if (lastRes) {
            const errText = await lastRes.text().catch(() => '');
            return new Response(errText || JSON.stringify({ success: false, error: `所有节点转发均异常 (HTTP ${lastRes.status})` }), {
                status: lastRes.status,
                headers: corsHeaders
            });
        }

        return new Response(JSON.stringify({
            success: false,
            error: `集群所有节点转发失败: ${lastError ? lastError.message : '未知网络错误'}`
        }), { status: 502, headers: corsHeaders });
    }

    // 6. 手动触发保活接口 (/trigger 或 /coral/trigger)
    if (pathname === '/trigger' || pathname === `${prefix}/trigger`) {
        if (!isConfigured) {
            return new Response(JSON.stringify({
                status: 'error',
                message: 'BLITZ_APP_URL is not configured yet. Please set it in wrangler.toml or via wrangler secret put BLITZ_APP_URL.'
            }, null, 2), {
                status: 400,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }

        ctx.waitUntil(scheduled(null, env, ctx));

        const acceptsHtml = req.headers.get('accept')?.includes('text/html');
        if (acceptsHtml) {
            return new Response(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>保活触发成功 - Blitz Cloud Keep-alive</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
        .card { background: #1e293b; border-radius: 16px; padding: 32px; max-width: 500px; width: 100%; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5); border: 1px solid #334155; text-align: center; }
        .success-icon { font-size: 48px; margin-bottom: 16px; }
        h1 { margin: 0 0 12px; font-size: 22px; color: #38bdf8; }
        p { color: #94a3b8; font-size: 14px; line-height: 1.6; margin: 8px 0; }
        .badge { display: inline-block; background: #065f46; color: #34d399; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; margin-bottom: 20px; }
        .btn { display: inline-block; background: #2563eb; color: #fff; text-decoration: none; padding: 10px 24px; border-radius: 8px; font-weight: 500; font-size: 14px; transition: background 0.2s; margin-top: 16px; }
        .btn:hover { background: #1d4ed8; }
        code { background: #0f172a; padding: 2px 6px; border-radius: 4px; color: #38bdf8; font-family: monospace; }
    </style>
</head>
<body>
    <div class="card">
        <div class="success-icon">🚀</div>
        <div class="badge">已触发后台执行</div>
        <h1>保活任务已在后台启动</h1>
        <p>系统已采用先 HTTP 探活与无头浏览器兜底策略，正在执行检测与保活。</p>
        <p>您可以通过命令行运行 <code>npm run tail</code> 实时查看详细保活日志。</p>
        <a href="${prefix}" class="btn">返回仪表盘</a>
    </div>
</body>
</html>`, {
                headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
        }

        return new Response(JSON.stringify({
            status: 'success',
            message: 'Manual keep-alive triggered in background.',
            timestamp: new Date().toISOString()
        }, null, 2), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    }

    // 6. 控制面板页面 (/coral)
    if (pathname === prefix || pathname === '/') {
        const acceptsHtml = req.headers.get('accept')?.includes('text/html');
        const registeredNodes = await getRegistryNodes(env);

        if (acceptsHtml) {
            const nodesRows = registeredNodes.length === 0
                ? `<tr><td colspan="4" style="padding: 16px; text-align: center; color: #64748b;">暂无已注册节点（请在各容器云配置 REGISTRY_URL）</td></tr>`
                : registeredNodes.map(n => {
                    const agoSec = Math.round((Date.now() - (n.lastSeen || 0)) / 1000);
                    const isMaster = n.role === 'master';
                    return `<tr style="border-bottom: 1px solid #1e293b;">
                        <td style="padding: 12px; font-family: monospace; color: #38bdf8; word-break: break-all;">${n.url}</td>
                        <td style="padding: 12px;"><span class="badge ${isMaster ? 'badge-master' : 'badge-standby'}">${isMaster ? '★ MASTER' : 'STANDBY'}</span></td>
                        <td style="padding: 12px; font-weight: 600; color: #f8fafc;">${n.priority || 50}</td>
                        <td style="padding: 12px; color: #94a3b8; font-size: 13px;">${agoSec}s 前</td>
                    </tr>`;
                }).join('');

            return new Response(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Clawbot 边缘服务中心 - Cloudflare Worker</title>
    <style>
        * { box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b1120; color: #f8fafc; min-height: 100vh; margin: 0; display: flex; align-items: center; justify-content: center; padding: 24px; }
        .container { background: #1e293b; border-radius: 20px; max-width: 680px; width: 100%; padding: 36px; box-shadow: 0 20px 40px -15px rgba(0,0,0,0.7); border: 1px solid #334155; }
        .header { display: flex; align-items: center; gap: 14px; margin-bottom: 24px; }
        .logo { width: 44px; height: 44px; background: linear-gradient(135deg, #38bdf8, #3b82f6); border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 22px; }
        h1 { margin: 0; font-size: 22px; font-weight: 700; color: #fff; }
        .subtitle { color: #94a3b8; font-size: 13px; margin: 2px 0 0; }
        .status-badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
        .badge-green { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
        .badge-yellow { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }
        .badge-master { background: rgba(56, 189, 248, 0.2); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.4); padding: 3px 8px; border-radius: 6px; font-size: 11px; font-weight: bold; }
        .badge-standby { background: rgba(148, 163, 184, 0.15); color: #94a3b8; border: 1px solid rgba(148, 163, 184, 0.3); padding: 3px 8px; border-radius: 6px; font-size: 11px; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
        .info-grid { display: grid; gap: 12px; margin: 20px 0; }
        .info-card { background: #0f172a; border-radius: 10px; padding: 14px 16px; border: 1px solid #334155; }
        .info-title { font-size: 12px; color: #64748b; text-transform: uppercase; font-weight: 600; margin-bottom: 6px; }
        .info-val { font-family: monospace; font-size: 14px; color: #e2e8f0; word-break: break-all; }
        .table-wrap { background: #0f172a; border-radius: 12px; border: 1px solid #334155; overflow: hidden; margin-top: 20px; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        th { background: #1e293b; padding: 10px 12px; text-align: left; color: #94a3b8; font-weight: 600; font-size: 12px; }
        .actions { display: flex; gap: 12px; margin-top: 24px; }
        .btn { flex: 1; text-align: center; padding: 12px 18px; border-radius: 10px; font-size: 14px; font-weight: 600; text-decoration: none; cursor: pointer; border: none; transition: all 0.2s; }
        .btn-primary { background: #3b82f6; color: white; }
        .btn-primary:hover { background: #2563eb; }
        .tips { margin-top: 24px; padding-top: 18px; border-top: 1px solid #334155; font-size: 12px; color: #64748b; line-height: 1.6; }
        code { background: #0f172a; padding: 2px 6px; border-radius: 4px; color: #38bdf8; font-family: monospace; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">⚡</div>
            <div style="flex: 1;">
                <h1>Clawbot 边缘服务中心</h1>
                <div class="subtitle">动态服务注册与发现 · 智能低消耗保活引擎</div>
            </div>
            <span class="status-badge ${registeredNodes.length > 0 ? 'badge-green' : 'badge-yellow'}">
                <span class="dot"></span>${registeredNodes.length > 0 ? `集群在线 (${registeredNodes.length} 节点)` : '待节点接入'}
            </span>
        </div>

        <div class="info-grid">
            <div class="info-card">
                <div class="info-title">注册中心接入地址 (REGISTRY_URL)</div>
                <div class="info-val">${url.origin}${prefix}/api/registry/heartbeat</div>
            </div>
            <div class="info-card">
                <div class="info-title">Cloudflare 免费层级保护模式</div>
                <div class="info-val">轻量 HTTP 预探活 (0 浏览器会话消耗) + 45s 持久化防抖节流</div>
            </div>
        </div>

        <div style="margin-top: 24px; font-size: 14px; font-weight: 600; color: #e2e8f0; display: flex; justify-content: space-between; align-items: center;">
            <span>🌐 动态发现的集群节点池</span>
            <span style="font-size: 12px; color: #64748b;">(3 分钟无心跳自动移出)</span>
        </div>

        <div class="table-wrap">
            <table>
                <thead>
                    <tr>
                        <th>节点 URL</th>
                        <th>角色</th>
                        <th>权重</th>
                        <th>最后心跳</th>
                    </tr>
                </thead>
                <tbody>
                    ${nodesRows}
                </tbody>
            </table>
        </div>

        <div class="actions">
            <a href="${prefix}/trigger" class="btn btn-primary">🚀 手动执行一次保活检测</a>
        </div>

        <div class="tips">
            💡 <strong>极简部署指南：</strong><br>
            • 在新云平台部署时，仅需添加 <code>REGISTRY_URL=${url.origin}${prefix}/api/registry</code> 与 <code>SELF_URL=https://当前节点网址</code>。<br>
            • 其他所有现有容器将在 60 秒内通过注册中心全自动发现新节点并完成热备组网，零人工配置！
        </div>
    </div>
</body>
</html>`, {
                headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
        }

        return new Response(JSON.stringify({
            service: 'clawbot-edge-gateway',
            registryNodes: registeredNodes,
            count: registeredNodes.length,
            feature: 'dynamic-service-discovery-and-smart-keepalive'
        }, null, 2), {
            headers: corsHeaders
        });
    }

    // 其余未匹配路由统一返回 404
    return new Response('404 Not Found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
}

export default {
    scheduled,
    fetch,
};
