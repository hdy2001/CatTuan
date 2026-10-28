import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchPublic, isPublicAddress, createWebTools, parseImages } from './web.mjs';
import { htmlToMarkdown, pageOf } from './extract.mjs';

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('public downloads reject local/reserved addresses and mixed DNS answers', async () => {
  for (const value of ['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1']) assert.equal(isPublicAddress(value), false, value);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  for (const url of ['http://127.0.0.1', 'http://[::1]', 'http://2130706433', 'file:///tmp/test', 'https://user:password@example.com']) await assert.rejects(fetchPublic(url));
  await assert.rejects(fetchPublic('https://example.com', { lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] }), /内网/);
});

test('public downloads pin DNS, revalidate redirects, preserve bytes and enforce limits', async t => {
  const local = await listen(t, (req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: 'http://127.0.0.1/private' }); return res.end(); }
    if (req.url === '/next') { res.writeHead(302, { location: '/bytes' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.from([0, 128, 255, 42]));
  });
  let requests = 0;
  const options = {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: (url, opts, callback) => {
      requests++;
      opts.lookup(url.hostname, {}, (_error, address, family) => { assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
      return http.request(local + url.pathname, { ...opts, lookup: undefined }, callback);
    },
  };
  assert.deepEqual((await fetchPublic('http://example.com/next', options)).bytes, Buffer.from([0, 128, 255, 42]));
  assert.equal(requests, 2);
  await assert.rejects(fetchPublic('http://example.com/redirect', options), /内网/);
  assert.equal(requests, 3, 'No request is made to the redirected private address');
  await assert.rejects(fetchPublic('http://example.com/bytes', { ...options, maxBytes: 2 }), /大小限制/);
});

test('search falls back from DDGS to the sandbox browser, and sandbox calls carry the task id', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cattuan-web-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [];
  const url = await listen(t, (req, res) => {
    calls.push({ url: req.url, task: req.headers['x-cattuan-task'] });
    if (req.url.startsWith('/search/text')) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ detail: 'Search failed: No results found.' })); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'Result', url: 'https://example.com' }] }));
  });
  const tools = createWebTools({ home, sessionId: 'task-t_web', taskId: 't_web', env: { CATTUAN_SANDBOX_URL: url, DDGS_URL: url } });
  const invoke = (name, args) => tools.find(tool => tool.name === name).execute(args);
  const found = await invoke('web_search', { query: '测试' });
  assert.equal(found.results[0].n, 1);
  assert.deepEqual(calls.map(c => new URL(c.url, url).pathname), ['/search/text', '/search/text', '/web/search'], 'DDGS is retried once before falling back');
  assert.equal(new URL(calls[0].url, url).searchParams.get('query'), '测试');
  assert.equal(new URL(calls[2].url, url).searchParams.get('q'), '测试');
  assert.equal(calls[2].task, 't_web');
  assert.deepEqual(tools.map(tool => tool.name), ['web_search', 'web_fetch', 'read_webpage', 'image_search']);
  assert.ok(tools.find(tool => tool.name === 'read_webpage').usesBrowser);
  assert.equal(tools[0].describe({ query: '测试' }).done({ results: [{ title: 'A', url: 'https://www.example.com/x' }] }).title, '搜「测试」，找到 1 条结果');
  const item = { murl: 'https://example.com/image.png', turl: 'https://example.com/thumb.png', purl: 'https://example.com/page', t: 'Picture' };
  const html = `<a class="iusc" m="${JSON.stringify(item).replaceAll('"', '&quot;')}"></a>`;
  const first = parseImages(html, 'first')[0], second = parseImages(html, 'second')[0];
  assert.match(first.id, /^[a-f0-9]{8}$/);
  assert.equal(first.id, second.id);
});

test('search backends come from config: DDGS results are normalized, a chosen backend does not fall back', async t => {
  const calls = [];
  let fail = false, failNext = 0;
  const url = await listen(t, (req, res) => {
    calls.push(new URL(req.url, 'http://x'));
    if (failNext && failNext--) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ detail: 'Search failed: No results found.' })); }
    res.writeHead(fail ? 500 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(fail ? { detail: 'Search failed: engine down' } : { results: Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, href: `https://example.com/${i}`, body: 'x'.repeat(400) })) }));
  });
  let config = { web: { search_backend: 'ddgs' } };
  const tools = createWebTools({ home: os.tmpdir(), config: () => config, env: { CATTUAN_SANDBOX_URL: url, DDGS_URL: url } });
  const search = (args) => tools.find(tool => tool.name === 'web_search').execute(args);
  assert.equal(tools[0].usesBrowser, false, 'only the browser backend shows the live view');
  const out = await search({ query: 'q', limit: 3 });
  assert.deepEqual(out.results.map(r => r.url), ['https://example.com/0', 'https://example.com/1', 'https://example.com/2']);
  assert.ok(out.results[0].snippet.length <= 301);
  assert.equal(calls[0].searchParams.get('max_results'), '3');
  failNext = 1;
  assert.equal((await search({ query: 'q' })).results.length, 5, 'a flaky DDGS answer is retried once');
  assert.equal(calls.length, 3);
  fail = true;
  assert.match((await search({ query: 'q' })).error, /engine down/);
  assert.ok(calls.every(u => u.pathname === '/search/text'), 'an explicitly chosen backend never falls back');
  config = { web: { search_backend: ['nope'] } };
  assert.match((await search({ query: 'q' })).error, /没有叫 nope 的后端/);
  assert.match((await search({ query: ' ' })).error, /不能为空/);
});

test('web_fetch extracts readable Markdown, pages through long documents, and refuses private addresses', async () => {
  const html = `<html><head><title>店铺介绍</title></head><body><nav><a href="/">首页</a></nav>
    <article><h1>蓝果中古</h1><p>${'营业时间是每天 10 点到 22 点。'.repeat(20)}</p>
    <ul><li>地址：<a href="/map?id=1">望京 SOHO</a></li><li></li></ul><table><tr><th>项目</th><th>价格</th></tr><tr><td>戒指</td><td>300</td></tr></table>
    <script>alert(1)</script></article></body></html>`;
  const page = htmlToMarkdown(html, 'https://shop.example.com/about');
  assert.equal(page.title, '店铺介绍');
  assert.match(page.text, /营业时间是每天 10 点到 22 点/);
  assert.match(page.text, /- 地址：\[望京 SOHO\]\(https:\/\/shop\.example\.com\/map\?id=1\)/);
  assert.match(page.text, /\| 戒指 \| 300 \|/);
  assert.doesNotMatch(page.text, /alert|首页/);
  assert.doesNotMatch(page.text, /^- $/m, 'empty list items are dropped');
  // 十几 MB 的申报文件不走 Readability：正则转文本，表格按 | 分格
  const big = `<html><head><title>S-1 &amp; more</title><style>x{}</style></head><body>${'<p>filler text</p>'.repeat(130000)}<table><tr><td><p>Revenue</p></td><td></td><td>$</td><td><p>1,234</p></td><td>)</td></tr></table><script>bad()</script></body></html>`;
  const rough = htmlToMarkdown(big, 'https://example.com/');
  assert.equal(rough.title, 'S-1 & more');
  assert.match(rough.text, /^\| Revenue \| \$1,234\) \|$/m, 'a table row stays on one line');
  assert.doesNotMatch(rough.text, /bad\(\)|x\{\}/);
  const doc = `${'前言。'.repeat(3000)}Consolidated Statements of\nOperations\n收入 100${'附注。'.repeat(3000)}consolidated statements of operations 第二处`;
  const first = pageOf(doc, { max: 2000 });
  assert.equal(first.start, 0);
  assert.equal(first.end, 2000);
  const next = pageOf(doc, { offset: first.end, max: 2000 });
  assert.equal(next.start, 2000);
  const hit = pageOf(doc, { find: 'consolidated STATEMENTS of operations', max: 2000 });
  assert.equal(hit.matches, 2);
  assert.ok(hit.start === 9000 - 200 && hit.text.includes('收入 100'), 'find jumps to the first match with a little context');
  const second = pageOf(doc, { offset: hit.start + 300, find: 'consolidated statements of operations', max: 2000 });
  assert.match(second.text, /第二处/);
  assert.deepEqual(pageOf(doc, { find: '不存在', max: 2000 }), { start: 0, end: 0, text: '', matches: 0 });
  assert.equal(pageOf(doc, { find: 'a.b(', max: 10 }).matches, 0, 'find is plain text, not a regex');
  const tools = createWebTools({ home: os.tmpdir(), env: {} });
  const fetchTool = tools.find(tool => tool.name === 'web_fetch');
  assert.match((await fetchTool.execute({ url: 'http://127.0.0.1:1/x' })).error, /内网/);
  assert.match((await fetchTool.execute({ url: 'file:///etc/passwd' })).error, /只支持 http/);
});
