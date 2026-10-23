import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import path from 'node:path';
import { tool, readJson, writeJson, withFileLock } from './common.mjs';

const PLATFORMS = { weibo: '微博', x: 'X', instagram: 'Instagram', weverse: 'Weverse', bilibili: 'B 站', xiaohongshu: '小红书' };
const ALIASES = { '微博': 'weibo', twitter: 'x', '推特': 'x', ig: 'instagram', ins: 'instagram', 'b站': 'bilibili', 'b 站': 'bilibili', bili: 'bilibili', '哔哩哔哩': 'bilibili', '小红书': 'xiaohongshu', xhs: 'xiaohongshu', '红书': 'xiaohongshu', rednote: 'xiaohongshu' };
const platformProperty = { type: 'string', enum: Object.keys(PLATFORMS) };
const object = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const str = (description) => ({ type: 'string', ...(description ? { description } : {}) });
const photoId = (url) => createHash('sha1').update(url).digest('hex').slice(0, 8);
const cleanText = (value) => String(value ?? '').toWellFormed();
const cleanData = (value) => typeof value === 'string' ? cleanText(value) : Array.isArray(value) ? value.map(cleanData) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanData(v)])) : value;
const abort = (signal) => signal?.throwIfAborted();
const errorText = (err) => err?.message || String(err);
const integer = (value, fallback) => Number.isFinite(Number(value)) && value ? Math.trunc(Number(value)) : fallback;

function platform(value) {
  const raw = String(value || 'weibo').trim().toLowerCase();
  const result = ALIASES[raw] || raw;
  if (!Object.hasOwn(PLATFORMS, result)) throw new Error(`不支持的平台：${value}（可选 ${Object.keys(PLATFORMS).join(', ')}）`);
  return result;
}

function loginHint(label) {
  return `${label} 还没登录：请在喵团 App「+」→「社媒账号」点「登录 ${label}」，在弹出的窗口里自己登录（建议用小号），登好后关掉窗口再叫我。`;
}

function failure(plat, data) {
  const message = data.message || String(data.error);
  if (data.error === 'login_required') return { error: 'login_required', login_needed: [{ platform: plat, hint: message }], hint: `把这句话转告用户：${message}` };
  if (data.error === 'login_in_progress') return { error: data.error, hint: `${message}（告诉用户登录完关掉窗口后再试）` };
  return { error: `沙箱请求失败：${message}` };
}

function ipv6Number(address) {
  const parts = address.toLowerCase().split('::');
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts[1] ? parts[1].split(':') : [];
  const groups = parts.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((n, group) => (n << 16n) | BigInt(`0x${group}`), 0n);
}

/** Only globally routable unicast addresses are allowed for tool downloads. */
export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (family === 6) {
    const value = ipv6Number(address);
    if (value === null || (value >> 125n) !== 1n) return false; // 2000::/3 global unicast only
    const inPrefix = (base, bits) => (value >> BigInt(128 - bits)) === (ipv6Number(base) >> BigInt(128 - bits));
    return !inPrefix('2001::', 23) && !inPrefix('2001:db8::', 32) && !inPrefix('2002::', 16) && !inPrefix('3fff::', 20);
  }
  return false;
}

async function publicTarget(input, lookup, signal) {
  let url;
  try { url = new URL(input); } catch { throw new Error('只支持 http(s) 网址'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('只支持 http(s) 网址');
  if (url.username || url.password) throw new Error('网址不能包含登录凭据');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname.includes('%')) throw new Error('不能访问内网或本机地址');
  abort(signal);
  let cancelLookup;
  let addresses;
  try {
    addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        cancelLookup = () => reject(signal.reason);
        signal?.addEventListener('abort', cancelLookup, { once: true });
      }),
    ]);
  } finally { if (cancelLookup) signal?.removeEventListener('abort', cancelLookup); }
  abort(signal);
  if (!addresses?.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error('不能访问内网或本机地址');
  return { url, address: addresses[0] };
}

function requestText(url, address, { signal, maxBytes, request, headers }) {
  return new Promise((resolve, reject) => {
    abort(signal);
    // Pin the already validated address. DNS cannot change between validation and connect.
    const lookup = (_hostname, options, callback) => {
      if (typeof options === 'function') { callback = options; options = {}; }
      if (options?.all) callback(null, [address]);
      else callback(null, address.address, address.family);
    };
    const send = request || (url.protocol === 'https:' ? https.request : http.request);
    const req = send(url, { method: 'GET', agent: false, lookup, family: address.family, signal, headers: { 'User-Agent': 'CatTuan/0.1 (personal assistant)', 'Accept-Encoding': 'identity', ...headers } }, (res) => {
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('响应提前中断')));
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : String(value));
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && responseHeaders.get('location')) {
        resolve({ status, headers: responseHeaders, text: '', url: url.href });
        res.destroy();
        return;
      }
      const tooLarge = () => { const error = new Error('响应超过大小限制'); reject(error); res.destroy(error); };
      if (Number(responseHeaders.get('content-length') || 0) > maxBytes) { tooLarge(); return; }
      const chunks = [];
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) { tooLarge(); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status, headers: responseHeaders, text: bytes.toString('utf8'), bytes, url: url.href, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Bounded, read-only public HTTP(S) text fetch with DNS pinning on every redirect. */
export async function fetchPublic(input, { signal, maxBytes = 200000, timeoutMs = 15000, maxRedirects = 3, lookup = dnsLookup, request, headers } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let target = input;
  for (let hops = 0; ; hops++) {
    const { url, address } = await publicTarget(target, lookup, combined);
    const response = await requestText(url, address, { signal: combined, maxBytes, request, headers });
    if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.get('location')) return response;
    if (hops >= maxRedirects) throw new Error('网页跳转次数过多');
    target = new URL(response.headers.get('location'), url).href;
  }
}

const SHOP_HOSTS = ['taobao.', 'tmall.', 'jd.com', 'pinduoduo.', 'yangkeduo.', 'goofish.', 'xianyu', 'bunjang.', 'mercari', 'amazon.', 'ebay.', 'aliexpress.', 'rakuten.', 'coupang.', 'shopee.', 'temu.', '1688.com', 'suruga-ya', 'auctions.yahoo', 'joom.', 'etsy.', 'nin-nin-game.', 'play-asia.', 'amiami.', 'hlj.com', 'solarisjapan.', 'mandarake.', 'goodsmile.', 'tokyootakumode.', 'booth.pm', 'danbooru.', 'gelbooru.', 'safebooru.', 'yande.re', 'konachan.', 'rule34', 'e621.', 'sankakucomplex.'];
function unescapeHtml(input) {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return String(input || '').replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (whole, code) => {
    if (!code.startsWith('#')) return named[code.toLowerCase()] ?? whole;
    const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
  });
}

export function parseImages(html, query) {
  const out = [];
  for (const match of html.matchAll(/class=["']iusc["'][^>]*?\sm="([^"]+)"/g)) {
    let item;
    try { item = JSON.parse(unescapeHtml(match[1])); } catch { continue; }
    const image = item.murl, thumb = item.turl, page = item.purl || '';
    if (!image || !thumb || thumb.includes('explicit') || SHOP_HOSTS.some((host) => `${page} ${image}`.includes(host))) continue;
    let site;
    try { site = new URL(page || image).hostname; } catch { continue; }
    if (!/^https?:\/\//i.test(image) || !/^https?:\/\//i.test(thumb)) continue;
    out.push({ id: photoId(image), q: query, title: unescapeHtml(item.t).trim().slice(0, 80), site, image, thumb, page });
    if (out.length >= 10) break;
  }
  return out;
}

export function createWebTools(ctx) {
  const accountFile = path.join(ctx.home, 'official_accounts.json');
  const loadAccounts = async () => (await readJson(accountFile, [])).filter((entry) => entry && typeof entry === 'object').map((entry) => ({ ...entry, platform: entry.platform || 'weibo' }));
  const sandbox = async (endpoint, params = {}, signal, timeoutMs = 120000) => {
    const url = new URL(endpoint, ctx.env?.CATTUAN_SANDBOX_URL || 'http://127.0.0.1:8660');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const task = /^task-(t_[a-z0-9]+)$/.exec(String(ctx.sessionId || ''))?.[1];
    const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), headers: task ? { 'x-cattuan-task': task } : {} });
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body || []) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw new Error('沙箱响应超过大小限制');
      chunks.push(chunk);
    }
    try { return cleanData(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch (err) { abort(signal); throw new Error(`沙箱返回了 ${response.status}`, { cause: err }); }
  };
  const wrap = (fn, prefix = '') => async (args, signal) => {
    abort(signal);
    try { return await fn(args || {}, signal); }
    catch (err) { abort(signal); return { error: `${prefix}${errorText(err)}` }; }
  };
  const searchImages = async (queries, days, offset, signal) => {
    const batches = await Promise.all(queries.map(async (query) => {
      const params = new URLSearchParams({ q: query, first: Math.max(0, offset) + 1, count: 35, mmasync: 1, adlt: 'strict', qft: `+filterui:age-lt${Math.max(1, days) * 1440}` });
      const response = await fetchPublic(`https://www.bing.com/images/async?${params}`, { signal, maxBytes: 2000000, timeoutMs: 20000, headers: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6' } });
      if (response.status >= 400) throw new Error(`图片搜索返回 ${response.status}`);
      return parseImages(response.text, query);
    }));
    const merged = [], seen = new Set();
    for (let i = 0; i < 10; i++) for (const batch of batches) if (batch[i] && !seen.has(batch[i].id)) { seen.add(batch[i].id); merged.push(batch[i]); }
    return merged.slice(0, 30);
  };
  return [
    tool('deep_web_search', 'deepsearch', {
      description: '用必应搜网页（在真实浏览器里搜，中文结果好）。深度搜索时多换几个角度的关键词：官方说法、对比、评测、时间范围、反方观点。返回标题、网址和摘要；摘要不够就用 read_webpage 读原文。',
      parameters: object({ query: str('搜索词，例如「看天下 杂志 图书馆 数字资源」') }, ['query']),
    }, wrap(async ({ query = '' }, signal) => {
      query = query.trim();
      if (!query) return { error: 'query 不能为空' };
      const data = await sandbox('/web/search', { q: query }, signal);
      if (data.error) return { error: data.message || data.error };
      const results = (data.results || []).map((result, i) => ({ n: i + 1, ...result }));
      return { query, results, ...(!results.length ? { hint: '没搜到，换个说法再试' } : {}) };
    }, '沙箱不可用：')),
    tool('read_webpage', 'deepsearch', {
      description: '打开一个网页读正文（在真实浏览器里打开，能读靠脚本渲染的页面）。不会下载文件（PDF、压缩包等会被拒），不能登录、不能访问内网。返回标题和正文；读不到正文时 note 会说明原因，换个来源。',
      parameters: object({ url: str('网页地址（通常来自 deep_web_search 的结果）') }, ['url']),
    }, wrap(async ({ url = '' }, signal) => {
      url = url.trim();
      if (!url) return { error: 'url 不能为空' };
      const data = await sandbox('/web/read', { url }, signal);
      if (data.error) return { url, error: data.message || data.error };
      const text = String(data.text || '');
      return { url: data.finalUrl || url, title: data.title || '', text: text.slice(0, 12000), ...(data.note ? { note: data.note } : {}), ...(text.length > 12000 ? { truncated: true } : {}) };
    }, '沙箱不可用：')),
    tool('idol_photo_search', 'idol', {
      description: '按关键词搜网上的公开图片（人物、地点、商品、作品、活动现场等），可以按时间过滤只要最近的图。一次调用传多个关键词会并行搜索并合并去重，所以把同一样东西的几种叫法（中文名、外文名）放进同一次调用的 queries 里。关键词用名称本身效果最好；需要特定内容时再加一个具体词（地点、活动名、型号），不要加「高清」「图片」这类泛词。返回每张图的 id、标题、来源站点。选好后在回复末尾单独一行写 `GALLERY: id1,id2,...`（按展示顺序），App 会渲染成图墙。',
      parameters: object({ queries: { type: 'array', items: str(), maxItems: 4, description: '1–4 个关键词，例如 ["故宫 雪景", "Forbidden City snow"]' }, days: { type: 'integer', description: '只要最近多少天的图：1、7、30（默认 7；结果太少会自动放宽到 30）' }, offset: { type: 'integer', description: '翻页偏移，用户说「再来一些」时传 10、20…' } }, ['queries']),
    }, wrap(async (args, signal) => {
      const queries = (args.queries || (args.query ? [args.query] : [])).filter((q) => typeof q === 'string' && q.trim()).map((q) => q.trim()).slice(0, 4);
      if (!queries.length) return { error: 'queries is required' };
      let days = integer(args.days, 7);
      const offset = integer(args.offset, 0);
      let photos = await searchImages(queries, days, offset, signal);
      if (photos.length < 6 * queries.length && days < 30) { days = 30; photos = await searchImages(queries, days, offset, signal); }
      return photos.length ? { queries, days, photos } : { queries, photos: [], hint: '没有结果，换个更短的关键词（比如只用名字）' };
    }, '搜索失败：')),
    tool('official_account', 'idol', {
      description: '管理用户关注的社媒账号（品牌、机构、媒体、博主、个人公开主页等任何公开账号都可以），支持微博(weibo)、X(x)、Instagram(instagram)、Weverse(weverse)、B 站(bilibili)、小红书(xiaohongshu，需登录)。action=find 在 platform 上按名字搜账号（返回认证信息和粉丝数）；action=follow 把账号加入关注列表（之后 official_photos 会读它）；action=unfollow 取消；action=list 列出已关注；action=status 查看各平台是否已在沙箱里登录。X / Instagram / Weverse 需要用户先在 App「+」→「社媒账号」点登录、在弹出的窗口里自己登录；没登录时返回 login_needed，把其中的 hint 原样转告用户，不要换别的平台冒充。同名账号多时，优先选认证信息是本人、品牌或机构官方的账号；用户点名某个具体账号就直接关注那个。uid：微博 / B 站用数字 id，X / Instagram 用用户名（不带 @），Weverse 用社区路径（weverse.io/ 后面那段，如 seventeen）。',
      parameters: object({ action: { type: 'string', enum: ['find', 'follow', 'unfollow', 'list', 'status'] }, platform: { ...platformProperty, description: 'find/follow/unfollow：哪个平台（默认 weibo）。用户说推特就是 x，ins 就是 instagram' }, name: str('find：搜索的名字，例如「LongCat」「北京地铁」'), idol: str('follow：这个账号属于谁或什么主题（人名、品牌、话题），例如「LongCat」「北京地铁」'), uid: str('follow/unfollow：find 结果里的 uid'), account_name: str('follow：账号昵称') }, ['action']),
    }, wrap(async (args, signal) => {
      const { action } = args;
      if (action === 'status') {
        const data = await sandbox('/sessions', {}, signal, 90000);
        if (data.error) return { error: data.message || data.error };
        return { mode: data.mode, platforms: (data.platforms || []).map((p) => ({ platform: p.id, label: p.label, logged_in: p.loggedIn, needs_login: p.needsLogin, ...(p.needsLogin && !p.loggedIn ? { hint: loginHint(p.label) } : {}) })) };
      }
      const plat = platform(args.platform);
      if (action === 'find') {
        const name = (args.name || '').trim();
        if (!name) return { error: 'find 需要 name' };
        const data = await sandbox(`/${plat}/search_users`, { q: name }, signal, 90000);
        return data.error ? failure(plat, data) : { platform: plat, candidates: data.users || [] };
      }
      return withFileLock(accountFile, async () => {
        abort(signal);
        let accounts = await loadAccounts();
        if (action === 'list') return { accounts };
        if (!['follow', 'unfollow'].includes(action)) return { error: `未知 action：${action}` };
        const uid = String(args.uid || '').trim().replace(/^@+/, '');
        if (!uid) return { error: `${action} 需要 uid` };
        if (action === 'follow') {
          accounts = accounts.filter((a) => !(a.platform === plat && a.uid.toLowerCase() === uid.toLowerCase()));
          accounts.push({ platform: plat, uid, name: args.account_name || uid, idol: (args.idol || '').trim() });
          abort(signal);
          await writeJson(accountFile, accounts);
          return { ok: true, accounts };
        }
        accounts = accounts.filter((a) => !((!args.platform || a.platform === plat) && a.uid.toLowerCase() === uid.toLowerCase()));
        abort(signal);
        await writeJson(accountFile, accounts);
        return { ok: true };
      }, signal);
    }, '沙箱不可用或请求失败：')),
    tool('official_photos', 'idol', {
      description: '读取社媒账号最近 N 天发布的帖子（文字和原图），想知道某个账号最近发了什么、有没有新动态时用它，比搜索引擎更准更新。默认读已关注的账号；用户临时想看某个没关注的公开账号时，先 official_account find 拿到 uid，再把它放进 accounts 直接读，不用先关注。用户点名某个平台（X/推特、Instagram、Weverse、B 站、微博）时填 platform，只读那个平台。账号内容很杂时，用 keywords 过滤出相关的帖子（中文名、英文名等不同叫法都放进去）。返回 posts（帖子文本+图片 id）和 photos；选好后回复末尾写 `GALLERY: id1,id2,...`。返回 login_needed 时，把其中的 hint 告诉用户（去 App「+」→「社媒账号」点登录）。',
      parameters: object({ accounts: { type: 'array', description: '直接读这些账号（不用先关注），uid 来自 official_account find 的结果；填了就不读关注列表', items: object({ platform: platformProperty, uid: str(), name: str() }, ['platform', 'uid']) }, platform: { ...platformProperty, description: '只读这个平台的账号；不填读全部已关注账号' }, idol: str('只读 follow 时 idol 填了这个值的账号；不填则读全部'), days: { type: 'integer', description: '最近多少天（默认 7，最多 30）' }, keywords: { type: 'array', items: str(), description: '帖子文本需包含其中任一词，例如 ["发布会", "launch"]；不填不过滤' } }),
    }, wrap(async (args, signal) => {
      const days = Math.min(30, Math.max(1, integer(args.days, 7)));
      const keywords = (args.keywords || []).filter((k) => typeof k === 'string' && k.trim()).map((k) => k.toLowerCase());
      const plat = args.platform ? platform(args.platform) : null;
      let accounts;
      if (args.accounts?.length) {
        accounts = args.accounts.filter((a) => a && typeof a === 'object').map((a) => ({ platform: platform(a.platform), uid: String(a.uid || '').trim(), name: a.name || String(a.uid || '') })).filter((a) => a.uid).slice(0, 6);
        if (!accounts.length) return { error: 'accounts 里要有 platform 和 uid（先用 official_account find 拿 uid）' };
      } else {
        accounts = (await loadAccounts()).filter((a) => !plat || a.platform === plat);
        if (!accounts.length) return { error: `还没有关注${plat ? ` ${PLATFORMS[plat]} 上的` : '任何'}账号：先 official_account find（platform=${plat || 'weibo'}）拿到 uid，再 follow，或者把它放进 accounts 直接读` };
        const filtered = accounts.filter((a) => !args.idol?.trim() || a.idol === args.idol.trim());
        if (filtered.length) accounts = filtered;
      }
      if (plat) accounts = accounts.filter((a) => a.platform === plat);
      const found = [], errors = [], notes = [], logins = new Map();
      for (const account of accounts) {
        abort(signal);
        if (logins.has(account.platform)) continue;
        let data;
        try { data = await sandbox(`/${account.platform}/timeline`, { uid: account.uid, days, name: account.name || '' }, signal, 90000); }
        catch (err) { abort(signal); errors.push(`${PLATFORMS[account.platform]} ${account.name}: ${errorText(err)}`); continue; }
        if (data.error === 'login_required') { logins.set(account.platform, data.message || loginHint(PLATFORMS[account.platform])); continue; }
        if (data.error) { errors.push(`${PLATFORMS[account.platform]} ${account.name}: ${data.message || data.error}`); continue; }
        if (data.note) notes.push(data.note);
        for (const post of data.posts || []) if (!keywords.length || keywords.some((k) => String(post.text || '').toLowerCase().includes(k))) found.push([account.platform, post]);
      }
      found.sort((a, b) => (Number(b[1].ts) || 0) - (Number(a[1].ts) || 0));
      const posts = [], photos = [], seen = new Set();
      for (const [p, post] of found) {
        if (photos.length >= 40) break;
        const ids = [];
        for (const image of post.images || []) {
          if (!image.large) continue;
          const id = photoId(image.large);
          if (seen.has(id)) { ids.push(id); continue; }
          if (photos.length >= 40) break;
          ids.push(id); seen.add(id);
          photos.push({ id, title: String(post.text || '').slice(0, 50), site: p === 'weverse' ? `${PLATFORMS[p]} · ${post.author}` : `${PLATFORMS[p]} @${post.author}`, image: image.large, thumb: image.thumb, page: post.url, at: post.at });
        }
        posts.push({ post: post.post_id, platform: p, account: post.author, at: String(post.at || '').slice(0, 16), text: post.text, photos: ids });
      }
      return { days, posts, photos, ...(logins.size ? { login_needed: [...logins].map(([p, hint]) => ({ platform: p, hint })) } : {}), ...(errors.length ? { errors } : {}), ...(notes.length ? { notes } : {}), ...(!posts.length ? { hint: logins.size && logins.size === new Set(accounts.map((a) => a.platform)).size ? '这些平台需要先登录，把 login_needed 里的 hint 转告用户' : '这些账号这段时间没有符合条件的帖子，可以放宽 days、去掉 keywords，或改用搜索' } : {}) };
    })),
    tool('xiaohongshu_search', 'idol', {
      description: '按关键词搜小红书笔记（需要用户在 App「+」→「社媒账号」登录小红书）。适合：附近美食/店铺/景点/攻略、某个活动或地点的实拍、经验分享、攻略测评等任何「去小红书搜一下」的事。问「附近」时，用【用户当前位置】里的街道或区名拼关键词，例如「望京 美食」「朝阳区 咖啡」；只写城市太宽。返回笔记标题、作者、点赞数、发布时间、链接和封面图 id；挑好后回复末尾写 `GALLERY: id1,id2,...`。笔记是网友分享，不是官方信息，转述时说清楚。返回 login_needed 时把 hint 原样告诉用户。',
      parameters: object({ query: str('搜索词，例如「望京 美食」「音乐节 上海 返图」'), sort: { type: 'string', enum: ['general', 'latest', 'popular'], description: 'general 综合（默认）、latest 最新、popular 最热' }, count: { type: 'integer', description: '返回多少条（默认 12，最多 20）' } }, ['query']),
    }, wrap(async ({ query = '', sort, count }, signal) => {
      query = query.trim();
      if (!query) return { error: 'query 不能为空' };
      sort = ['general', 'latest', 'popular'].includes(sort) ? sort : 'general';
      count = Math.min(20, Math.max(1, integer(count, 12)));
      const data = await sandbox('/xiaohongshu/search_notes', { q: query, sort }, signal);
      if (data.error === 'login_required') return { login_needed: { xiaohongshu: data.message || loginHint('小红书') } };
      if (data.error) return { error: data.message || data.error };
      const notes = [], photos = [];
      for (const note of (data.notes || []).slice(0, count)) {
        const ids = [];
        for (const image of (note.images || []).slice(0, 1)) {
          if (!image.large) continue;
          const id = photoId(image.large); ids.push(id);
          photos.push({ id, title: String(note.text || '').slice(0, 50), site: `小红书 @${note.author}`, image: image.large, thumb: image.thumb || image.large, page: note.url, at: note.at });
        }
        notes.push({ note: note.post_id, title: note.text, author: note.author, likes: note.likes, at: String(note.at || '').slice(0, 10), url: note.url, photos: ids });
      }
      return { query, sort, notes, photos, ...(!notes.length ? { hint: '没搜到，换个说法试试（比如换成区名，或去掉太具体的词）' } : {}) };
    }, '沙箱不可用：')),
    tool('fetch_url', 'skillstore', {
      description: '只读地打开一个公开网址（GET），返回正文文本或 JSON（最多约 1.2 万字）。给技能用：查天气（wttr.in?format=j2）、汇率、公开 API、文章正文。不能访问内网地址，不能提交表单或登录。社媒平台请用 official_photos / xiaohongshu_search，不要用它抓。',
      parameters: object({ url: str('http(s) 网址') }, ['url']),
    }, wrap(async ({ url = '' }, signal) => {
      const response = await fetchPublic(url.trim(), { signal });
      const contentType = response.headers.get('content-type') || '';
      if (!/json|text|xml|javascript/i.test(contentType)) return { error: `不是文本内容（${contentType || '未知类型'}）` };
      let text = response.text;
      if (/html/i.test(contentType)) text = unescapeHtml(text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
      return { status: response.status, content_type: contentType, text: text.slice(0, 12000) };
    }, '打不开：')),
  ];
}
