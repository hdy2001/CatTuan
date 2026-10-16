// CatTuan 沙箱：一个独立 profile 的 Chromium（与你日常浏览器隔离），替 agent 只读访问偶像官方号。
// - 平时无头运行。GET /login?platform=x 时关掉无头实例，用同一个 profile 开一个可见窗口，由你自己登录
//   （扫码 / 输密码都在窗口里完成，沙箱从不读写账号密码）；关掉窗口或 GET /login/done 后回到无头。
// - 只读：搜账号、拉时间线里的图片，不发帖、不点赞、不关注。所有访问串行、带缓存，同一平台两次访问至少隔几秒。
// 用法：node sandbox/server.mjs   →  http://127.0.0.1:8660
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import dns from 'node:dns/promises';
import net from 'node:net';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = process.env.SANDBOX_PROFILE || path.join(DIR, 'profile');
const PORT = Number(process.env.SANDBOX_PORT || 8660);
// X / Instagram / Weverse 在国内要走代理（scripts/start-sandbox.sh 从 ~/.hermes/.env 读 HTTPS_PROXY）；微博、B 站直连。
const PROXY = process.env.SANDBOX_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
// 国内站点直连（走代理常被断开，比如 .edu.cn）；深度搜索读网页时也一样。
const DIRECT = ['cn', 'baidu.com', 'zhihu.com', 'qq.com', 'sohu.com', '163.com', 'douban.com', 'csdn.net', 'jianshu.com', 'bing.com',
  'weibo.cn', 'weibo.com', 'sina.com.cn', 'sinaimg.cn', 'xiaohongshu.com', 'xhscdn.com', 'bilibili.com', 'hdslb.com', 'biliapi.net', 'biliapi.com', 'bilivideo.com', 'bilivideo.cn'];
const DAY = 86_400_000;
const TIMELINE_TTL = 10 * 60_000;
const SEARCH_TTL = 60 * 60_000;
const GAP = 5_000; // 同一平台两次页面访问的最小间隔

// 用 Playwright 缓存里的 Chrome for Testing（playwright-core 1.63.0 ↔ chromium-1243）。
// 优先用 sandbox/chrome/ 下的副本：它的 Info.plist 补了蓝牙用途说明并重新签名。原版缺这项，
// Google 登录页尝试蓝牙通行密钥时会被 macOS 隐私保护（TCC）直接杀掉 —— 表现为登录窗口「闪退」。
// 生成副本：scripts/patch-sandbox-chrome.sh
function chromePath() {
  if (process.env.SANDBOX_CHROME) return process.env.SANDBOX_CHROME;
  const patched = path.join(DIR, 'chrome/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  if (fs.existsSync(patched)) return patched;
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const dir = fs.existsSync(root) && fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
  const exe = dir && path.join(root, dir, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  return exe && fs.existsSync(exe) ? exe : undefined;
}
const CHROME = chromePath();

// 无头模式的 UA 带 "HeadlessChrome"，B 站会直接 -352。换成同版本的普通 Chrome UA，和登录窗口里的一致。
function chromeMajor() {
  try { return /(\d+)\./.exec(execFileSync(CHROME, ['--version'], { encoding: 'utf8', timeout: 15_000 }))[1]; } catch { return '140'; }
}
const UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor()}.0.0.0 Safari/537.36`;

// session：判断「已登录」的 cookie。optional：不登录也能读（登录只用来躲风控）。
const PLATFORMS = {
  weibo: { label: '微博', note: '访客模式，免登录' },
  x: {
    label: 'X', loginUrl: 'https://x.com/i/flow/login',
    session: (c) => c.name === 'auth_token' && /(^|\.)(x|twitter)\.com$/.test(c.domain),
  },
  instagram: {
    label: 'Instagram', loginUrl: 'https://www.instagram.com/accounts/login/',
    session: (c) => c.name === 'sessionid' && /(^|\.)instagram\.com$/.test(c.domain),
  },
  weverse: {
    label: 'Weverse', loginUrl: 'https://account.weverse.io/zh-cn/login?client_id=weverse&redirect_uri=https%3A%2F%2Fweverse.io%2F&redirect_method=COOKIE',
    session: (c) => /access_token/i.test(c.name) && /(^|\.)weverse\.io$/.test(c.domain),
    note: '需要登录，并在 Weverse 里加入对应社区',
  },
  bilibili: {
    label: 'B 站', loginUrl: 'https://passport.bilibili.com/login', optional: true,
    session: (c) => c.name === 'SESSDATA' && /(^|\.)bilibili\.com$/.test(c.domain),
    note: '免登录可读，被风控时再登录',
  },
  // 小红书网页版不登录直接跳登录页；访客只有 a1/webId 等 cookie，登录后才有 web_session。
  xiaohongshu: {
    label: '小红书', loginUrl: 'https://www.xiaohongshu.com/login',
    session: (c) => c.name === 'web_session' && /(^|\.)xiaohongshu\.com$/.test(c.domain),
    note: '需要登录；每条笔记取封面图',
  },
};

class SandboxError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    Object.assign(this, { status, code, extra });
  }
}
const loginRequired = (platform, why = '还没登录（或登录已过期）') => {
  const { label } = PLATFORMS[platform];
  return new SandboxError(401, 'login_required',
    `${label} ${why}：请在喵团 App「+」→「社媒账号」点「登录 ${label}」，在弹出的窗口里自己登录（建议用小号），登好后关掉窗口再试。`, { platform });
};
const loginBusy = () => new SandboxError(409, 'login_in_progress',
  `正在登录 ${PLATFORMS[B.platform]?.label || ''}：等登录窗口关掉（或在 App 里点「完成」）后再试。`, { platform: B.platform });

// ---------- 小工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ts) => new Date(ts).toISOString();
const stripHtml = (s) => String(s || '').replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();

async function until(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(250);
  }
  return false;
}

// 深度遍历 JSON；visit 返回 false 时不再往下走（找到目标对象后停下，免得把嵌套的转发/引用重复算一遍）。
function walk(node, visit) {
  if (Array.isArray(node)) { for (const v of node) walk(v, visit); return; }
  if (!node || typeof node !== 'object') return;
  if (visit(node) === false) return;
  for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v, visit);
}

// 页面内嵌的 <script type="application/json">（Instagram 等服务端渲染时把首屏数据放在这里）。
function embeddedJson(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try { out.push(JSON.parse(m[1])); } catch {}
  }
  return out;
}

// ---------- 串行队列 / 缓存 / 限速 ----------
// 所有页面操作和无头⇄登录窗口的切换都排队执行，同一时间只做一件事。
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

// 时间线：同一账号 10 分钟内只真正访问一次（至少拉 7 天），更短的时间窗直接从缓存里截。
async function timeline(platform, uid, days, load) {
  const key = `${platform}:tl:${uid}`;
  let hit = memo.get(key);
  if (!(hit && hit.value.window >= days && Date.now() - hit.at < TIMELINE_TTL)) {
    const window = Math.max(days, 7);
    const r = await load(window);
    const { posts, note } = Array.isArray(r) ? { posts: r } : r;
    posts.sort((a, b) => b.ts - a.ts);
    hit = { at: Date.now(), value: { window, posts, note } };
    memo.set(key, hit);
  }
  const { posts, note } = hit.value;
  return { posts: posts.filter((p) => p.ts >= Date.now() - days * DAY), ...(note && { note }) };
}

const lastVisit = {};
async function pace(platform) {
  const wait = (lastVisit[platform] || 0) + GAP - Date.now();
  if (wait > 0) await sleep(wait);
  lastVisit[platform] = Date.now();
}

// ---------- 浏览器：无头 ⇄ 登录窗口（同一个 profile，同一时间只能开一个） ----------
const B = { mode: 'off', ctx: null, platform: null }; // mode: off | headless | login
const pages = new Map(); // platform → 复用的无头页面
const stale = new Set(); // 有登录 cookie、但读的时候被踢回登录页的平台
let launching = null;

function launchOptions(headless) {
  return {
    executablePath: CHROME, headless, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
    viewport: headless ? { width: 1280, height: 900 } : null,
    serviceWorkers: 'block',
    // 去掉自动化标记（navigator.webdriver、「受自动测试软件控制」提示条），否则 X 登录和 B 站都会拦。
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled', ...(headless ? [`--user-agent=${UA}`] : ['--window-size=1100,860'])],
    ...(PROXY && { proxy: { server: PROXY, bypass: ['localhost', '127.0.0.1', ...DIRECT.flatMap((h) => [h, `*.${h}`])].join(',') } }),
  };
}

function attach(ctx, mode) {
  Object.assign(B, { ctx, mode });
  ctx.on('close', () => {
    if (B.ctx !== ctx) return;
    Object.assign(B, { ctx: null, mode: 'off', platform: null });
    pages.clear();
    if (mode === 'login') afterLogin(); // 用户直接退出了浏览器（Cmd+Q）
  });
}

async function headless() {
  if (B.mode === 'login') throw loginBusy();
  if (B.ctx) return B.ctx;
  launching ??= chromium.launchPersistentContext(PROFILE, launchOptions(true))
    .then((ctx) => { attach(ctx, 'headless'); return ctx; })
    .finally(() => { launching = null; });
  return launching;
}

async function closeBrowser() {
  const ctx = B.ctx;
  if (!ctx) return;
  Object.assign(B, { ctx: null, mode: 'off', platform: null });
  pages.clear();
  await ctx.close().catch(() => {});
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

// 一次沙箱操作 = 一段直播：标上属于哪个任务、哪个平台，结束时补一张关键帧。
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
    if (platform !== 'weibo') {
      await page.route('**/*', (r) => (BLOCK.has(r.request().resourceType()) && !live.framesOn ? r.abort() : r.continue()));
    }
    pages.set(platform, page);
  }
  if (live.platform === platform) await screencast(page);
  return page;
}

async function hasSession(platform) {
  const cookies = await (await headless()).cookies();
  return cookies.some(PLATFORMS[platform].session) && !stale.has(platform);
}
async function requireSession(platform) {
  if (!(await hasSession(platform))) throw loginRequired(platform);
}
function kickedOut(platform) {
  stale.add(platform);
  return loginRequired(platform, '登录已过期');
}

// 跳转时页面自己又跳了一次（微博访客验证、登录态跳转）会报 ERR_ABORTED，等新页面加载完即可。
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

// 打开 url，用 page.on('response') 收集平台自己的数据接口返回的 JSON；ready 后按需滚动加载更多。
async function capture(page, url, { match, ready = (b) => b.length > 0, more = () => false, stop = () => false, scrolls = 0, timeout = 20_000, documentJson = false }) {
  const bodies = [];
  const onResponse = async (res) => {
    const type = res.request().resourceType();
    try {
      if (documentJson && type === 'document' && res.frame() === page.mainFrame()) {
        for (const json of embeddedJson(await res.text())) bodies.push({ url: res.url(), json });
      } else if ((type === 'xhr' || type === 'fetch') && match(res.url())) {
        bodies.push({ url: res.url(), json: await res.json() });
      }
    } catch {}
  };
  page.on('response', onResponse);
  try {
    bodies.status = (await goto(page, url))?.status(); // 页面本身的 HTTP 状态（B 站风控时是 412）
    if (bodies.status >= 400) return bodies;
    // 有的列表要滚进视口才加载（B 站动态），等待时隔几秒往下滚一点。
    let nudged = Date.now();
    await until(async () => {
      if (stop(bodies) || await ready(bodies)) return true;
      if (Date.now() - nudged > 2_500) { nudged = Date.now(); await page.mouse.wheel(0, 700).catch(() => {}); }
      return false;
    }, timeout);
    for (let i = 0; i < scrolls && !stop(bodies) && await ready(bodies) && more(bodies); i++) {
      const n = bodies.length;
      act('往下翻，加载更多');
      await page.mouse.wheel(0, 2500 + Math.random() * 1500).catch(() => {});
      await until(() => bodies.length > n, 6_000);
      await sleep(600 + Math.random() * 800);
    }
  } finally {
    page.off('response', onResponse);
  }
  await keyframe(page, `页面读完了（拿到 ${bodies.length} 批数据）`);
  return bodies;
}

// ---------- 登录窗口 ----------
async function startLogin(platform) {
  if (B.mode !== 'login') {
    await closeBrowser(); // 无头实例占着 profile，先关掉
    const ctx = await chromium.launchPersistentContext(PROFILE, launchOptions(false));
    attach(ctx, 'login');
    // macOS 上关掉最后一个窗口 Chrome 不会退出，所以看页面：全关了就算登录结束。
    const watch = (pg) => pg.on('close', () => setTimeout(() => {
      if (B.ctx === ctx && !ctx.pages().length) endLogin();
    }, 500));
    ctx.pages().forEach(watch);
    ctx.on('page', watch);
  }
  B.platform = platform;
  const page = B.ctx.pages().find((pg) => pg.url() === 'about:blank') || await B.ctx.newPage();
  await page.goto(PLATFORMS[platform].loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  await page.bringToFront().catch(() => {});
  if (process.platform === 'darwin') execFile('osascript', ['-e', 'tell application "Google Chrome for Testing" to activate'], () => {});
}

function endLogin() {
  return serial(async () => {
    if (B.mode !== 'login') return;
    await closeBrowser(); // 正常退出，cookie 落盘
    afterLogin();
  });
}

function afterLogin() {
  stale.clear();
  for (const key of memo.keys()) if (!key.startsWith('weibo:')) memo.delete(key);
}

async function sessions() {
  const ctx = B.ctx || await serial(() => B.ctx || headless());
  const cookies = await ctx.cookies().catch(() => []);
  return {
    mode: B.mode,
    login: B.mode === 'login' ? B.platform : null,
    platforms: Object.entries(PLATFORMS).map(([id, p]) => {
      const has = !!p.session && cookies.some(p.session);
      return {
        id, label: p.label, canLogin: !!p.session, needsLogin: !!p.session && !p.optional,
        loggedIn: has && !stale.has(id), expired: has && stale.has(id), note: p.note || '',
      };
    }),
  };
}

// ---------- 微博（m.weibo.cn，访客身份即可） ----------
async function weiboPage() {
  const fresh = !pages.get('weibo') || pages.get('weibo').isClosed();
  const page = await platformPage('weibo');
  if (fresh) await goto(page, 'https://m.weibo.cn/');
  await until(() => page.url().startsWith('https://m.weibo.cn/'), 10_000); // 等访客验证跳回来
  return page;
}

async function weiboApi(apiPath, retry = true) {
  const page = await weiboPage();
  const data = await page.evaluate(async (p) => {
    const r = await fetch(p, { headers: { 'X-Requested-With': 'XMLHttpRequest', 'MWeibo-Pwa': '1' } });
    try { return await r.json(); } catch { return { ok: 0, status: r.status }; }
  }, apiPath);
  if (data?.ok !== 1 && retry) {
    // 访客 cookie 过期：重新走一遍访客验证再试。
    await goto(page, 'https://m.weibo.cn/');
    await until(() => page.url().startsWith('https://m.weibo.cn/'), 10_000);
    return weiboApi(apiPath, false);
  }
  return data;
}

function weiboSearchUsers(q) {
  return remember(`weibo:q:${q}`, SEARCH_TTL, async () => {
    act(`在微博搜账号「${q}」`);
    if (live.framesOn) { await goto(await weiboPage(), `https://m.weibo.cn/search?containerid=${encodeURIComponent(`100103type=3&q=${q}`)}`); await sleep(1_500); await keyframe(pages.get('weibo'), '搜索结果'); }
    const cid = encodeURIComponent(`100103type=3&q=${q}`);
    const data = await weiboApi(`/api/container/getIndex?containerid=${cid}&page_type=searchall`);
    return (data.data?.cards || []).flatMap((c) => c.card_group || [c]).filter((c) => c.user).slice(0, 8).map(({ user: u }) => ({
      platform: 'weibo', uid: String(u.id), name: u.screen_name, verified: !!u.verified,
      reason: u.verified_reason || '', fans: u.followers_count, desc: (u.description || '').slice(0, 60),
    }));
  });
}

function weiboTimeline(uid, days) {
  return timeline('weibo', uid, days, async (window) => {
    act(`看微博 ${live.subject || uid} 最近的帖子`);
    if (live.framesOn) { await goto(await weiboPage(), `https://m.weibo.cn/u/${uid}`); await sleep(1_500); await keyframe(pages.get('weibo'), '主页打开了'); }
    const since = Date.now() - window * DAY;
    const posts = [];
    let sinceId = '';
    for (let page = 0; page < 3; page++) {
      const data = await weiboApi(`/api/container/getIndex?type=uid&value=${uid}&containerid=107603${uid}${sinceId ? `&since_id=${sinceId}` : ''}`);
      let older = false;
      for (const card of data.data?.cards || []) {
        const m = card.mblog;
        if (!m) continue;
        const ts = Date.parse(m.created_at);
        if (ts < since) { if (!m.isTop) older = true; continue; }
        const src = m.pics?.length ? m : m.retweeted_status;
        const pics = (src?.pics || []).filter((p) => p.large?.url);
        if (!pics.length) continue;
        posts.push({
          post_id: m.id, ts, at: iso(ts), author: m.user?.screen_name || '',
          text: stripHtml(m.text).slice(0, 140) + (src !== m ? ` //转发 @${src.user?.screen_name}: ${stripHtml(src.text).slice(0, 80)}` : ''),
          url: `https://m.weibo.cn/detail/${m.id}`,
          images: pics.map((p) => ({ large: p.large.url, thumb: p.url })),
        });
      }
      sinceId = data.data?.cardlistInfo?.since_id;
      if (older || !sinceId) break;
    }
    return posts;
  });
}

// ---------- X（需登录；拦截 GraphQL：UserTweets / SearchTimeline） ----------
const isXGraphql = (u) => /^https:\/\/(?:[\w-]+\.)?(?:x|twitter)\.com\/.*graphql/i.test(u);
const xKicked = (page) => /\/i\/flow\/login|\/login(\?|$)|\/account\/access/.test(page.url());
const unwrapTweet = (r) => (r?.__typename === 'TweetWithVisibilityResults' ? r.tweet : r);
const isTweet = (o) => typeof o?.rest_id === 'string' && typeof o.legacy?.full_text === 'string';
const xHandleOf = (t) => { const u = t?.core?.user_results?.result || {}; return u.core?.screen_name || u.legacy?.screen_name || ''; };
const xText = (t) => (t.note_tweet?.note_tweet_results?.result?.text || t.legacy.full_text || '').replace(/\s*https:\/\/t\.co\/\w+/g, '').trim();

// pbs.twimg.com/media/ID.jpg → ?format=jpg&name=orig（原图）/ name=small（缩略图）
function xImage(u, name) {
  const m = /^(https:\/\/pbs\.twimg\.com\/media\/[^.?]+)\.(\w+)/.exec(u);
  return m ? `${m[1]}?format=${m[2] === 'png' ? 'png' : 'jpg'}&name=${name}` : u;
}

function xTweets(bodies) {
  const out = new Map();
  for (const { json } of bodies) {
    walk(json, (o) => {
      const t = unwrapTweet(o);
      if (!isTweet(t)) return undefined;
      out.set(t.rest_id, t);
      return false;
    });
  }
  return [...out.values()];
}

function xPost(t) {
  const rt = unwrapTweet(t.legacy.retweeted_status_result?.result);
  const src = isTweet(rt) ? rt : t;
  const media = (src.legacy.extended_entities?.media || src.legacy.entities?.media || []).filter((m) => m.type === 'photo' && m.media_url_https);
  const ts = Date.parse(t.legacy.created_at);
  return {
    post_id: t.rest_id, ts, at: iso(ts), author: xHandleOf(t),
    text: (src === t ? xText(t) : `RT @${xHandleOf(src)}: ${xText(src)}`).slice(0, 220),
    url: `https://x.com/${xHandleOf(src)}/status/${src.rest_id}`,
    images: media.map((m) => ({ large: xImage(m.media_url_https, 'orig'), thumb: xImage(m.media_url_https, 'small') })),
  };
}

function xTimeline(handle, days) {
  return timeline('x', handle.toLowerCase(), days, async (window) => {
    await requireSession('x');
    const since = Date.now() - window * DAY;
    const page = await platformPage('x');
    await pace('x');
    const mine = (b) => xTweets(b).filter((t) => xHandleOf(t).toLowerCase() === handle.toLowerCase());
    const bodies = await capture(page, `https://x.com/${handle}`, {
      match: isXGraphql, documentJson: true, stop: () => xKicked(page),
      ready: (b) => mine(b).length > 0,
      // 置顶帖可能很旧：见到两条时间窗外的帖子才停止往下翻。
      more: (b) => mine(b).filter((t) => Date.parse(t.legacy.created_at) < since).length < 2,
      scrolls: 4,
    });
    if (xKicked(page)) throw kickedOut('x');
    return mine(bodies).map(xPost).filter((p) => p.images.length);
  });
}

function xUsers(bodies) {
  // 有 SearchTimeline 就只看它，免得混进「推荐关注」或登录用户自己。
  const search = bodies.filter((b) => /Search/i.test(b.url));
  const out = new Map();
  for (const { json } of search.length ? search : bodies.filter((b) => !/viewer/i.test(b.url))) {
    walk(json, (o) => {
      if (o.__typename !== 'User' || typeof o.rest_id !== 'string') return undefined;
      const L = o.legacy || {};
      const handle = o.core?.screen_name || L.screen_name;
      if (handle && !out.has(handle)) {
        out.set(handle, {
          platform: 'x', uid: handle, name: o.core?.name || L.name || handle,
          verified: !!(o.is_blue_verified || L.verified || o.verification?.verified),
          reason: [o.verification?.verified_type || L.verified_type, o.affiliates_highlighted_label?.label?.description].filter(Boolean).join(' · '),
          fans: L.followers_count ?? o.relationship_counts?.followers, desc: (L.description || o.profile_bio?.description || '').slice(0, 60),
        });
      }
      return false;
    });
  }
  return [...out.values()];
}

function xSearchUsers(q) {
  return remember(`x:q:${q.toLowerCase()}`, SEARCH_TTL, async () => {
    await requireSession('x');
    const page = await platformPage('x');
    await pace('x');
    const bodies = await capture(page, `https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query&f=user`, {
      match: isXGraphql, stop: () => xKicked(page), ready: (b) => xUsers(b).length > 0,
    });
    if (xKicked(page)) throw kickedOut('x');
    return xUsers(bodies).slice(0, 8);
  });
}

// ---------- Instagram（需登录；拦截 /api/graphql 的帖子列表，兜底 web_profile_info） ----------
const IG_APP_ID = '936619743392459'; // 网页版自己带的 X-IG-App-ID
const isIgApi = (u) => /^https:\/\/www\.instagram\.com\/(api\/graphql|graphql\/query|api\/v1\/)/.test(u);
const igKicked = (page, bodies = []) => /\/accounts\/login|\/challenge\//.test(page.url())
  || bodies.some((b) => b.json?.errors?.some?.((e) => /logged out/i.test(e.message || '')));

function igBest(cands = []) {
  const c = [...cands].sort((a, b) => b.width - a.width);
  return { large: c[0]?.url, thumb: (c.filter((x) => x.width >= 480).at(-1) || c[0])?.url };
}

// 新接口（xdt_api__v1__feed__user_timeline_graphql_connection / feed/user）的帖子节点
function igFromV1(o) {
  const items = o.carousel_media?.length ? o.carousel_media : [o];
  const ts = o.taken_at * 1000;
  return {
    post_id: o.code, ts, at: iso(ts), author: o.user?.username || o.owner?.username || '',
    text: (o.caption?.text || '').slice(0, 220), url: `https://www.instagram.com/p/${o.code}/`,
    images: items.filter((m) => m.media_type !== 2 && m.image_versions2?.candidates?.length)
      .map((m) => igBest(m.image_versions2.candidates)).filter((i) => i.large),
  };
}

// 旧接口（web_profile_info 的 edge_owner_to_timeline_media）的帖子节点
function igFromGraph(o) {
  const items = o.edge_sidecar_to_children?.edges?.map((e) => e.node) || [o];
  const ts = o.taken_at_timestamp * 1000;
  return {
    post_id: o.shortcode, ts, at: iso(ts), author: o.owner?.username || '',
    text: (o.edge_media_to_caption?.edges?.[0]?.node?.text || '').slice(0, 220), url: `https://www.instagram.com/p/${o.shortcode}/`,
    images: items.filter((m) => !m.is_video && m.display_url).map((m) => {
      const small = [...(m.display_resources || [])].sort((a, b) => a.config_width - b.config_width).find((r) => r.config_width >= 480);
      return { large: m.display_url, thumb: small?.src || m.display_url };
    }),
  };
}

function igPosts(bodies, username) {
  const out = new Map();
  for (const { json } of bodies) {
    walk(json, (o) => {
      let p;
      if (typeof o.code === 'string' && typeof o.taken_at === 'number' && (o.image_versions2 || o.carousel_media)) p = igFromV1(o);
      else if (typeof o.shortcode === 'string' && typeof o.taken_at_timestamp === 'number' && o.display_url) p = igFromGraph(o);
      else return undefined;
      if (!p.author || p.author.toLowerCase() === username.toLowerCase()) out.set(p.post_id, p);
      return false;
    });
  }
  return [...out.values()];
}

async function igFetch(page, apiPath) {
  return page.evaluate(async ({ p, app }) => {
    const r = await fetch(p, { headers: { 'X-IG-App-ID': app, 'X-Requested-With': 'XMLHttpRequest' } });
    try { return await r.json(); } catch { return null; }
  }, { p: apiPath, app: IG_APP_ID });
}

function igTimeline(username, days) {
  return timeline('instagram', username.toLowerCase(), days, async (window) => {
    await requireSession('instagram');
    const since = Date.now() - window * DAY;
    const page = await platformPage('instagram');
    await pace('instagram');
    const bodies = await capture(page, `https://www.instagram.com/${username}/`, {
      match: isIgApi, documentJson: true, stop: (b) => igKicked(page, b),
      ready: (b) => igPosts(b, username).length > 0,
      more: (b) => igPosts(b, username).filter((p) => p.ts < since).length < 4, // 最多 3 条置顶
      scrolls: 3, timeout: 15_000,
    });
    if (igKicked(page, bodies)) throw kickedOut('instagram');
    let posts = igPosts(bodies, username);
    if (!posts.length) {
      // 兜底：网页版资料卡用的 web_profile_info，返回最近 12 条。
      const json = await igFetch(page, `/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`);
      posts = igPosts([{ json }], username);
    }
    return posts.filter((p) => p.images.length);
  });
}

function igSearchUsers(q) {
  return remember(`instagram:q:${q.toLowerCase()}`, SEARCH_TTL, async () => {
    await requireSession('instagram');
    const page = await platformPage('instagram');
    if (!page.url().startsWith('https://www.instagram.com/')) {
      await pace('instagram');
      await goto(page, 'https://www.instagram.com/');
    }
    if (igKicked(page)) throw kickedOut('instagram');
    await pace('instagram');
    // 网页版搜索框用的接口。
    const json = await igFetch(page, `/api/v1/web/search/topsearch/?context=blended&query=${encodeURIComponent(q)}&include_reel=false`);
    let users = (json?.users || []).map((x) => x.user || x).filter((u) => u?.username);
    if (!users.length && /^[\w.]{1,30}$/.test(q)) {
      const info = await igFetch(page, `/api/v1/users/web_profile_info/?username=${encodeURIComponent(q)}`);
      if (info?.data?.user) users = [{ ...info.data.user, follower_count: info.data.user.edge_followed_by?.count }];
    }
    return users.slice(0, 8).map((u) => ({
      platform: 'instagram', uid: u.username, name: u.full_name || u.username, verified: !!u.is_verified,
      reason: u.is_verified ? '已认证' : '', fans: u.follower_count, desc: (u.biography || u.search_social_context || '').slice(0, 60),
    }));
  });
}

// ---------- Weverse（社区列表免登录；艺人帖子需登录并加入社区） ----------
const isWeverseApi = (u) => /^https:\/\/global\.apis\.naver\.com\/weverse\//.test(u);
const wvKicked = (page) => /account\.weverse\.io/.test(page.url());
const norm = (s) => String(s || '').toLowerCase().replace(/[\s_\-.]/g, '');

function wvCommunities(bodies) {
  const out = new Map();
  for (const { json } of bodies) {
    walk(json, (o) => {
      if (o.communityId == null || !o.communityName || !o.urlPath) return undefined;
      out.set(o.communityId, { ...out.get(o.communityId), ...o });
      return false;
    });
  }
  return [...out.values()];
}

function weverseSearchUsers(q) {
  return remember(`weverse:q:${q.toLowerCase()}`, SEARCH_TTL, async () => {
    const page = await platformPage('weverse');
    await pace('weverse');
    const bodies = await capture(page, 'https://weverse.io/', { match: isWeverseApi, ready: (b) => wvCommunities(b).length > 20, timeout: 15_000 });
    const key = norm(q);
    return wvCommunities(bodies)
      .filter((c) => key && [c.communityName, c.communityAlias, c.urlPath].some((s) => norm(s).includes(key)))
      .sort((a, b) => (b.memberCount || 0) - (a.memberCount || 0)).slice(0, 8)
      .map((c) => ({
        platform: 'weverse', uid: c.urlPath, name: c.communityName, verified: true, reason: 'Weverse 官方社区',
        fans: c.memberCount, desc: `weverse.io/${c.urlPath}`,
      }));
  });
}

function wvPosts(bodies, community) {
  const out = new Map();
  for (const { json } of bodies) {
    walk(json, (o) => {
      if (typeof o.postId !== 'string' || typeof o.publishedAt !== 'number' || !('body' in o || 'plainBody' in o || o.attachment)) return undefined;
      if (o.author?.profileType && o.author.profileType !== 'ARTIST') return false;
      const photo = o.attachment?.photo || {};
      const photos = (Array.isArray(photo) ? photo : Object.values(photo)).filter((p) => p?.url);
      out.set(o.postId, {
        post_id: o.postId, ts: o.publishedAt, at: iso(o.publishedAt),
        author: o.author?.profileName || o.author?.artistOfficialProfile?.officialName || '',
        text: (o.plainBody || stripHtml(o.body)).slice(0, 220),
        url: o.shareUrl || `https://weverse.io/${community}/artist/${o.postId}`,
        // phinf 图床支持 ?type=w670 缩略图
        images: photos.map((p) => ({ large: p.url, thumb: p.url.includes('?') ? p.url : `${p.url}?type=w670` })),
      });
      return false;
    });
  }
  return [...out.values()];
}

function weverseTimeline(community, days) {
  return timeline('weverse', community.toLowerCase(), days, async (window) => {
    await requireSession('weverse');
    const since = Date.now() - window * DAY;
    const page = await platformPage('weverse');
    await pace('weverse');
    const bodies = await capture(page, `https://weverse.io/${community}/artist`, {
      match: isWeverseApi, stop: () => wvKicked(page),
      ready: (b) => wvPosts(b, community).length > 0,
      more: (b) => !wvPosts(b, community).some((p) => p.ts < since),
      scrolls: 3, timeout: 15_000,
    });
    if (wvKicked(page)) throw kickedOut('weverse');
    const posts = wvPosts(bodies, community);
    return {
      posts: posts.filter((p) => p.images.length),
      ...(!posts.length && { note: `Weverse 没读到 ${community} 的艺人帖子：如果还没加入这个社区，请在 App 里点「登录 Weverse」，在窗口里打开社区页点「加入」。` }),
    };
  });
}

// ---------- 小红书（需登录；用户页 __INITIAL_STATE__ + user_posted 接口，搜索拦截 usersearch） ----------
// 搜索接口在 so.xiaohongshu.com（笔记搜索是 v2/search/notes），其余在 edith；页面有时会降级成 http。
const isXhsApi = (u) => /^https?:\/\/(edith|so)\.xiaohongshu\.com\/api\/sns\/web\//.test(u);
const xhsKicked = (page) => /xiaohongshu\.com\/(login|website-login)/.test(page.url());
// 笔记 id 是 24 位十六进制的 ObjectId，前 8 位就是秒级发布时间，不用逐条打开笔记。
const xhsTs = (id) => (/^[0-9a-f]{24}$/i.test(id) ? parseInt(id.slice(0, 8), 16) * 1000 : 0);
const https = (u) => (typeof u === 'string' ? u.replace(/^http:/, 'https:') : u);

// 页面自带的首屏数据（兜底）。里面是 Vue 响应式对象，有循环引用，只取 user.notes 并跳过重复对象。
const xhsState = (page) => page.evaluate(() => {
  const seen = new WeakSet();
  const unref = (v) => (v && typeof v === 'object' && '_rawValue' in v ? v._rawValue : v);
  try {
    const notes = unref(unref(window.__INITIAL_STATE__?.user)?.notes);
    return JSON.parse(JSON.stringify(notes ?? null, (k, v) => {
      if (k === 'dep' || k === 'computed') return undefined;
      if (v && typeof v === 'object') { if (seen.has(v)) return undefined; seen.add(v); }
      return v;
    }));
  } catch { return null; }
}).catch(() => null);

// 同时认两种形状：接口的 {note_id, display_title, cover:{url_default}} 和首屏的 {noteId, displayTitle, cover:{urlDefault}}。
function xhsPosts(sources, uid) {
  const out = new Map();
  for (const json of sources) {
    walk(json, (o) => {
      const id = o.note_id || o.noteId;
      const cover = o.cover;
      if (typeof id !== 'string' || !cover || typeof cover !== 'object') return undefined;
      const large = https(cover.url_default || cover.urlDefault || cover.url);
      const author = o.user?.nickname || o.user?.nick_name || '';
      const ownerId = o.user?.user_id || o.user?.userId;
      if (large && (!ownerId || ownerId === uid) && o.type !== 'video') {
        const ts = typeof o.time === 'number' ? o.time : xhsTs(id); // user_posted 自带毫秒发布时间
        const token = o.xsec_token || o.xsecToken;
        out.set(id, {
          post_id: id, ts, at: iso(ts), author, text: String(o.display_title || o.displayTitle || '').slice(0, 220),
          url: `https://www.xiaohongshu.com/explore/${id}${token ? `?xsec_token=${encodeURIComponent(token)}&xsec_source=pc_user` : ''}`,
          images: [{ large, thumb: https(cover.url_pre || cover.urlPre) || large }],
        });
      }
      return false;
    });
  }
  return [...out.values()];
}

function xhsTimeline(uid, days) {
  return timeline('xiaohongshu', uid, days, async () => {
    await requireSession('xiaohongshu');
    const page = await platformPage('xiaohongshu');
    await pace('xiaohongshu');
    const bodies = await capture(page, `https://www.xiaohongshu.com/user/profile/${uid}`, {
      match: (u) => isXhsApi(u) && /user_posted/.test(u), stop: () => xhsKicked(page),
      ready: (b) => b.length > 0, timeout: 15_000,
    });
    if (xhsKicked(page)) throw kickedOut('xiaohongshu');
    let posts = xhsPosts(bodies.map((b) => b.json), uid);
    if (!posts.length) posts = xhsPosts([await xhsState(page)], uid);
    // 封面就是第一张图；视频笔记已跳过。置顶笔记可能很旧，交给 timeline() 按时间截。
    return { posts, note: '小红书每条笔记只取封面图' };
  });
}

function xhsSearchUsers(q) {
  return remember(`xiaohongshu:q:${q}`, SEARCH_TTL, async () => {
    act(`在小红书搜账号「${q}」`);
    await requireSession('xiaohongshu');
    const page = await platformPage('xiaohongshu');
    await pace('xiaohongshu');
    const bodies = [];
    const onResponse = async (res) => {
      if (isXhsApi(res.url()) && /search\/usersearch/.test(res.url())) { try { bodies.push(await res.json()); } catch {} }
    };
    page.on('response', onResponse);
    try {
      // type=51 直接打开「用户」页签；小红书会记住上次的页签，再去点一次反而可能点错。
      await goto(page, `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(q)}&source=web_search_result_notes&type=51`);
      if (xhsKicked(page)) throw kickedOut('xiaohongshu');
      if (!(await until(() => bodies.length > 0, 8_000))) {
        await page.getByText('用户', { exact: true }).first().click({ timeout: 5_000 }).catch(() => {});
        await until(() => bodies.length > 0, 8_000);
      }
    } finally {
      page.off('response', onResponse);
    }
    const users = [];
    for (const json of bodies) walk(json, (o) => {
      const id = o.id || o.user_id;
      if (typeof id === 'string' && /^[0-9a-f]{24}$/i.test(id) && (o.name || o.nickname)) { users.push(o); return false; }
      return undefined;
    });
    return users.slice(0, 8).map((u) => ({
      platform: 'xiaohongshu', uid: u.id || u.user_id, name: u.name || u.nickname,
      verified: !!(u.red_official_verified || u.show_red_official_verify_icon || u.red_official_verify_type > 0),
      reason: u.red_official_verified ? `小红书认证${u.profession ? `·${u.profession}` : ''}` : (u.profession || ''), fans: u.fans || '',
      desc: String(u.desc || u.profession || '').slice(0, 60),
    }));
  });
}

// 关键词搜笔记：打开搜索页，拦截 search/notes 接口。sort：general 综合 / latest 最新 / popular 最热。
const XHS_SORT = { general: 'general', latest: 'time_descending', popular: 'popularity_descending' };
const XHS_SORT_TEXT = { latest: '最新', popular: '最热' };

function xhsNotesFrom(bodies) {
  const out = new Map();
  for (const json of bodies) {
    for (const it of json?.data?.items || []) {
      const c = it.note_card;
      if (!c || it.model_type !== 'note' || !/^[0-9a-f]{24}$/i.test(it.id || '')) continue;
      const large = https(c.cover?.url_default || c.cover?.info_list?.find?.((x) => x.image_scene === 'WB_DFT')?.url);
      if (!large) continue;
      const ts = xhsTs(it.id);
      const token = it.xsec_token || c.xsec_token;
      out.set(it.id, {
        post_id: it.id, ts, at: iso(ts), author: c.user?.nickname || c.user?.nick_name || '',
        text: String(c.display_title || '').trim() || '（无标题）', likes: c.interact_info?.liked_count || '',
        url: `https://www.xiaohongshu.com/explore/${it.id}${token ? `?xsec_token=${encodeURIComponent(token)}&xsec_source=pc_search` : ''}`,
        images: [{ large, thumb: https(c.cover?.url_pre) || large }],
        video: c.type === 'video',
      });
    }
  }
  return [...out.values()];
}

async function xhsSearchNotes(q, sort = 'general') {
  // 冷启动第一次常常拿不到结果：空结果重试一次，而且不缓存空结果。
  const key = `xiaohongshu:notes:${sort}:${q}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  let value = await xhsSearchNotesOnce(q, sort);
  if (!value.notes.length) value = await xhsSearchNotesOnce(q, sort);
  if (value.notes.length) memo.set(key, { at: Date.now(), value });
  return value;
}

function xhsSearchNotesOnce(q, sort) {
  return (async () => {
    act(`在小红书搜笔记「${q}」`);
    await requireSession('xiaohongshu');
    const page = await platformPage('xiaohongshu');
    await pace('xiaohongshu');
    const bodies = [];
    const onResponse = async (res) => {
      if (isXhsApi(res.url()) && /search\/notes/.test(res.url())) { try { bodies.push(await res.json()); } catch {} }
    };
    page.on('response', onResponse);
    try {
      // 只等到开始加载：搜索页资源多，冷启动时等 domcontentloaded 容易超时。
      await page.goto(`https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(q)}&source=web_explore_feed`,
        { waitUntil: 'commit', timeout: 30_000 }).catch(() => {});
      await until(() => xhsKicked(page) || bodies.length > 0, 6_000);
      if (xhsKicked(page)) throw kickedOut('xiaohongshu');
      // 小红书会记住上次停在「用户」页签；没等到笔记结果就点回「全部」。
      if (!(await until(() => bodies.length > 0, 8_000))) {
        act('切到「全部」页签');
        await page.getByText('全部', { exact: true }).first().click({ timeout: 5_000 }).catch(() => {});
        await until(() => bodies.length > 0, 8_000);
      }
      if (XHS_SORT_TEXT[sort] && bodies.length) {
        act(`按「${XHS_SORT_TEXT[sort]}」排序`);
        // 排序在「筛选」里；点了会重新请求一次 search/notes，取最后一次的结果。
        const n = bodies.length;
        await page.getByText('筛选', { exact: true }).first().hover({ timeout: 4_000 }).catch(() => {});
        await page.getByText(XHS_SORT_TEXT[sort], { exact: true }).first().click({ timeout: 4_000 }).catch(() => {});
        if (await until(() => bodies.length > n, 8_000)) bodies.splice(0, n);
      }
    } finally {
      page.off('response', onResponse);
    }
    return { notes: xhsNotesFrom(bodies).filter((n) => !n.video).slice(0, 20), sort: XHS_SORT[sort] };
  })();
}

// ---------- B 站（免登录可读；拦截 web-dynamic feed/space，被风控时提示登录） ----------
const isBiliApi = (u) => /^https:\/\/api\.bilibili\.com\//.test(u);
const BILI_RISK = new Set([-352, -412, -799]);
const biliRisk = (bodies) => (bodies.status === 412 ? { json: { code: 412 } } : bodies.find((b) => BILI_RISK.has(b.json?.code)));
const riskError = (code) => new SandboxError(401, 'login_required',
  `B 站暂时被风控（${code}）：等十几分钟再试，或在喵团 App「+」→「社媒账号」点「登录 B 站」，在弹出的窗口里自己扫码登录（建议用小号），登录后更稳定。`, { platform: 'bilibili' });

async function biliSearchUsers(q) {
  return remember(`bilibili:q:${q}`, SEARCH_TTL, async () => {
    const page = await platformPage('bilibili');
    await pace('bilibili');
    // 搜索结果多数是服务端渲染进 window.__pinia 的，偶尔走 /search/type 接口。
    const ssr = () => page.evaluate(() => window.__pinia?.searchTypeResponse?.searchTypeResponse?.result || null).catch(() => null);
    const bodies = await capture(page, `https://search.bilibili.com/upuser?keyword=${encodeURIComponent(q)}`, {
      match: (u) => isBiliApi(u) && /search\/type/.test(u),
      ready: async (b) => b.length > 0 || !!(await ssr()),
      timeout: 15_000,
    });
    const risk = biliRisk(bodies);
    if (risk) throw riskError(risk.json.code);
    const result = bodies.at(-1)?.json?.data?.result || await ssr() || [];
    return result.filter((u) => u.mid).slice(0, 8).map((u) => ({
      platform: 'bilibili', uid: String(u.mid), name: stripHtml(u.uname), verified: [0, 1].includes(u.official_verify?.type),
      reason: u.official_verify?.desc || '', fans: u.fans, desc: (u.usign || '').slice(0, 60),
    }));
  });
}

const biliIsTop = (it) => /置顶/.test(it.modules?.module_tag?.text || '');
const biliPics = (dyn) => {
  const major = dyn?.major;
  return (major?.opus?.pics || major?.draw?.items?.map((i) => ({ url: i.src })) || []).map((p) => p.url).filter(Boolean);
};
const biliText = (dyn) => [dyn?.major?.opus?.title, dyn?.major?.opus?.summary?.text || dyn?.desc?.text].filter(Boolean).join(' ').trim();

function biliPost(it) {
  const author = it.modules?.module_author || {};
  const dyn = it.modules?.module_dynamic;
  let pics = biliPics(dyn);
  let text = biliText(dyn);
  if (!pics.length && it.orig) {
    const od = it.orig.modules?.module_dynamic;
    pics = biliPics(od);
    text = `${text} //转发 @${it.orig.modules?.module_author?.name || ''}: ${biliText(od).slice(0, 80)}`.trim();
  }
  const ts = (author.pub_ts || 0) * 1000;
  return {
    post_id: it.id_str, ts, at: iso(ts), author: author.name || '', text: text.slice(0, 220),
    url: `https://www.bilibili.com/opus/${it.id_str}`,
    images: pics.map((u) => {
      const large = u.replace(/^\/\//, 'https://').replace(/^http:/, 'https:');
      return { large, thumb: `${large}@480w_480h_1c.jpg` };
    }),
  };
}

function biliTimeline(mid, days) {
  return timeline('bilibili', mid, days, async (window) => {
    const since = Date.now() - window * DAY;
    const page = await platformPage('bilibili');
    await pace('bilibili');
    const feeds = (b) => b.filter((x) => /feed\/space/.test(x.url));
    const items = (b) => [...new Map(feeds(b).flatMap((x) => x.json?.data?.items || []).map((it) => [it.id_str, it])).values()];
    const bodies = await capture(page, `https://space.bilibili.com/${mid}/dynamic`, {
      match: isBiliApi, stop: (b) => !!biliRisk(b),
      ready: (b) => feeds(b).length > 0,
      more: (b) => feeds(b).at(-1)?.json?.data?.has_more
        && !items(b).some((it) => !biliIsTop(it) && (it.modules?.module_author?.pub_ts || 0) * 1000 < since),
      scrolls: 3,
    });
    const risk = biliRisk(bodies);
    if (risk) throw riskError(risk.json.code);
    if (!feeds(bodies).length) throw new SandboxError(502, 'no_data', 'B 站没有返回动态，稍后再试');
    return items(bodies).map(biliPost).filter((p) => p.images.length);
  });
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

// ---------- 检查 agent 自己做的网站（publish_site 发布、App 在 :3211 提供）：真的打开页面，收集报错、截首屏图 ----------
// 只接受网站 id，地址在这里拼，不能拿来访问别的本机端口。用单独的无痕浏览器（不带社媒登录 cookie）；页面里的请求也拦一遍：
// 只放行这个网站自己的文件和解析到公网的 https，其余（别的本机端口、内网、http）一律拦下并记进结果。
// 顶层页面（含弹窗）只能停在这个网站里：route 看不到重定向，外站 302 到本机的话就漏了；子资源的重定向有网站的 CSP 逐跳把关。
const SITES_ORIGIN = `http://127.0.0.1:${Number(process.env.SITES_PORT || 3211)}`;
const SITE_ID = /^s_[0-9a-f]{8}$/;
const SHOTS_DIR = path.join(DIR, 'shots'); // shots/<网站 id>/<n>.jpg，每次检查覆盖，agent 可以用 vision_analyze 看
const VIEWPORTS = { mobile: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
const MAX_CLICKS = 5;

function siteGuard(base, onBlocked) {
  const hosts = new Map(); // 本次检查内缓存 DNS 结果
  const allowed = (raw) => {
    let u;
    try { u = new URL(raw); } catch { return false; }
    if (u.origin === SITES_ORIGIN) return u.pathname.startsWith(new URL(base).pathname);
    if (u.protocol !== 'https:') return false;
    if (!hosts.has(u.hostname)) hosts.set(u.hostname, assertPublicUrl(u.href).then(() => true, () => false));
    return hosts.get(u.hostname);
  };
  return async (route) => {
    const req = route.request();
    const url = req.url();
    if (new URL(url).pathname === '/favicon.ico') return route.fulfill({ status: 204 }).catch(() => {});
    let top = false;
    try { top = req.isNavigationRequest() && !req.frame().parentFrame(); } catch {}
    if (top ? url.startsWith(base) : await allowed(url)) return route.continue().catch(() => {});
    onBlocked(url, top);
    return route.abort('blockedbyclient').catch(() => {});
  };
}

// 报错位置：内联脚本的行号就是 index.html 里的行号。
function errorWhere(base, url, line, col) {
  if (!url || !line) return {};
  const file = url.startsWith(base) ? url.slice(base.length).split(/[?#]/)[0] || 'index.html' : shortUrl(url);
  return { where: `${file}:${line}${col ? `:${col}` : ''}` };
}

// 报错在 index.html 里的，带上那一行代码（一行很长时截报错列附近）。
function withCode(issue, lines) {
  const [, line, col = 1] = /^index\.html:(\d+)(?::(\d+))?$/.exec(issue.where || '') || [];
  const src = line && lines[line - 1];
  return src ? { ...issue, code: (src.length > 200 ? src.slice(Math.max(0, col - 80), Number(col) + 120) : src).trim() } : issue;
}

function stackWhere(stack) {
  const m = /\((https?:\/\/[^)\s]+):(\d+):(\d+)\)|at (https?:\/\/\S+):(\d+):(\d+)/.exec(stack || '');
  return m ? { url: m[1] || m[4], line: Number(m[2] || m[5]), col: Number(m[3] || m[6]) } : {};
}

async function clickTarget(page, target) {
  const cands = [];
  try { const css = page.locator(target); if (await css.count()) cands.push(css); } catch {} // 不是合法 CSS 选择器就按文字找
  cands.push(page.getByRole('button', { name: target }), page.getByText(target, { exact: true }), page.getByText(target));
  for (const loc of cands) {
    if (!(await loc.count().catch(() => 0))) continue;
    try {
      await loc.first().click({ timeout: 5_000 });
      return { target, ok: true };
    } catch (e) {
      // 点不到本身就是要修的 bug：最常见的是被透明遮罩 / 别的层挡住，或者元素不可见、被禁用
      const m = e.message;
      const why = /intercepts pointer events/.test(m) ? '点不到：被别的元素挡住了'
        : /element is not visible/.test(m) ? '点不到：元素不可见'
          : /element is not enabled/.test(m) ? '点不到：元素是禁用状态'
            : /outside of the viewport/.test(m) ? '点不到：元素在可视区域外' : m.split('\n')[0].slice(0, 200);
      const coveredBy = /intercepts/.test(m) && await loc.first().evaluate((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return top && top !== el && !el.contains(top) ? top.outerHTML.slice(0, 160) : null;
      }).catch(() => null);
      return { target, ok: false, error: why, ...(coveredBy && { coveredBy }) };
    }
  }
  return { target, ok: false, error: `页面上没找到「${target}」（按 CSS 选择器、按钮名、文字都找过）` };
}

async function siteSnapshot(page, id, n, phase) {
  const info = await page.evaluate(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0; };
    const text = (document.body?.innerText || '').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
    const clickables = [...document.querySelectorAll('button, a[href], [onclick], [role=button], input[type=button], input[type=submit]')]
      .filter(visible).slice(0, 20).map((el) => ({
        tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 30),
        ...(el.id && { id: el.id }), ...(el.className && typeof el.className === 'string' && { class: el.className.trim().slice(0, 40) }),
      }));
    return { title: document.title, url: location.href, textLength: text.length, text: text.slice(0, 1500), canvases: document.querySelectorAll('canvas').length, clickables };
  }).catch((e) => ({ error: `读不了页面内容：${e.message.split('\n')[0]}` }));
  let screenshot = null;
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 70, timeout: 8_000 });
    const dir = path.join(SHOTS_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    screenshot = path.join(dir, `${n}.jpg`);
    fs.writeFileSync(screenshot, buf);
    emit({ type: 'frame', key: true, text: phase, url: page.url(), data: buf.toString('base64') });
  } catch {}
  return { phase, ...info, screenshot };
}

async function checkSite(id, { clicks = [], viewport = 'mobile' } = {}) {
  const base = `${SITES_ORIGIN}/${id}/`;
  fs.rmSync(path.join(SHOTS_DIR, id), { recursive: true, force: true });
  act(`打开网页 ${id}`);
  const browser = await chromium.launch({
    executablePath: CHROME, headless: true, ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
    ...(PROXY && { proxy: { server: PROXY, bypass: ['localhost', '127.0.0.1', ...DIRECT.flatMap((h) => [h, `*.${h}`])].join(',') } }),
  });
  try {
    const ctx = await browser.newContext({
      viewport: VIEWPORTS[viewport] || VIEWPORTS.mobile, deviceScaleFactor: 2, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
      userAgent: UA, serviceWorkers: 'block', acceptDownloads: false,
    });
    let phase = '加载';
    const issues = new Map(); // 同一阶段同一条报错只记一次（动画循环里的报错一秒几十次），带次数
    const add = (type, text, where = {}) => {
      const key = `${phase}|${type}|${text}`;
      const hit = issues.get(key);
      if (hit) { hit.count++; return; }
      if (issues.size < 40) issues.set(key, { phase, type, text: String(text).slice(0, 400), ...where, count: 1 });
    };
    const blocked = new Set();
    await ctx.route('**/*', siteGuard(base, (u, top) => {
      blocked.add(u);
      add('blocked', top ? `页面要跳转到 ${u.slice(0, 200)}（检查只在这个网站里进行，没有跟过去）`
        : `沙箱拦下了这个请求（只允许本网站文件和公网 https）：${u.slice(0, 200)}`);
    }));
    const page = await ctx.newPage();
    ctx.on('page', (p) => { if (p !== page) { add('popup', `页面打开了新窗口：${p.url()}`); p.close().catch(() => {}); } });
    page.on('console', (m) => {
      // 「Failed to load resource」和下面 requestfailed / response 记的是同一件事
      if ((m.type() !== 'error' && m.type() !== 'warning') || /^Failed to load resource/.test(m.text())) return;
      const loc = m.location();
      // CSP 拦截之类没有具体位置的，location 是 0:0
      add(m.type(), m.text(), loc.lineNumber || loc.columnNumber ? errorWhere(base, loc.url, loc.lineNumber + 1, loc.columnNumber + 1) : {});
    });
    // 未捕获异常走 CDP：Playwright 的 pageerror 对语法错误不带行号，而语法错误恰恰是整段脚本不执行、页面「点不动」的元凶
    try {
      const cdp = await ctx.newCDPSession(page);
      cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
        const at = d.stackTrace?.callFrames?.[0] || d;
        const text = (d.exception?.description || d.text || '').split('\n')[0];
        add('pageerror', text, errorWhere(base, at.url || d.url, at.lineNumber + 1, at.columnNumber + 1));
      });
      await cdp.send('Runtime.enable');
    } catch {
      page.on('pageerror', (e) => { const w = stackWhere(e.stack); add('pageerror', `${e.name}: ${e.message}`, errorWhere(base, w.url, w.line, w.col)); });
    }
    page.on('requestfailed', (r) => {
      const err = r.failure()?.errorText || '';
      if (err === 'csp' || (/BLOCKED_BY_CLIENT/.test(err) && blocked.has(r.url()))) return; // console / blocked 已经记过
      add('requestfailed', `${err} ${r.url().slice(0, 200)}${/ORB/.test(err) ? '（一般是这个地址 404 了或者不是 JS/CSS 文件：检查网址和版本号）' : ''}`);
    });
    page.on('response', (r) => { if (r.status() >= 400 && r.request().frame() === page.mainFrame()) add('http', `${r.status()} ${r.url().slice(0, 200)}`); });
    page.on('dialog', (d) => { add('dialog', `${d.type()}：${d.message().slice(0, 200)}`); d.accept().catch(() => {}); });
    page.on('crash', () => add('crash', '页面崩溃了（可能是死循环或内存爆了）'));
    await screencast(page);

    const t0 = Date.now();
    let res = null;
    const load = {};
    try {
      res = await page.goto(base, { waitUntil: 'load', timeout: 15_000 });
    } catch (e) {
      if (/ERR_CONNECTION_REFUSED/.test(e.message)) throw new SandboxError(502, 'sites_down', `网站服务（${SITES_ORIGIN}）没开，喵团 App 没在运行`);
      if (!/Timeout/i.test(e.message)) throw e;
      load.note = '15 秒内没加载完（有外部资源很慢或打不开），下面是此刻的状态';
    }
    if (res?.status() === 404) throw new SandboxError(404, 'not_found', `没有网站 ${id}`);
    const source = res ? res.text().catch(() => '') : Promise.resolve(''); // 现在就取：点击跳走以后就拿不到了
    Object.assign(load, { status: res?.status() ?? null, ms: Date.now() - t0 });
    await sleep(1_500); // 等 onload 里的初始化、定时器跑一会儿
    const snapshots = [await siteSnapshot(page, id, 0, '首屏')];

    const done = [];
    for (const [i, target] of clicks.slice(0, MAX_CLICKS).entries()) {
      phase = `点「${target}」后`;
      act(`点「${target}」`);
      const click = await clickTarget(page, target);
      done.push(click);
      await sleep(click.ok ? 1_200 : 300);
      snapshots.push({ click, ...(await siteSnapshot(page, id, i + 1, phase)) });
      if (!click.ok) break;
    }

    const lines = (await source).split('\n');
    const list = [...issues.values()].map((x) => withCode(x, lines));
    const errors = list.filter((x) => x.type !== 'warning');
    act(errors.length ? `发现 ${errors.length} 个问题` : '没发现报错');
    return {
      id, url: base.replace('127.0.0.1', 'localhost'), viewport: VIEWPORTS[viewport] ? viewport : 'mobile', load,
      ok: !errors.length && done.every((c) => c.ok),
      summary: errors.length ? `发现 ${errors.length} 个报错/失败${list.length > errors.length ? `、${list.length - errors.length} 个警告` : ''}`
        : `没发现报错${list.length ? `（有 ${list.length} 个警告）` : ''}${done.some((c) => !c.ok) ? '，但有点击没点成' : ''}`,
      issues: list, snapshots,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------- HTTP ----------
// uid 格式：微博 / B 站是数字 id，X / Instagram 是用户名（不带 @），Weverse 是社区路径（weverse.io/<这段>），小红书是 24 位十六进制用户 id。
const READERS = {
  weibo: { search: weiboSearchUsers, timeline: weiboTimeline, uid: /^\d{1,20}$/ },
  x: { search: xSearchUsers, timeline: xTimeline, uid: /^\w{1,15}$/ },
  instagram: { search: igSearchUsers, timeline: igTimeline, uid: /^[\w.]{1,30}$/ },
  weverse: { search: weverseSearchUsers, timeline: weverseTimeline, uid: /^[\w-]{1,40}$/ },
  bilibili: { search: biliSearchUsers, timeline: biliTimeline, uid: /^\d{1,20}$/ },
  xiaohongshu: { search: xhsSearchUsers, timeline: xhsTimeline, uid: /^[0-9a-f]{24}$/i },
};

// JS 的 .slice() 按 UTF-16 截字符串，可能把 emoji 切成半个（孤立代理项 \ud83d）。
// 执行 agent（Python）收到后存库时会 UnicodeEncodeError，整个任务被标成失败，所以出口统一清掉。
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
    if (url.pathname === '/health') return send(res, 200, { ok: true, platforms: Object.keys(READERS), mode: B.mode });
    if (url.pathname === '/sessions') return send(res, 200, await sessions());
    if (url.pathname === '/login') {
      const platform = q.platform;
      if (!PLATFORMS[platform]?.loginUrl) return send(res, 400, { error: 'bad_platform', message: `不支持登录的平台：${platform}` });
      await serial(() => startLogin(platform), 60_000);
      return send(res, 200, {
        ok: true, mode: 'login', platform,
        message: `登录窗口已打开：请在窗口里自己登录 ${PLATFORMS[platform].label}（扫码或输入账号密码），登好后关掉窗口，或调用 /login/done。`,
      });
    }
    if (url.pathname === '/login/done') {
      await endLogin();
      return send(res, 200, { ok: true, ...(await sessions()) });
    }
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
    const label = (platform) => PLATFORMS[platform]?.label || platform;
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
    if (url.pathname === '/site/check') {
      const id = String(q.id || '').trim();
      if (!SITE_ID.test(id)) return send(res, 400, { error: 'bad_request', message: `网站 id 格式不对（应为 s_ 加 8 位十六进制）：${id.slice(0, 40)}` });
      const clicks = url.searchParams.getAll('click').map((c) => c.trim().slice(0, 100)).filter(Boolean);
      return send(res, 200, await serial(() => withLive(liveTask, 'site', `检查网页 · ${id}`, id,
        () => checkSite(id, { clicks, viewport: q.viewport })), 100_000));
    }
    if (url.pathname === '/xiaohongshu/search_notes') {
      const kw = (q.q || '').trim().slice(0, 60);
      if (!kw) return send(res, 400, { error: 'bad_request', message: 'search_notes 需要 q' });
      return send(res, 200, await serial(() => withLive(liveTask, 'xiaohongshu', `小红书 · 搜「${kw}」`, kw,
        () => xhsSearchNotes(kw, XHS_SORT[q.sort] ? q.sort : 'general'))));
    }
    const [, platform, action] = /^\/(\w+)\/(search_users|timeline)$/.exec(url.pathname) || [];
    const reader = READERS[platform];
    if (reader && action === 'search_users') {
      const name = (q.q || '').trim().slice(0, 60);
      if (!name) return send(res, 400, { error: 'bad_request', message: 'search_users 需要 q' });
      return send(res, 200, { users: await serial(() => withLive(liveTask, platform, `${label(platform)} · 搜账号「${name}」`, name, () => reader.search(name))) });
    }
    if (reader && action === 'timeline') {
      const uid = String(q.uid || '').trim().replace(/^@/, '');
      if (!reader.uid.test(uid)) return send(res, 400, { error: 'bad_request', message: `${platform} 的 uid 格式不对：${uid}` });
      const days = Math.min(30, Math.max(1, Number(q.days) || 7));
      const who = String(q.name || '').slice(0, 40) || uid;
      return send(res, 200, await serial(() => withLive(liveTask, platform, `${label(platform)} · 看 ${who} 最近 ${days} 天的帖子`, who, () => reader.timeline(uid, days))));
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
