import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCalls } from './calls.mjs';
import { createMockProvider } from './mock-provider.mjs';

function fixture(t, outcome) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cattuan-calls-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const llm = { complete: async () => ({ lines: [{ who: 'ai', text: '您好' }, { who: 'shop', text: '有位' }], answers: { 价格: '98' }, summary: '下午三点有位，98 元' }) };
  const provider = createMockProvider({ llm, agent: '喵团', line: '美团专线', env: { CALL_SPEED: '0', CALL_MOCK_OUTCOME: outcome } });
  return { u: { id: 'u_1', name: '小王', dir }, calls: createCalls({ llm, provider }) };
}

test('a call reports progress, keeps a record and returns the call card as an attachment', async (t) => {
  const { u, calls } = fixture(t, 'answered');
  const stages = [];
  const r = await calls.place(u, { id: 't_1', round: 2 }, { to: '010-12345678', name: '栗子美甲（和平里店）', goal: '问问下午三点有没有位', mode: 'ask' }, (p) => stages.push(p.call.stage));
  assert.deepEqual(stages, ['queued', 'dialing', 'talking', 'done']);
  assert.equal(r.connected, true);
  assert.equal(r.summary, '下午三点有位，98 元');
  assert.match(r.transcript, /喵团：您好\n店员：有位/);
  assert.equal(r.calls_left_today, 1);
  const [rec] = calls.list(u);
  assert.equal(rec.short, '栗子美甲');
  assert.equal(rec.taskId, 't_1');
  assert.equal(rec.round, 2);
  assert.deepEqual(r.attachments, [{ type: 'calls', calls: [rec] }]);
});

test('the platform rules: a number is required and each number is dialed at most twice a day', async (t) => {
  const { u, calls } = fixture(t, 'no_answer');
  assert.equal((await calls.place(u, null, { name: '没号码', goal: 'x' })).outcome, 'no_number');
  const first = await calls.place(u, null, { to: '010-1', name: 'A', goal: 'x', mode: 'ask' });
  assert.equal(first.connected, false);
  assert.equal(first.retry, 'later');
  const second = await calls.place(u, null, { to: '010-1', name: 'A', goal: 'x', mode: 'ask' });
  assert.equal(second.retry, 'tomorrow', 'no calls left today turns a later retry into tomorrow');
  const third = await calls.place(u, null, { to: '0101', name: 'A', goal: 'x', mode: 'ask' });
  assert.equal(third.dialed, false);
  assert.equal(third.outcome, 'freq_limit');
  assert.equal(calls.list(u).length, 3);
});
