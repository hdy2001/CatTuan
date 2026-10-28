import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCalls } from './calls.mjs';

// 假的外呼平台：按 dial 的约定回话，记下收到了什么
function fixture(t, dial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cattuan-calls-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const seen = [];
  const provider = { dial: async (req, opts) => { seen.push({ req, opts }); return dial(req, opts); } };
  return { u: { id: 'u_1', name: '小王', dir }, seen, calls: createCalls({ llm: null, provider }) };
}
const answered = { status: 'done', seconds: 65, lines: [{ who: 'ai', text: '您好' }, { who: 'shop', text: '有位' }], answers: { 价格: '98' },
  summary: '下午三点有位，98 元', booked: null, offer: null, outcome: 'answered', label: '问到了', needUser: false, retry: null };

test('a call reports progress, keeps a record from the moment it is placed and returns the call card', async (t) => {
  const { u, seen, calls } = fixture(t, async (req, { onStage, onPlaced }) => {
    await onPlaced('C-1');
    const [early] = calls.list(u);
    assert.deepEqual([early.status, early.ref, early.taskId], ['dialing', 'C-1', 't_1'], 'the placed call is on record before the result');
    onStage('dialing');
    return answered;
  });
  const stages = [];
  const signal = new AbortController().signal;
  const env = { JUPITER_TENANT_ID: 'x' };
  const r = await calls.place(u, { id: 't_1', round: 2 }, { to: '010-12345678', name: '栗子美甲（和平里店）', goal: '问问下午三点有没有位', mode: 'ask', share: '手机号 138…' },
    { progress: (p) => stages.push(p.call.stage), signal, env });
  assert.deepEqual(stages, ['queued', 'dialing', 'done']);
  assert.equal(seen[0].opts.signal, signal);
  assert.equal(seen[0].opts.env, env);
  assert.equal(seen[0].req.share, '不提供任何顾客信息', 'ask mode never shares user info');
  assert.equal(r.connected, true);
  assert.equal(r.summary, '下午三点有位，98 元');
  assert.equal(r.retry, 'no');
  assert.equal(r.retry_hint, '');
  assert.match(r.transcript, /喵团：您好\n店员：有位/);
  const all = calls.list(u);
  assert.equal(all.length, 1, 'the early record is updated in place');
  assert.deepEqual([all[0].status, all[0].ref, all[0].short, all[0].round], ['done', 'C-1', '栗子美甲', 2]);
  assert.deepEqual(r.attachments, [{ type: 'calls', calls: [all[0]] }]);
});

test('booking shares the account name by default; a number is required; retry hints come from the platform result', async (t) => {
  const { u, seen, calls } = fixture(t, async () => ({ ...answered, status: 'missed', lines: [], outcome: 'no_answer', label: '未接通：无人接听', summary: '未接通：无人接听', retry: 'later' }));
  assert.equal((await calls.place(u, null, { name: '没号码', goal: 'x' })).outcome, 'no_number');
  assert.equal(seen.length, 0);
  const r = await calls.place(u, null, { to: '010-1', name: 'A', goal: 'x', mode: 'book' });
  assert.equal(seen[0].req.share, '仅可提供：顾客称呼：小王');
  assert.deepEqual([r.dialed, r.connected, r.retry, r.retry_hint], [true, false, 'later', '这次别再打，过一阵可以再打']);
  await calls.place(u, null, { to: '010-1', name: 'A', goal: 'x', mode: 'ask' });
  await calls.place(u, null, { to: '010-1', name: 'A', goal: 'x', mode: 'ask' });
  assert.equal(calls.list(u).length, 3, 'no per-number daily limit in the App');
});

test('a placed call that gets cancelled stays on record as pending', async (t) => {
  const { u, calls } = fixture(t, async (req, { onPlaced, signal }) => {
    await onPlaced('C-2');
    signal.throwIfAborted();
  });
  const stop = new AbortController();
  stop.abort();
  const stages = [];
  await assert.rejects(calls.place(u, null, { to: '010-2', name: 'B', goal: 'x', mode: 'ask' }, { signal: stop.signal, progress: (p) => stages.push(p.call.stage) }), { name: 'AbortError' });
  assert.deepEqual(stages, ['queued', 'pending'], 'the live call card stops showing a ringing phone');
  const [rec] = calls.list(u);
  assert.deepEqual([rec.status, rec.ref, rec.summary], ['pending', 'C-2', '电话打出去了，没等到结果']);
});

test('the same task calling the same number again waits for the call already placed instead of dialing twice', async (t) => {
  let placed = 0;
  const { u, seen, calls } = fixture(t, async (req, { onPlaced, resume, signal }) => {
    if (!resume) { placed++; await onPlaced('C-3'); }
    signal?.throwIfAborted();
    return answered;
  });
  const stop = new AbortController();
  stop.abort();
  const req = { to: '010-3', name: 'C', goal: 'x', mode: 'ask' };
  await assert.rejects(calls.place(u, { id: 't_3' }, req, { signal: stop.signal })); // App 停了 / 任务停了：打出去了、没等到结果
  const r = await calls.place(u, { id: 't_3' }, req); // 接着做：agent 又调了一次
  assert.equal(placed, 1);
  assert.deepEqual(seen[1].opts.resume, { ref: 'C-3', at: calls.list(u)[0].at });
  assert.equal(r.connected, true);
  assert.deepEqual(calls.list(u).map((c) => [c.ref, c.status]), [['C-3', 'done']], 'one record, updated in place');
  await calls.place(u, { id: 't_4' }, req); // 别的任务打同一个号码：照常拨
  await calls.place(u, { id: 't_3' }, req); // 同一个任务、上一通已经有结果：照常拨
  assert.equal(placed, 3);
});

test('calls finishing at the same time all keep their records', async (t) => {
  const { u, calls } = fixture(t, async (req, { onPlaced }) => { await onPlaced(`C-${req.to}`); await new Promise((r) => setTimeout(r, 5)); return answered; });
  await Promise.all(Array.from({ length: 8 }, (_, i) => calls.place(u, { id: `t_${i}` }, { to: `010-${i}`, name: `店${i}`, goal: 'x', mode: 'ask' })));
  assert.deepEqual(calls.list(u).map((c) => c.status).sort(), Array(8).fill('done'));
  assert.equal(new Set(calls.list(u).map((c) => c.ref)).size, 8);
});

test('a call without a result yet is not reported as "do not call again"', async (t) => {
  const { u, calls } = fixture(t, async (req, { onPlaced }) => { await onPlaced('C-9');
    return { ...answered, status: 'pending', lines: [], outcome: 'result_pending', label: '电话打出去了，平台还没给结果', summary: '电话打出去了，平台还没给结果', retry: null }; });
  const r = await calls.place(u, null, { to: '010-9', name: 'P', goal: 'x', mode: 'ask' });
  assert.deepEqual([r.dialed, r.connected, r.outcome, r.retry], [true, false, 'result_pending', null]);
  assert.match(r.retry_hint, /别自己重拨/);
  assert.equal(calls.list(u)[0].status, 'pending');
});
