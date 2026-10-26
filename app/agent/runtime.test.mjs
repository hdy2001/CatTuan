import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRuntime } from './runtime.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const MODEL = { id: 'LongCat-2.5-Preview', url: 'http://unused.invalid/v1', key: 'unused', maxTokens: 512, contextWindow: 4096, maxTurns: 90 };

async function fixture(t, { prompt, bridge, steer, maxTurns } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cattuan-pi-unit-'));
  const started = deferred();
  const closed = [];
  const sessions = [];
  const options = [];
  const tools = bridge || (async ({ sessionId }) => ({
    tools: [{ name: 'business_tool', label: '业务工具', describe: (a) => ({ act: `查「${a.query}」`, done: (o) => ({ title: o.found ? `查「${a.query}」，找到了` : '没找到' }) }) }],
    systemPrompt: 'ENABLED_CONTEXT_ONLY', close: async () => closed.push(sessionId),
  }));
  const runtime = await createRuntime({
    home, modelRuntime: { getModel: (provider, id) => ({ provider, id, api: 'openai-completions' }) },
    profiles: {
      worker: { model: { ...MODEL, ...(maxTurns && { maxTurns }) }, tools, instructions: (b) => `SOUL\n\n${b.systemPrompt || ''}` },
      main: { model: { ...MODEL, maxTurns: 3 }, tools, instructions: () => 'MAIN' },
    },
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

test('tools produce run-scoped events with their own display text, and the run completes only after cleanup', async (t) => {
  const closing = deferred();
  const releaseClose = deferred();
  const f = await fixture(t, {
    bridge: async () => ({
      tools: [{ name: 'business_tool', label: '业务工具', usesBrowser: true, describe: (a) => ({ act: `查「${a.query}」`, done: (o) => ({ title: `查「${a.query}」，找到 ${o.n} 个` }) }) }],
      systemPrompt: 'ENABLED_CONTEXT_ONLY', close: async () => { closing.resolve(); await releaseClose.promise; },
    }),
    prompt: async (session) => {
      session.emit({ type: 'tool_execution_start', toolCallId: 'call1', toolName: 'business_tool', args: { query: '猫' } });
      session.emit({ type: 'tool_execution_update', toolCallId: 'call1', toolName: 'business_tool', args: { query: '猫' }, partialResult: { details: { stage: 'half' } } });
      session.emit({ type: 'tool_execution_end', toolCallId: 'call1', toolName: 'business_tool', result: { content: [{ type: 'text', text: '{"n":2}' }], details: { n: 2, attachments: [{ type: 'images', items: [] }] } }, isError: false });
      session.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '好了' }] } });
      answer(session);
    },
  });
  const run = f.runtime.startRun({ input: '找猫', sessionId: 'task-1' });
  await closing.promise;
  assert.deepEqual(run.events.map((event) => event.event), ['tool.started', 'tool.updated', 'tool.completed', 'message.completed']);
  assert.throws(() => f.runtime.startRun({ input: '并行', sessionId: 'task-1' }), { statusCode: 409 });
  releaseClose.resolve();
  await run.done;
  const [started, updated, completed] = run.events;
  assert.equal(run.events.at(-1).event, 'run.completed');
  assert.equal(run.events.at(-1).output, '完成');
  assert.equal(started.tool_call_id, `${run.id}:call1`);
  assert.equal(started.title, '正在查「猫」');
  assert.equal(started.label, '业务工具');
  assert.equal(started.browser, true);
  assert.deepEqual(updated.progress, { stage: 'half' });
  assert.deepEqual(completed.args, { query: '猫' });
  assert.equal(completed.result, '{"n":2}');
  assert.equal(completed.title, '查「猫」，找到 2 个');
  assert.equal(completed.ok, true);
  assert.equal(completed.details.attachments.length, 1);
  assert.deepEqual(run.events.map((event) => event.seq), [0, 1, 2, 3, 4]);
  assert.deepEqual(f.options[0].tools, ['business_tool']);
  assert.equal(f.options[0].noTools, 'builtin');
  assert.deepEqual(f.options[0].resourceLoader.getExtensions().extensions, []);
  assert.deepEqual(f.options[0].resourceLoader.getAgentsFiles().agentsFiles, []);
  assert.match(f.options[0].resourceLoader.getSystemPrompt(), /^SOUL[\s\S]*ENABLED_CONTEXT_ONLY/);
  assert.equal(f.sessions[0].disposed, true);
  const metadata = JSON.parse(await readFile(path.join(f.options[0].sessionManager.getSessionDir(), 'task.json'), 'utf8'));
  assert.equal(metadata.task_session_id, 'task-1');
});

test('tools without describe get a generic step title, and failed tools are marked', async (t) => {
  const f = await fixture(t, {
    bridge: async () => ({ tools: [{ name: 'plain_tool', label: '查东西' }], close() {} }),
    prompt: async (session) => {
      session.emit({ type: 'tool_execution_start', toolCallId: 'c', toolName: 'plain_tool', args: { query: '天气' } });
      session.emit({ type: 'tool_execution_end', toolCallId: 'c', toolName: 'plain_tool', result: { content: [{ type: 'text', text: 'timeout' }] }, isError: true });
      answer(session);
    },
  });
  const run = f.runtime.startRun({ input: '查', sessionId: 'generic' });
  await run.done;
  assert.equal(run.events[0].title, '正在查东西「天气」');
  assert.equal(run.events[1].title, '查东西「天气」，没成功');
  assert.equal(run.events[1].ok, false);
  assert.equal(run.events[1].error, true);
});

test('profiles choose their own instructions and model', async (t) => {
  const f = await fixture(t, { prompt: async (session) => answer(session) });
  const run = f.runtime.startRun({ input: '在吗', sessionId: 'chat-1', profile: 'main' });
  await run.done;
  assert.equal(f.options[0].resourceLoader.getSystemPrompt(), 'MAIN');
  assert.equal(f.options[0].model.provider, 'main');
  assert.throws(() => f.runtime.startRun({ input: 'x', profile: 'nobody' }), /Unknown profile/);
});

test('resolved Pi error responses fail the run instead of becoming success', async (t) => {
  const f = await fixture(t, { prompt: async (session) => answer(session, '', 'error', 'invalid model credentials') });
  const run = f.runtime.startRun({ input: '任务', sessionId: 'failed-task' });
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
  const run = f.runtime.startRun({ input: '任务', sessionId: 'setup-task' });
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
  const run = f.runtime.startRun({ input: '任务', sessionId: 'steer-task' });
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
    maxTurns: 2,
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
  const first = f.runtime.startRun({ input: '一', sessionId: 'user-a-task' });
  const second = f.runtime.startRun({ input: '二', sessionId: 'user-b-task' });
  await bothStarted.promise;
  assert.equal(first.status, 'running');
  assert.equal(second.status, 'running');
  assert.notEqual(f.options[0].sessionManager.getSessionDir(), f.options[1].sessionManager.getSessionDir());
  finish.resolve();
  await Promise.all([first.done, second.done]);
  assert.equal(first.status, 'completed');
  assert.equal(second.status, 'completed');
});
