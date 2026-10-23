import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createBusinessTools } from './business.mjs';
import { createToolContext } from '../pi-tools.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cattuan-business-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
const invoke = (ctx, name, args = {}) => createBusinessTools(ctx).find(tool => tool.name === name).execute(args);

test('concurrent ledger writes retain every entry and invalid batches leave data intact', async t => {
  const home = fixture(t), ctx = { home };
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => invoke(ctx, 'ledger_add', { entries: [{ amount: i + 1, category: '餐饮' }] })));
  assert.ok(results.every(result => result.ok), JSON.stringify(results));
  const queried = await invoke(ctx, 'ledger_query');
  assert.equal(queried.count, 12);
  assert.equal(queried.summary.totalExpense, 78);
  const file = path.join(home, 'ledger/entries.json'), before = fs.readFileSync(file, 'utf8');
  assert.ok((await invoke(ctx, 'ledger_add', { entries: [{ amount: 5 }, { amount: 'invalid' }] })).error);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const id = results[0].added[0].id;
  await invoke(ctx, 'ledger_delete', { ids: [id] });
  assert.equal((await invoke(ctx, 'ledger_query')).summary.totalExpense, 77);
});

test('site updates preserve versions and refuse another home or linked files', async t => {
  const home = fixture(t), other = fixture(t), ctx = { home };
  const first = await invoke(ctx, 'publish_site', { title: '测试', html: '<h1>One</h1>' });
  assert.equal(first.site.version, 1);
  const id = first.site.id;
  const second = await invoke(ctx, 'publish_site', { title: '更新', html: '<h1>Two</h1>', site_id: id });
  assert.equal(second.site.version, 2);
  assert.match((await invoke(ctx, 'read_site', { site_id: id })).html, /Two/);
  assert.match(fs.readFileSync(path.join(home, 'sites', id, 'index.prev.html'), 'utf8'), /One/);
  assert.ok((await invoke({ home: other }, 'read_site', { site_id: id })).error);
  fs.mkdirSync(path.join(other, 'sites'));
  fs.symlinkSync(path.join(home, 'sites', id), path.join(other, 'sites', id));
  assert.ok((await invoke({ home: other }, 'read_site', { site_id: id })).error);
  assert.ok((await invoke(ctx, 'publish_site', { title: 'bad', html: 'bad', site_id: '../../outside' })).error);
  fs.mkdirSync(path.join(home, 'ledger'));
  fs.writeFileSync(path.join(home, 'ledger/entries.json'), '[]');
  fs.symlinkSync(path.join(home, 'ledger'), path.join(other, 'ledger'));
  assert.ok((await invoke({ home: other }, 'ledger_add', { entries: [{ amount: 1, category: '其他' }] })).error);
  assert.equal(fs.readFileSync(path.join(home, 'ledger/entries.json'), 'utf8'), '[]');
});

test('phone tool uses the owning account key and trusted task session', async t => {
  const home = fixture(t);
  fs.writeFileSync(path.join(home, '.env'), 'API_SERVER_KEY=owner-key\n');
  let received;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = { path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ dialed: false, result: 'test-only, no call placed' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const ctx = createToolContext({ home, sessionId: 'task-t_owner', env: { API_SERVER_KEY: 'wrong', CATTUAN_APP_URL: `http://127.0.0.1:${server.address().port}` } });
  assert.equal((await invoke(ctx, 'phone_call', { to: 'test-number', name: 'test', goal: 'test', mode: 'ask', session_id: 'forged' })).dialed, false);
  assert.equal(received.path, '/api/agent/call');
  assert.equal(received.headers.authorization, 'Bearer owner-key');
  assert.equal(received.headers['x-cattuan-task'], 't_owner');
  assert.equal(received.body.session_id, 'task-t_owner');
});
