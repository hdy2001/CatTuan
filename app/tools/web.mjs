import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { tool } from './common.mjs';
import { htmlToMarkdown, pageOf, unescapeHtml } from './extract.mjs';
import { clip, hostOf } from '../core/util.mjs';

const object = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const str = (description) => ({ type: 'string', ...(description ? { description } : {}) });
const photoId = (url) => createHash('sha1').update(url).digest('hex').slice(0, 8);
const cleanText = (value) => String(value ?? '').toWellFormed();
const cleanData = (value) => typeof value === 'string' ? cleanText(value) : Array.isArray(value) ? value.map(cleanData) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanData(v)])) : value;
const abort = (signal) => signal?.throwIfAborted();
const errorText = (err) => err?.message || String(err);
const integer = (value, fallback) => Number.isFinite(Number(value)) && value ? Math.trunc(Number(value)) : fallback;

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

// 搜索和读网页的后端：config.yaml 的 web.search_backend / web.fetch_backend 按名字选。写成列表时，前一个出错或没结果就用下一个。
// 加一个后端 = 在 createWebTools 的表里加一个函数，返回同样的格式；要 key 的从 ctx.env 读。
const DEFAULT_BACKENDS = { search: ['ddgs', 'browser'], fetch: ['http'] };
// 不少网站拦明显不是浏览器的请求，读网页时用普通浏览器的请求头
const BROWSER_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' };

export function createWebTools(ctx) {
  // GET 本机服务（沙箱、DDGS）的 JSON：有超时、大小上限，跟着取消
  const getJson = async (url, signal, timeoutMs, headers = {}) => {
    const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), headers });
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body || []) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw new Error('响应超过大小限制');
      chunks.push(chunk);
    }
    try { return cleanData(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch (err) { abort(signal); throw new Error(`${url.host} 返回了 ${response.status}`, { cause: err }); }
  };
  const sandbox = async (endpoint, params = {}, signal, timeoutMs = 120000) => {
    const url = new URL(endpoint, ctx.env?.CATTUAN_SANDBOX_URL || 'http://127.0.0.1:8660');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    // 带上任务编号：App 按它把沙箱的实时画面推给任务的主人
    return getJson(url, signal, timeoutMs, ctx.taskId ? { 'x-cattuan-task': ctx.taskId } : {});
  };
  const wrap = (fn, prefix = '') => async (args, signal) => {
    abort(signal);
    try { return await fn(args || {}, signal); }
    catch (err) { abort(signal); return { error: `${prefix}${errorText(err)}` }; }
  };

  // 搜索后端：({ query, limit }) → { results: [{ title, url, snippet }] }
  const searchBackends = {
    // 本机的 DDGS 服务（scripts/start-search.sh）：免费、不要 key，自己在几个搜索引擎之间轮换。
    // 它背后的引擎时不时被限流，同一个词再搜一次常常就有了，所以失败了先重试一次
    async ddgs({ query, limit }, signal) {
      const url = new URL('/search/text', ctx.env?.DDGS_URL || 'http://127.0.0.1:4479');
      url.search = new URLSearchParams({ query, max_results: limit, region: 'wt-wt' });
      for (let attempt = 1; ; attempt++) {
        const data = await getJson(url, signal, 30000);
        if (!data.detail) return { results: (data.results || []).map((r) => ({ title: r.title || '', url: r.href || r.url || '', snippet: r.body || '' })) };
        if (attempt < 2) continue;
        if (/no results found/i.test(String(data.detail))) return { results: [] };
        throw new Error(typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail));
      }
    },
    // 沙箱的真实浏览器里搜必应：慢，要排队，但有实时画面
    async browser({ query }, signal) {
      const data = await sandbox('/web/search', { q: query }, signal);
      if (data.error) throw new Error(data.message || data.error);
      return { results: data.results || [] };
    },
  };
  // 读网页后端：({ url }) → { url, status, contentType, title, text }
  const fetchBackends = {
    // 直接 HTTP 抓（不跑脚本）：HTML 提取正文转成 Markdown，JSON 和纯文本原样返回
    async http({ url }, signal) {
      const response = await fetchPublic(url, { signal, maxBytes: 20_000_000, timeoutMs: 30000, headers: BROWSER_HEADERS }); // SEC 的招股书这类文件有十几 MB
      if (response.status >= 400) throw new Error(`网页返回 ${response.status}${[401, 403, 429].includes(response.status) ? '（可能不让非浏览器访问，可以试 read_webpage）' : ''}`);
      const contentType = response.headers.get('content-type') || '';
      if (!/json|text|xml|javascript/i.test(contentType)) throw new Error(`不是文本内容（${contentType || '未知类型'}）`);
      const page = /html/i.test(contentType) ? htmlToMarkdown(response.text, response.url) : { title: '', text: response.text };
      return { url: response.url, status: response.status, contentType, ...page };
    },
  };
  const pages = new Map(); // web_fetch 最近读过的几个网页：网址 → 提取好的正文
  const backendNames = (kind) => [ctx.config?.().web?.[`${kind}_backend`] ?? DEFAULT_BACKENDS[kind]].flat().map(String);
  // 按配置依次试后端：出错或没有用的结果就换下一个；都出错时报最后一个错
  const viaBackends = async (kind, table, args, signal, useful) => {
    let out = null, failure = null;
    for (const name of backendNames(kind)) {
      try {
        if (!Object.hasOwn(table, name)) throw new Error(`没有叫 ${name} 的后端`);
        out = await table[name](args, signal);
        if (useful(out)) return out;
      } catch (err) { abort(signal); failure = err; }
    }
    if (out) return out;
    throw failure;
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
    tool('web_search', 'web', {
      label: '网页搜索', usesBrowser: backendNames('search').includes('browser'),
      describe: (a) => {
        const act = `搜「${clip(a.query, 40)}」`;
        return { act, done: (o) => {
          const rs = o.results || [];
          return { title: rs.length ? `${act}，找到 ${rs.length} 条结果` : `${act}，没有结果`, ok: rs.length > 0,
            detail: rs.length ? rs.slice(0, 4).map((r) => `${clip(r.title, 40)} · ${hostOf(r.url)}`).join('\n') : o.hint };
        } };
      },
      description: '搜网页，返回标题、网址和摘要（默认 5 条）。摘要不够时用 web_fetch 读原文。',
      parameters: object({ query: str('搜索词'), limit: { type: 'integer', description: '要几条结果，1–10，默认 5' } }, ['query']),
    }, wrap(async ({ query = '', limit }, signal) => {
      query = query.trim();
      if (!query) return { error: 'query 不能为空' };
      limit = Math.min(10, Math.max(1, integer(limit, 5)));
      const { results } = await viaBackends('search', searchBackends, { query, limit }, signal, (o) => o.results?.length > 0);
      const list = results.filter((r) => r.url && r.title).slice(0, limit).map((r, i) => ({ n: i + 1, title: r.title, url: r.url, snippet: clip(r.snippet || '', 300) }));
      return { query, results: list, ...(!list.length ? { hint: '没搜到，换个说法再试' } : {}) };
    }, '搜索失败：')),
    tool('web_fetch', 'web', {
      label: '读网页',
      describe: (a) => ({ act: `读 ${hostOf(a.url)}${a.find ? `里的「${clip(a.find, 20)}」` : ''}`, detail: a.url, done: (o) => (o.text
        ? { title: `读了「${clip(o.title || hostOf(o.url || a.url), 28)}」`, detail: [o.url || a.url, o.length > o.text.length ? `读了第 ${o.offset}–${o.offset + o.text.length} 字，全文约 ${o.length} 字` : `读到约 ${o.length} 字`, o.note].filter(Boolean).join('\n') }
        : { title: `读 ${hostOf(a.url)}，没读到内容`, detail: [a.url, o.note || o.error].filter(Boolean).join('\n'), ok: false }) }),
      description: '读一个公开网址（只 GET，不跑页面脚本）：网页提取正文转成 Markdown，JSON 和纯文本原样返回。一次最多返回 max_chars 字，长文用返回的 next_offset 接着读，或者用 find 直接跳到含某段文字的地方（比如章节标题）。读不到正文（靠脚本加载、要登录）时用 read_webpage 在浏览器里打开。不能访问内网。',
      parameters: object({
        url: str('http(s) 网址'),
        max_chars: { type: 'integer', description: '最多返回多少字，默认 12000' },
        offset: { type: 'integer', description: '从第几个字开始读（上次返回的 next_offset），默认 0' },
        find: str('跳到 offset 之后第一次出现这段文字的地方（不分大小写）'),
      }, ['url']),
    }, wrap(async ({ url = '', max_chars, offset, find = '' }, signal) => {
      url = url.trim();
      if (!url) return { error: 'url 不能为空' };
      const max = Math.min(40000, Math.max(2000, integer(max_chars, 12000)));
      // 同一个网址翻页时不重新下载、重新提取（大文档提取一次要好几秒）
      let page = pages.get(url);
      if (!page || Date.now() - page.at > 15 * 60_000) {
        page = { at: Date.now(), ...(await viaBackends('fetch', fetchBackends, { url }, signal, (o) => o.text?.trim().length > 0)) };
        pages.delete(url);
        pages.set(url, page);
        for (const key of [...pages.keys()].slice(0, -4)) pages.delete(key);
      }
      const text = String(page.text || '');
      const part = pageOf(text, { offset: integer(offset, 0), find: String(find).trim(), max });
      return { url: page.url || url, status: page.status, content_type: page.contentType, title: page.title || '', offset: part.start, length: text.length, text: part.text,
        ...(part.end < text.length && part.text && { next_offset: part.end }),
        ...(part.matches !== undefined && { matches: part.matches }),
        ...(find && !part.matches && { note: `没找到「${find}」` }),
        ...(!find && text.trim().length < 200 && /html/i.test(page.contentType || '') && { note: '没读到多少正文（可能靠脚本加载或要登录），可以用 read_webpage 在浏览器里打开' }) };
    }, '打不开：')),
    tool('read_webpage', 'web', {
      label: '用浏览器读网页', usesBrowser: true,
      describe: (a) => ({ act: `打开 ${hostOf(a.url)}`, detail: a.url, done: (o) => (o.text
        ? { title: `读了「${clip(o.title || hostOf(o.url || a.url), 28)}」`, detail: [o.url || a.url, `读到约 ${o.text.length} 字${o.truncated ? '（很长，只读了前面）' : ''}`, o.note].filter(Boolean).join('\n') }
        : { title: `打开 ${hostOf(a.url)}，没读到内容`, detail: [a.url, o.note].filter(Boolean).join('\n'), ok: false }) }),
      description: '在真实浏览器里打开网页读正文，能读靠脚本渲染的页面，比 web_fetch 慢。不会下载文件（PDF、压缩包等会被拒），不能登录、不能访问内网。返回标题和正文；读不到正文时 note 会说明原因，换个来源。',
      parameters: object({ url: str('网页地址') }, ['url']),
    }, wrap(async ({ url = '' }, signal) => {
      url = url.trim();
      if (!url) return { error: 'url 不能为空' };
      const data = await sandbox('/web/read', { url }, signal);
      if (data.error) return { url, error: data.message || data.error };
      const text = String(data.text || '');
      return { url: data.finalUrl || url, title: data.title || '', text: text.slice(0, 12000), ...(data.note ? { note: data.note } : {}), ...(text.length > 12000 ? { truncated: true } : {}) };
    }, '沙箱不可用：')),
    tool('image_search', 'images', {
      label: '搜图片',
      describe: (a) => {
        const act = `搜图「${clip((a.queries || [a.query]).filter(Boolean).join('、'), 30)}」`;
        return { act, done: (o) => ({ title: o.photos?.length ? `${act}，找到 ${o.photos.length} 张` : `${act}，没找到`, ok: !!o.photos?.length }) };
      },
      description: '按关键词搜网上的公开图片（人物、地点、商品、作品、活动现场等），可以按时间过滤只要最近的图。一次调用传多个关键词会并行搜索并合并去重，所以把同一样东西的几种叫法（中文名、外文名）放进同一次调用的 queries 里。关键词用名称本身效果最好；需要特定内容时再加一个具体词（地点、活动名、型号），不要加「高清」「图片」这类泛词。返回每张图的 id、标题、来源站点；要给用户看就挑好后用 attach 的 image_ids 附上。',
      parameters: object({ queries: { type: 'array', items: str(), maxItems: 4, description: '1–4 个关键词，例如 ["故宫 雪景", "Forbidden City snow"]' }, days: { type: 'integer', description: '只要最近多少天的图：1、7、30（默认 7；结果太少会自动放宽到 30）' }, offset: { type: 'integer', description: '翻页偏移，用户说「再来一些」时传 10、20…' } }, ['queries']),
    }, wrap(async (args, signal) => {
      const queries = (args.queries || (args.query ? [args.query] : [])).filter((q) => typeof q === 'string' && q.trim()).map((q) => q.trim()).slice(0, 4);
      if (!queries.length) return { error: 'queries is required' };
      let days = integer(args.days, 7);
      const offset = integer(args.offset, 0);
      let photos = await searchImages(queries, days, offset, signal);
      if (photos.length < 6 * queries.length && days < 30) { days = 30; photos = await searchImages(queries, days, offset, signal); }
      for (const photo of photos) ctx.media?.set(photo.id, photo); // attach 按 id 取
      return photos.length ? { queries, days, photos } : { queries, photos: [], hint: '没有结果，换个更短的关键词（比如只用名字）' };
    }, '搜索失败：')),
  ];
}
