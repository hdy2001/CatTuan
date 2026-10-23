import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchPublic, isPublicAddress, createWebTools, parseImages } from './web.mjs';

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

test('sandbox tools preserve task attribution and stable image ids', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cattuan-web-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [];
  const url = await listen(t, (req, res) => {
    calls.push({ url: req.url, task: req.headers['x-cattuan-task'] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'Result', url: 'https://example.com' }] }));
  });
  const tools = createWebTools({ home, sessionId: 'task-t_web', env: { CATTUAN_SANDBOX_URL: url } });
  const invoke = (name, args) => tools.find(tool => tool.name === name).execute(args);
  const found = await invoke('deep_web_search', { query: '测试' });
  assert.equal(found.results[0].n, 1);
  assert.equal(calls[0].task, 't_web');
  assert.equal(new URL(calls[0].url, url).searchParams.get('q'), '测试');
  assert.equal(tools.some(tool => ['official_account', 'official_photos', 'xiaohongshu_search'].includes(tool.name)), false);
  const item = { murl: 'https://example.com/image.png', turl: 'https://example.com/thumb.png', purl: 'https://example.com/page', t: 'Picture' };
  const html = `<a class="iusc" m="${JSON.stringify(item).replaceAll('"', '&quot;')}"></a>`;
  const first = parseImages(html, 'first')[0], second = parseImages(html, 'second')[0];
  assert.match(first.id, /^[a-f0-9]{8}$/);
  assert.equal(first.id, second.id);
});
