import test from 'node:test';
import assert from 'node:assert/strict';
import { recordToolEvent } from './pi-events.mjs';

test('Pi event replay is idempotent and a late start cannot reopen a completed step', () => {
  const task = { steps: [] };
  const event = { tool: 'memory', tool_call_id: 'run-one:tool-one', args: { action: 'add' } };
  const start = { ...event, event: 'tool.started' };
  const end = { ...event, event: 'tool.completed', result: '{"ok":true}' };
  const options = { describe: (_name, _args, completed) => ({ title: completed ? '已记住' : '正在记' }) };
  assert.equal(recordToolEvent(task, start, options).created, true);
  recordToolEvent(task, end, options);
  const finished = { ...task.steps[0] };
  recordToolEvent(task, start, options);
  recordToolEvent(task, end, options);
  assert.deepEqual(task.steps, [finished]);
});

test('a completion received after reconnect restores a missing step and preserves errors', () => {
  const task = {};
  const event = { event: 'tool.completed', tool: 'read_webpage', tool_call_id: 'run-two:tool-one', args: { url: 'https://example.com' }, error: true, result: 'timeout' };
  recordToolEvent(task, event, { describe: (_name, args, end) => ({ detail: args.url, ok: !end.error, title: end.result }) });
  assert.equal(task.steps[0].status, 'done');
  assert.equal(task.steps[0].ok, false);
  assert.equal(task.steps[0].detail, event.args.url);
  assert.equal(task.steps[0].title, 'timeout');
});
