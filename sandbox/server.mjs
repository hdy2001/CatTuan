// CatTuan 沙箱：一个独立 profile 的无头 Chromium（与你日常浏览器隔离），替 agent 搜必应、读网页。
// - 只读：不下载文件、不提交表单、不访问内网。所有访问串行、带缓存，两次页面访问至少隔几秒。
// 用法：node sandbox/server.mjs   →  http://127.0.0.1:8660
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import dns from 'node:dns/promises';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = process.env.SANDBOX_PROFILE || path.join(DIR, 'profile');
const PORT = Number(process.env.SANDBOX_PORT || 8660);
// 国外站点要走代理（scripts/start-sandbox.sh 从 agent-home/.env 读 HTTPS_PROXY）。
const PROXY = process.env.SANDBOX_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
// 国内站点直连（走代理常被断开，比如 .edu.cn）；深度搜索读网页时也一样。
const DIRECT = ['cn', 'baidu.com', 'zhihu.com', 'qq.com', 'sohu.com', '163.com', 'douban.com', 'csdn.net', 'jianshu.com', 'bing.com', 'sina.com.cn'];
const GAP = 5_000; // 两次页面访问的最小间隔

// 用 Playwright 缓存里的 Chrome for Testing（playwright-core 1.63.0 ↔ chromium-1243）。
// 优先用 sandbox/chrome/ 下的副本：它的 Info.plist 补了蓝牙用途说明并重新签名。原版缺这项，
// Google 登录页尝试蓝牙通行密钥时会被 macOS 隐私保护（TCC）直接杀掉 —— 表现为登录窗口「闪退」。
// 生成副本：scripts/patch-sandbox-chrome.sh。Linux 服务器上用 deploy/setup.sh 装的那份（x64 / arm64）。
function chromePath() {
  if (process.env.SANDBOX_CHROME) return process.env.SANDBOX_CHROME;
  const patched = path.join(DIR, 'chrome/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  if (fs.existsSync(patched)) return patched;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
  const dir = fs.existsSync(root) && fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
  return dir && ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-linux64/chrome', 'chrome-linux-arm64/chrome', 'chrome-linux/chrome']
    .map((p) => path.join(root, dir, p)).find((p) => fs.existsSync(p));
}
const CHROME = chromePath();

// 无头模式的 UA 带 "HeadlessChrome"，不少网站会拦。换成同版本的普通 Chrome UA；系统写真实的，免得和 navigator.platform 对不上。
function chromeMajor() {
  try { return /(\d+)\./.exec(execFileSync(CHROME, ['--version'], { encoding: 'utf8', timeout: 15_000 }))[1]; } catch { return '140'; }
}
const UA_OS = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
const UA = `Mozilla/5.0 (${UA_OS}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor()}.0.0.0 Safari/537.36`;

class SandboxError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    Object.assign(this, { status, code, extra });
  }
}

// ---------- 小工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(250);
  }
  return false;
}

// ---------- 串行队列 / 缓存 / 限速 ----------
// 所有页面操作都排队执行，同一时间只做一件事。
let queue = Promise.resolve();
function serial(fn, ms = 80_000) {
  const run = () => {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('沙箱操作超时')), ms); });
    return Promise.race([fn(), timeout]).finally(() => clearTimeout(timer));
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

const memo = new Map();
async function remember(key, ttl, load) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await load();
  memo.set(key, { at: Date.now(), value });
  return value;
}

const lastVisit = {};
async function pace(platform) {
  const wait = (lastVisit[platform] || 0) + GAP - Date.now();
  if (wait > 0) await sleep(wait);
  lastVisit[platform] = Date.now();
}

// ---------- 浏览器：无头，一个 profile ----------
const B = { mode: 'off', ctx: null }; // mode: off | headless
const pages = new Map(); // 用途 → 复用的无头页面
let launching = null;

function launchOptions() {
  return {
    executablePath: CHROME, headless: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
    // 去掉自动化标记（navigator.webdriver、「受自动测试软件控制」提示条），不少网站会拦。
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled', `--user-agent=${UA}`],
    ...(PROXY && { proxy: { server: PROXY, bypass: ['localhost', '127.0.0.1', ...DIRECT.flatMap((h) => [h, `*.${h}`])].join(',') } }),
  };
}

function attach(ctx) {
  Object.assign(B, { ctx, mode: 'headless' });
  ctx.on('close', () => {
    if (B.ctx !== ctx) return;
    Object.assign(B, { ctx: null, mode: 'off' });
    pages.clear();
  });
}

async function headless() {
  if (B.ctx) return B.ctx;
  launching ??= chromium.launchPersistentContext(PROFILE, launchOptions())
    .then((ctx) => { attach(ctx); return ctx; })
    .finally(() => { launching = null; });
  return launching;
}

// ---------- 实时画面：把沙箱浏览器在做什么推给 App 的「浏览器」视图（仿 Claude Cowork） ----------
// 动作文字和每一步的关键帧：有人订阅 /live 就推。连续画面（CDP screencast）只在 App 有人看着时（framesOn）才推，
// 这时也放开图片加载，画面才完整；没人看时照旧不加载图片，省流量。
const live = { watchers: new Set(), framesOn: false, task: null, platform: null, subject: '', cdp: null, page: null, lastFrameAt: 0 };

function emit(ev) {
  if (!live.watchers.size) return;
  const frame = `data: ${JSON.stringify({ at: Date.now(), task: live.task, platform: live.platform, ...ev }, cleanStrings)}\n\n`;
  for (const res of live.watchers) res.write(frame);
}
const act = (text) => emit({ type: 'action', text });

function shortUrl(url) {
  try {
    const u = new URL(url);
    return decodeURIComponent(`${u.host.replace(/^www\./, '')}${u.pathname}${u.search}`).slice(0, 80);
  } catch { return String(url).slice(0, 80); }
}

async function keyframe(page, text) {
  if (!live.watchers.size || !page || page.isClosed()) return;
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 4_000 });
    emit({ type: 'frame', key: true, text, url: page.url(), data: buf.toString('base64') });
  } catch {}
}

async function stopScreencast() {
  const { cdp } = live;
  Object.assign(live, { cdp: null, page: null });
  if (cdp) {
    await cdp.send('Page.stopScreencast').catch(() => {});
    await cdp.detach().catch(() => {});
  }
}

async function screencast(page) {
  if (!live.framesOn || live.page === page) return;
  await stopScreencast();
  try {
    const cdp = await page.context().newCDPSession(page);
    cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      if (Date.now() - live.lastFrameAt < 250) return; // 最多 4 帧/秒
      live.lastFrameAt = Date.now();
      emit({ type: 'frame', url: page.url(), data });
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 50, maxWidth: 1000, maxHeight: 760, everyNthFrame: 1 });
    Object.assign(live, { cdp, page });
  } catch {}
}

// 一次沙箱操作 = 一段直播：标上属于哪个任务、用的哪个页面，结束时补一张关键帧。
async function withLive(task, platform, label, subject, fn) {
  Object.assign(live, { task: task || null, platform, subject: subject || '' });
  emit({ type: 'start', text: label });
  try {
    return await fn();
  } finally {
    await keyframe(pages.get(platform), '这一步完成');
    emit({ type: 'end' });
    await stopScreencast();
    Object.assign(live, { task: null, platform: null, subject: '' });
  }
}

// 无头页面平时不加载图片 / 视频 / 字体：只要接口数据，省流量。App 有人看实时画面时放开，画面才完整。
const BLOCK = new Set(['image', 'media', 'font']);
async function platformPage(platform) {
  const ctx = await headless();
  let page = pages.get(platform);
  if (!page || page.isClosed()) {
    page = await ctx.newPage();
    await page.route('**/*', (r) => (BLOCK.has(r.request().resourceType()) && !live.framesOn ? r.abort() : r.continue()));
    pages.set(platform, page);
  }
  if (live.platform === platform) await screencast(page);
  return page;
}

// 跳转时页面自己又跳了一次（访客验证、重定向）会报 ERR_ABORTED，等新页面加载完即可。
async function goto(page, url) {
  act(`打开 ${shortUrl(url)}`);
  try {
    return await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (e) {
    if (!/ERR_ABORTED|interrupted by another navigation/.test(e.message)) throw e;
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
    return null;
  }
}

// ---------- 网页搜索 / 阅读（深度搜索用）：真实浏览器里搜必应、读网页，结果和普通用户看到的一样，还能实时直播 ----------
// 直接用 HTTP 抓必应会拿到降级的结果（只匹配第一个字），所以走沙箱浏览器。只读：不下载文件、不提交表单、不访问内网。
const WEB_TTL = 30 * 60_000;

function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new SandboxError(400, 'bad_url', `网址不对：${raw}`); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new SandboxError(400, 'bad_url', '只支持 http(s) 网址');
  // 系统解析偶尔对正常域名报 ENOTFOUND（本机就遇到过），再直接查一次 DNS；只有确实解析到内网地址才拦。
  let addrs = await dns.lookup(u.hostname, { all: true }).then((r) => r.map((x) => x.address)).catch(() => []);
  if (!addrs.length) addrs = await dns.resolve4(u.hostname).catch(() => []);
  if (net.isIP(u.hostname)) addrs = [u.hostname];
  if (addrs.some(isPrivateIp)) throw new SandboxError(400, 'blocked_url', '不能访问内网或本机地址');
  return u;
}

// 必应结果链接有时是 bing.com/ck/a?...&u=a1<base64url> 的跳转，还原成真实网址。
function unwrapBing(href) {
  try {
    const u = new URL(href);
    const enc = u.hostname.endsWith('bing.com') && u.pathname.startsWith('/ck/') && u.searchParams.get('u');
    if (enc && enc.startsWith('a1')) return Buffer.from(enc.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {}
  return href;
}

// 冷启动第一次常常还没渲染出结果：空结果重试一次，空结果不缓存。
async function webSearch(q) {
  const key = `web:q:${q}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < WEB_TTL) return hit.value;
  let rows = await webSearchOnce(q);
  if (!rows.length) { act('结果没加载出来，再搜一次'); rows = await webSearchOnce(q); }
  if (rows.length) memo.set(key, { at: Date.now(), value: rows });
  return rows;
}

function webSearchOnce(q) {
  return (async () => {
    const page = await platformPage('web');
    await pace('web');
    act(`在必应搜索「${q}」`);
    await goto(page, `https://cn.bing.com/search?q=${encodeURIComponent(q)}&ensearch=0`);
    await page.waitForSelector('li.b_algo', { timeout: 10_000 }).catch(() => {});
    await keyframe(page, `必应搜索：${q}`);
    const rows = await page.evaluate(() => [...document.querySelectorAll('li.b_algo')].slice(0, 10).map((li) => {
      const a = li.querySelector('h2 a');
      const snip = li.querySelector('.b_caption p, .b_lineclamp2, .b_lineclamp3, .b_lineclamp4, .b_paractl, .b_algoSlug');
      return { title: (a?.innerText || '').trim(), url: a?.href || '', snippet: (snip?.innerText || '').trim().slice(0, 260) };
    }).filter((r) => r.url && r.title));
    act(`拿到 ${rows.length} 条结果`);
    return rows.map((r) => ({ ...r, url: unwrapBing(r.url) }));
  })();
}

function webRead(url) {
  return remember(`web:read:${url}`, WEB_TTL, async () => {
    const u = await assertPublicUrl(url);
    if (/\.(pdf|zip|rar|7z|exe|dmg|apk|epub|mobi)$/i.test(u.pathname)) {
      return { url, title: '', text: '', note: '这是文件下载链接，沙箱不下载文件' };
    }
    const page = await platformPage('web');
    act(`打开并阅读 ${shortUrl(url)}`);
    // 只等开始返回页面，再等正文渲染出来：有的站点第三方脚本很慢，等 DOMContentLoaded 会一直超时（北大图书馆就是）。
    let res = null;
    act(`打开 ${shortUrl(url)}`);
    try {
      res = await page.goto(url, { waitUntil: 'commit', timeout: 25_000 });
    } catch (e) {
      if (/download/i.test(e.message)) return { url, title: '', text: '', note: '这个链接会触发文件下载，沙箱不下载文件' };
      if (!/ERR_ABORTED|interrupted by another navigation/.test(e.message)) {
        return { url, title: '', text: '', note: `打不开：${e.message.split('\n')[0].slice(0, 80)}` };
      }
    }
    await until(async () => (await page.evaluate(() => document.body?.innerText?.length || 0).catch(() => 0)) > 300, 15_000);
    const data = await page.evaluate(() => {
      // 正文容器取文字最多的那个；都太短（选错了空容器）就用整页。
      const cands = [...document.querySelectorAll('article, main, [role=main], .article, .article-content, .post-content, #content, .content')];
      const best = cands.sort((x, y) => (y.innerText || '').length - (x.innerText || '').length)[0];
      const pick = best && (best.innerText || '').length >= 200 ? best : document.body;
      const text = (pick?.innerText || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      return { title: document.title, text: text.slice(0, 15_000), finalUrl: location.href };
    });
    await keyframe(page, `读完：${data.title || shortUrl(url)}`);
    const note = data.text.length < 80 ? '页面没读到正文（可能要登录，或者是靠脚本慢慢加载的网站），换个来源' : undefined;
    return { url, finalUrl: data.finalUrl, status: res?.status() ?? null, title: data.title, text: data.text, ...(note && { note }) };
  });
}

// JS 的 .slice() 按 UTF-16 截字符串，可能把 emoji 切成半个（孤立代理项 \ud83d）。
// 清理不完整的 Unicode 字符，确保模型请求、JSON 与持久化内容均可正常编码。
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const cleanStrings = (_, v) => (typeof v === 'string' ? v.replace(LONE_SURROGATE, '') : v);

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj, cleanStrings));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(url.searchParams);
  try {
    if (url.pathname === '/health') return send(res, 200, { ok: true, mode: B.mode });
    if (url.pathname === '/live') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello', task: live.task, platform: live.platform, framesOn: live.framesOn })}\n\n`);
      live.watchers.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      req.on('close', () => { clearInterval(ping); live.watchers.delete(res); });
      return;
    }
    if (url.pathname === '/live/frames') {
      live.framesOn = q.on === '1';
      if (!live.framesOn) await stopScreencast();
      else if (live.platform && pages.get(live.platform)) await screencast(pages.get(live.platform));
      return send(res, 200, { framesOn: live.framesOn });
    }
    const liveTask = /^t_[a-z0-9]+$/.test(req.headers['x-cattuan-task'] || '') ? req.headers['x-cattuan-task'] : null;
    if (url.pathname === '/web/search') {
      const kw = (q.q || '').trim().slice(0, 120);
      if (!kw) return send(res, 400, { error: 'bad_request', message: 'web/search 需要 q' });
      return send(res, 200, { results: await serial(() => withLive(liveTask, 'web', `网页搜索 · 「${kw}」`, kw, () => webSearch(kw))) });
    }
    if (url.pathname === '/web/read') {
      const target = String(q.url || '').trim();
      if (!target) return send(res, 400, { error: 'bad_request', message: 'web/read 需要 url' });
      return send(res, 200, await serial(() => withLive(liveTask, 'web', `阅读网页 · ${shortUrl(target)}`, target, () => webRead(target))));
    }
    return send(res, 404, { error: 'not_found' });
  } catch (e) {
    if (e instanceof SandboxError) return send(res, e.status, { error: e.code, message: e.message, ...e.extra });
    console.error(e);
    return send(res, 500, { error: 'failed', message: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`CatTuan sandbox → http://127.0.0.1:${PORT}  (profile ${PROFILE}${PROXY ? `, proxy ${PROXY}` : ''})`));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { try { await B.ctx?.close(); } catch {} process.exit(0); });
}
