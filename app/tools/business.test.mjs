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
