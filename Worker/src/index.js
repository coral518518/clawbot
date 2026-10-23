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

// 核心改动 1：使用具名导出 export async function scheduled
export async function scheduled(event, env, ctx) {
    const targetUrl = env.BLITZ_APP_URL;
    if (!targetUrl) {
        console.error('Fatal: BLITZ_APP_URL is missing.');
        return;
    }

    let browser = null;

    try {
        browser = await puppeteer.launch(env.MY_BROWSER, {
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--lang=zh-CN,zh',
            ],
        });

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

        console.log(`Pinging target URL: ${targetUrl}`);
        const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        console.log(`Initial response status: ${response ? response.status() : 0}`);

        try {
            await page.waitForFunction(
                () => {
                    const text = (document.body && document.body.innerText) || '';
                    return !text.includes('Waking up') && !text.includes('Starting container') && !text.includes('503 Service Temporarily Unavailable');
                },
                { timeout: 12000, polling: 1000 }
            );
        } catch (_) { }

        let curX = getRandomInt(80, 180);
        let curY = getRandomInt(100, 220);
        await page.mouse.move(curX, curY);

        let targetX = getRandomInt(400, 700);
        let targetY = getRandomInt(300, 500);
        await humanMouseMove(page, curX, curY, targetX, targetY);
        curX = targetX;
        curY = targetY;

        const isSafeNode = await page.evaluate((x, y) => {
            const el = document.elementFromPoint(x, y);
            if (!el) return false;
            const tag = el.tagName.toUpperCase();
            if (['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'FORM', 'IFRAME'].includes(tag)) return false;
            if (el.closest('a') || el.closest('button')) return false;
            return true;
        }, curX, curY);

        if (isSafeNode) {
            await randomSleep(200, 400);
            await page.mouse.click(curX, curY, { delay: getRandomInt(60, 100) });
        }

        await randomSleep(300, 600);
        await page.evaluate(() => window.scrollBy({ top: 260, behavior: 'smooth' }));
        await randomSleep(500, 800);
        await page.evaluate(() => window.scrollBy({ top: -80, behavior: 'smooth' }));

        await randomSleep(3000, 5000);
        console.log('Keep-alive ping finished.');
    } catch (err) {
        console.error('Execution failure during keep-alive:', err.message);
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

export async function fetch(req, env, ctx) {
    const url = new URL(req.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const targetUrl = env.BLITZ_APP_URL || '';
    const isConfigured = Boolean(targetUrl && !targetUrl.includes('your-blitz-instance'));

    // 手动触发保活接口 (/trigger 或 /coral/trigger)
    if (pathname === '/trigger' || pathname === '/coral/trigger') {
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
        <p>边缘浏览器正在拉起会话并执行拟人操作，过程约需 10-20 秒。</p>
        <p>您可以通过命令行运行 <code>npm run tail</code> 实时查看详细保活日志。</p>
        <a href="/coral" class="btn">返回仪表盘</a>
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

    // 仅允许 /coral 访问仪表盘页面
    if (pathname === '/coral') {
        const acceptsHtml = req.headers.get('accept')?.includes('text/html');
        if (acceptsHtml) {
            return new Response(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>BlitzCloud 保活引擎 - Cloudflare Worker</title>
    <style>
        * { box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b1120; color: #f8fafc; min-height: 100vh; margin: 0; display: flex; align-items: center; justify-content: center; padding: 24px; }
        .container { background: #1e293b; border-radius: 20px; max-width: 580px; width: 100%; padding: 36px; box-shadow: 0 20px 40px -15px rgba(0,0,0,0.7); border: 1px solid #334155; }
        .header { display: flex; align-items: center; gap: 14px; margin-bottom: 24px; }
        .logo { width: 44px; height: 44px; background: linear-gradient(135deg, #f59e0b, #ef4444); border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 22px; }
        h1 { margin: 0; font-size: 22px; font-weight: 700; color: #fff; }
        .subtitle { color: #94a3b8; font-size: 13px; margin: 2px 0 0; }
        .status-badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
        .badge-green { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
        .badge-yellow { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
        .info-grid { display: grid; gap: 12px; margin: 24px 0; }
        .info-card { background: #0f172a; border-radius: 10px; padding: 14px 16px; border: 1px solid #334155; }
        .info-title { font-size: 12px; color: #64748b; text-transform: uppercase; font-weight: 600; margin-bottom: 6px; }
        .info-val { font-family: monospace; font-size: 14px; color: #e2e8f0; word-break: break-all; }
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
                <h1>BlitzCloud 保活引擎</h1>
                <div class="subtitle">Cloudflare Worker + Puppeteer Browser Rendering</div>
            </div>
            <span class="status-badge ${isConfigured ? 'badge-green' : 'badge-yellow'}">
                <span class="dot"></span>${isConfigured ? '运行就绪' : '待配置'}
            </span>
        </div>

        <div class="info-grid">
            <div class="info-card">
                <div class="info-title">保活目标状态 (Target Status)</div>
                <div class="info-val">${isConfigured ? '<span style="color:#34d399">● 目标服务已配置（地址已保护隐藏）</span>' : '<span style="color:#f87171">尚未配置目标网址</span>'}</div>
            </div>
            <div class="info-card">
                <div class="info-title">定时执行周期 (Cron Triggers)</div>
                <div class="info-val"><code>*/21 * * * *</code> (每 21 分钟自动执行一次拟人操作)</div>
            </div>
            <div class="info-card">
                <div class="info-title">浏览器渲染引擎 (Browser Binding)</div>
                <div class="info-val">MY_BROWSER (已绑定 Cloudflare 边缘 Chromium)</div>
            </div>
        </div>

        <div class="actions">
            <a href="/coral/trigger" class="btn btn-primary">🚀 手动执行一次保活测试</a>
        </div>

        <div class="tips">
            💡 <strong>使用提示：</strong><br>
            • 查看实时日志：在本地终端运行 <code>npm run tail</code> (或 <code>npx wrangler tail</code>)。<br>
            • 保活端点支持 <code>/trigger</code> 与 <code>/coral/trigger</code>。
        </div>
    </div>
</body>
</html>`, {
                headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
        }

        return new Response(JSON.stringify({
            service: 'blitz-keepalive',
            status: isConfigured ? 'active' : 'needs_configuration',
            cron: '*/21 * * * *'
        }, null, 2), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    }

    // 除了 /coral 页面与保活接口之外，其余路由统一返回 404
    return new Response('404 Not Found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
}

// 导出 default 对象适配 Cloudflare Module Worker
export default {
    scheduled,
    fetch,
};