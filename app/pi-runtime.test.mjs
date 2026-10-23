import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPiRuntime } from './pi-runtime.mjs';
import { readEnvFile } from './pi-gateway.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(t, { prompt, bridge, steer, env = {} } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cattuan-pi-unit-'));
  const started = deferred();
  const closed = [];
  const sessions = [];
  const options = [];
  const model = { provider: 'longcat', id: 'LongCat-2.5-Preview', api: 'openai-completions' };
  const runtime = await createPiRuntime({
    home, env, modelRuntime: { getModel: () => model },
    createPiTools: bridge || (async ({ sessionId }) => ({
      tools: [{ name: 'business_tool' }], systemPrompt: 'ENABLED_CONTEXT_ONLY',
      close: async () => closed.push(sessionId),
    })),
    createSession: async (opts) => {
      options.push(opts);
      const listeners = new Set();
      const pending = [];
      const aborted = deferred();
      const session = {
        messages: [], pending, aborted,
        emit: (event) => { for (const listener of listeners) listener(event); },
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        getLastAssistantText: () => session.messages.findLast((message) => message.role === 'assistant')?.content?.[0]?.text,
        getSteeringMessages: () => [...pending],
        prompt: async (input) => {
          started.resolve(session);
          await prompt?.(session, input);
        },
        steer: async (input) => { await steer?.(session, input); pending.push(input); },
        abort: async () => { aborted.resolve(); },
        dispose: () => { session.disposed = true; },
      };
      sessions.push(session);
      return { session };
    },
  });
  t.after(async () => { await runtime.close(); await rm(home, { recursive: true, force: true }); });
  return { home, runtime, started, closed, sessions, options };
}

function answer(session, text = '完成', stopReason = 'stop', errorMessage) {
  session.messages.push({ role: 'assistant', content: [{ type: 'text', text }], stopReason, errorMessage });
}

test('custom business tools produce inline, run-scoped events and complete only after cleanup', async (t) => {
  const closing = deferred();
  const releaseClose = deferred();
  const f = await fixture(t, {
    bridge: async () => ({ tools: [{ name: 'business_tool' }], systemPrompt: 'ENABLED_CONTEXT_ONLY', close: async () => { closing.resolve(); await releaseClose.promise; } }),
    prompt: async (session) => {
      session.emit({ type: 'tool_execution_start', toolCallId: 'call1', toolName: 'business_tool', args: { query: '猫' } });
      session.emit({ type: 'tool_execution_end', toolCallId: 'call1', toolName: 'business_tool', result: { content: [{ type: 'text', text: '{"found":true}' }] }, isError: false });
      answer(session);
    },
  });
  const run = f.runtime.startRun({ input: '找猫', session_id: 'task-1', model: 'pi-agent' });
  await closing.promise;
  assert.deepEqual(run.events.map((event) => event.event), ['tool.started', 'tool.completed']);
  assert.throws(() => f.runtime.startRun({ input: '并行', session_id: 'task-1' }), { statusCode: 409 });
  releaseClose.resolve();
  await run.done;
  assert.equal(run.events.at(-1).event, 'run.completed');
  assert.equal(run.events.at(-1).output, '完成');
  assert.equal(run.events[0].tool_call_id, `${run.id}:call1`);
  assert.deepEqual(run.events[1].args, { query: '猫' });
  assert.equal(run.events[1].result, '{"found":true}');
  assert.deepEqual(run.events.map((event) => event.seq), [0, 1, 2]);
  assert.deepEqual(f.options[0].tools, ['business_tool']);
  assert.equal(f.options[0].noTools, 'builtin');
  assert.deepEqual(f.options[0].resourceLoader.getExtensions().extensions, []);
  assert.deepEqual(f.options[0].resourceLoader.getAgentsFiles().agentsFiles, []);
  assert.match(f.options[0].resourceLoader.getSystemPrompt(), /ENABLED_CONTEXT_ONLY/);
  assert.equal(f.sessions[0].disposed, true);
  const metadata = JSON.parse(await readFile(path.join(f.options[0].sessionManager.getSessionDir(), 'task.json'), 'utf8'));
  assert.equal(metadata.task_session_id, 'task-1');
});

test('resolved Pi error responses fail the run instead of becoming success', async (t) => {
  const f = await fixture(t, { prompt: async (session) => answer(session, '', 'error', 'invalid model credentials') });
  const run = f.runtime.startRun({ input: '任务', session_id: 'failed-task' });
  await run.done;
  assert.equal(run.status, 'failed');
  assert.equal(run.events.at(-1).error, 'invalid model credentials');
  assert.deepEqual(f.closed, ['failed-task']);
});

test('stopping during toolset startup cancels and releases the session lock', async (t) => {
  const settingUp = deferred();
  const releaseSetup = deferred();
  let closed = 0;
  const f = await fixture(t, { bridge: async () => {
    settingUp.resolve();
    await releaseSetup.promise;
    return { tools: [], close: async () => { closed++; } };
  } });
  const run = f.runtime.startRun({ input: '任务', session_id: 'setup-task' });
  await settingUp.promise;
  await f.runtime.stop(run.id);
  releaseSetup.resolve();
  await run.done;
  assert.equal(run.status, 'cancelled');
  assert.equal(closed, 1);
  assert.equal(f.sessions.length, 0);
  await assert.rejects(f.runtime.steer(run.id, '已结束'), { statusCode: 409 });
});

test('accepted steering preparation settles before pending_steer is reported', async (t) => {
  const finishModel = deferred();
  const prepareSteer = deferred();
  const f = await fixture(t, {
    prompt: async (session) => { await finishModel.promise; answer(session); },
    steer: async () => prepareSteer.promise,
  });
  const run = f.runtime.startRun({ input: '任务', session_id: 'steer-task' });
  await f.started.promise;
  const accepted = f.runtime.steer(run.id, '补充要求');
  finishModel.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(run.events.length, 0);
  assert.equal(run.acceptingInput, false);
  await assert.rejects(f.runtime.steer(run.id, '太晚的要求'), { statusCode: 409 });
  prepareSteer.resolve();
  await accepted;
  await run.done;
  assert.equal(run.events.at(-1).pending_steer, '补充要求');
});

test('a configured model turn cap fails clearly and invokes Pi cancellation', async (t) => {
  const f = await fixture(t, {
    env: { PI_MAX_TURNS: '2' },
    prompt: async (session) => {
      session.emit({ type: 'turn_start' });
      session.emit({ type: 'turn_start' });
      session.emit({ type: 'turn_start' });
      await session.aborted.promise;
      answer(session, '', 'aborted');
    },
  });
  const run = f.runtime.startRun({ input: '无限任务' });
  await run.done;
  assert.equal(run.status, 'failed');
  assert.match(run.events.at(-1).error, /2 turn limit/);
});

test('distinct task sessions can execute concurrently', async (t) => {
  const bothStarted = deferred();
  const finish = deferred();
  let count = 0;
  const f = await fixture(t, { prompt: async (session) => {
    if (++count === 2) bothStarted.resolve();
    await finish.promise;
    answer(session);
  } });
  const first = f.runtime.startRun({ input: '一', session_id: 'user-a-task' });
  const second = f.runtime.startRun({ input: '二', session_id: 'user-b-task' });
  await bothStarted.promise;
  assert.equal(first.status, 'running');
  assert.equal(second.status, 'running');
  assert.notEqual(f.options[0].sessionManager.getSessionDir(), f.options[1].sessionManager.getSessionDir());
  finish.resolve();
  await Promise.all([first.done, second.done]);
  assert.equal(first.status, 'completed');
  assert.equal(second.status, 'completed');
});

test('dotenv parsing preserves quoted credentials and ignores comments', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cattuan-pi-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, '.env');
  await writeFile(filename, '# note\nexport API_SERVER_KEY="test#key"\nPI_MODEL=local-model # note\nLONGCAT_API_KEY=\n');
  assert.deepEqual(await readEnvFile(filename), { API_SERVER_KEY: 'test#key', PI_MODEL: 'local-model', LONGCAT_API_KEY: '' });
  assert.deepEqual(await readEnvFile(path.join(directory, 'missing')), {});
});
