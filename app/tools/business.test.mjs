import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBusinessTools } from './business.mjs';
import { createToolContext } from '../agent/tools.mjs';

test('the phone tool hands the call to the App service with cancellation, progress and the user\'s config', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cattuan-business-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let received;
  const services = { phone: async (args, opts) => { received = { args, opts }; opts.progress({ stage: 'dialing' }); return { dialed: false, result: 'test-only, no call placed' }; } };
  fs.writeFileSync(path.join(home, '.env'), 'JUPITER_TENANT_ID=from-home\n');
  const ctx = createToolContext({ home, sessionId: 'task-t_owner', taskId: 't_owner', services, env: { JUPITER_ROUTE_POINT: 'global', JUPITER_TENANT_ID: 'global' } });
  const phone = createBusinessTools(ctx).find((tool) => tool.name === 'phone_call');
  const progress = [];
  const controller = new AbortController();
  assert.equal((await phone.execute({ to: 'test-number', name: 'test', goal: 'test', mode: 'ask' }, controller.signal, (p) => progress.push(p))).dialed, false);
  assert.equal(received.args.to, 'test-number');
  assert.equal(received.opts.signal, controller.signal);
  assert.deepEqual([received.opts.env.JUPITER_TENANT_ID, received.opts.env.JUPITER_ROUTE_POINT], ['from-home', 'global'], 'per-account .env overrides the global config');
  assert.equal(phone.timeoutMs, 15 * 60_000);
  assert.deepEqual(progress, [{ stage: 'dialing' }]);
  assert.equal(phone.describe({ name: '栗子美甲' }).act, '给「栗子美甲」打电话');

  const without = createBusinessTools(createToolContext({ home })).find((tool) => tool.name === 'phone_call');
  assert.equal((await without.execute({ to: '1' })).dialed, false);
});
