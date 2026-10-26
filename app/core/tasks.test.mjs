import test from 'node:test';
import assert from 'node:assert/strict';
import { recordStep, describeAttachment } from './tasks.mjs';

test('tool event replay is idempotent and a late start cannot reopen a completed step', () => {
  const task = { steps: [] };
  const event = { tool: 'memory', label: '翻记忆', tool_call_id: 'run-one:tool-one', args: { action: 'add' } };
  recordStep(task, { ...event, event: 'tool.started', title: '正在记' });
  recordStep(task, { ...event, event: 'tool.completed', title: '已记住', ok: true });
  const finished = { ...task.steps[0] };
  recordStep(task, { ...event, event: 'tool.started', title: '正在记' });
  recordStep(task, { ...event, event: 'tool.completed', title: '已记住', ok: true });
  assert.deepEqual(task.steps, [finished]);
  assert.equal(finished.title, '已记住');
  assert.equal(finished.label, '翻记忆');
});

test('a completion without a start still records the step, keeps failures and progress', () => {
  const task = {};
  const base = { tool: 'phone_call', tool_call_id: 'run-two:tool-one', browser: true };
  recordStep(task, { ...base, event: 'tool.updated', progress: { type: 'call', call: { stage: 'dialing' } } });
  assert.equal(task.steps[0].status, 'running');
  assert.equal(task.steps[0].progress.call.stage, 'dialing');
  recordStep(task, { ...base, event: 'tool.completed', title: '没打出去', detail: 'https://example.com', ok: false });
  assert.equal(task.steps[0].status, 'done');
  assert.equal(task.steps[0].ok, false);
  assert.equal(task.steps[0].browser, true);
  assert.equal(task.steps[0].detail, 'https://example.com');
  assert.equal(recordStep(task, { event: 'run.completed' }), null);
});

test('attachments read back as plain text for the main agent', () => {
  assert.match(describeAttachment({ type: 'document', title: '报告', body: '正文', sources: [{ n: 1, url: 'https://a.example' }] }), /报告\n正文[\s\S]*\[1\] https:\/\/a\.example/);
  assert.equal(describeAttachment({ type: 'images', items: [{}, {}] }), '【附上的图】2 张');
  assert.match(describeAttachment({ type: 'calls', calls: [{ short: '栗子美甲', label: '问到了', summary: '下午三点有位' }] }), /栗子美甲——问到了：下午三点有位/);
});
