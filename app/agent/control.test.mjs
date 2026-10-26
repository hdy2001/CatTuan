// 真实 Pi SDK + 本地模拟模型：插话、停止、轮数上限都在进程内的 runtime 上验证。
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRuntime, TERMINAL } from './runtime.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

function chunk(delta, finishReason = null) {
  return `data: ${JSON.stringify({ id: 'control-test', object: 'chat.completion.chunk', created: 1,
    model: 'LongCat-2.5-Preview', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

function reply(res, delta, finishReason = 'stop') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(chunk({ role: 'assistant', ...delta }));
  res.write(chunk({}, finishReason));
  res.end('data: [DONE]\n\n');
}

function toolCall(res) {
  reply(res, { tool_calls: [{ index: 0, id: 'control-tool-call', type: 'function',
    function: { name: 'wait_for_work', arguments: '{}' } }] }, 'tool_calls');
}

function businessTool(execute) {
  return { name: 'wait_for_work', label: '等待业务结果', description: 'An isolated, deterministic business tool for integration tests.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }, execute };
}

function textContent(message) {
  return Array.isArray(message.content) ? message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n') : String(message.content);
}

const finished = (run) => new Promise((resolve) => {
  if (TERMINAL.has(run.events.at(-1)?.event)) return resolve(run.events);
  run.listeners.add((ev) => { if (TERMINAL.has(ev.event)) resolve(run.events); });
});

async function fixture(t, { handle, tools = [], maxTurns = 90 }) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cattuan-pi-control-'));
  const requests = [];
  const errors = [];
  let runtime, closedBridges = 0;
  const provider = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions');
      const chunks = [];
      for await (const data of req) chunks.push(data);
      const body = JSON.parse(Buffer.concat(chunks));
      requests.push(body);
      await handle({ body, res, requests });
    } catch (error) {
      errors.push(error);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  t.after(async () => {
    await runtime?.close();
    provider.closeAllConnections();
    if (provider.listening) await new Promise((resolve) => provider.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  runtime = await createRuntime({
    home, profiles: { worker: {
      model: { id: 'LongCat-2.5-Preview', url: `http://127.0.0.1:${provider.address().port}/v1`, key: 'local-only-test-key', maxTokens: 1024, contextWindow: 8192, maxTurns },
      tools: async () => ({ tools, close: async () => { closedBridges++; } }), instructions: () => '测试',
    } },
  });
  return { runtime, requests, errors, get closedBridges() { return closedBridges; } };
}

test('native Pi consumes a steering message after an in-flight business tool', { timeout: 15000 }, async (t) => {
  const toolStarted = deferred();
  const releaseTool = deferred();
  const f = await fixture(t, {
    tools: [businessTool(async () => {
      toolStarted.resolve();
      await releaseTool.promise;
      return { content: [{ type: 'text', text: '{"ready":true}' }] };
    })],
    handle: ({ body, res, requests }) => {
      if (requests.length === 1) return toolCall(res);
      assert.ok(body.messages.some((message) => message.role === 'tool'), 'Pi must retain the completed business result');
      assert.ok(body.messages.some((message) => message.role === 'user' && textContent(message).includes('加上北京的结果')),
        'The next native Pi model request must consume the user steering message');
      reply(res, { content: '已经按补充要求加入北京的结果。' });
    },
  });
  const run = f.runtime.startRun({ input: '先做业务查询', sessionId: 'steer-native-task' });
  await toolStarted.promise;
  assert.deepEqual(await f.runtime.steer(run.id, '加上北京的结果'), { status: 'accepted' });
  releaseTool.resolve();
  const events = await finished(run);
  assert.equal(events.at(-1).event, 'run.completed', JSON.stringify(events));
  assert.equal(events.at(-1).output, '已经按补充要求加入北京的结果。');
  assert.equal(events.at(-1).pending_steer, '');
  assert.deepEqual(events.map((event) => event.event).filter((e) => e !== 'message.completed'), ['tool.started', 'tool.completed', 'run.completed']);
  assert.equal(f.requests.length, 2);
  assert.equal(f.closedBridges, 1);
  assert.deepEqual(f.errors, []);
  await assert.rejects(f.runtime.steer(run.id, '已结束'), { statusCode: 409 });
});

test('stop aborts an active native Pi model stream and settles as cancelled', { timeout: 15000 }, async (t) => {
  const streamStarted = deferred();
  const streamClosed = deferred();
  const f = await fixture(t, {
    handle: ({ res }) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(chunk({ role: 'assistant', content: '生成中的部分结果' }));
      res.on('close', () => streamClosed.resolve());
      streamStarted.resolve();
      // Keep the provider stream open until Pi aborts the actual HTTP request.
    },
  });
  const run = f.runtime.startRun({ input: '等待一个慢模型', sessionId: 'stop-native-task' });
  await streamStarted.promise;
  await f.runtime.stop(run.id);
  const events = await finished(run);
  await streamClosed.promise;
  assert.equal(events.at(-1).event, 'run.cancelled', JSON.stringify(events));
  assert.ok(!events.some((event) => event.event === 'run.completed'));
  assert.equal(f.runtime.getRun(run.id).session, undefined);
  assert.equal(f.closedBridges, 1);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.errors, []);
});

test('native Pi stops a repeating model/tool loop at the configured turn limit', { timeout: 15000 }, async (t) => {
  let toolCalls = 0;
  const f = await fixture(t, {
    maxTurns: 2,
    tools: [businessTool(async () => {
      toolCalls++;
      return { content: [{ type: 'text', text: '{"continue":true}' }] };
    })],
    handle: ({ res }) => toolCall(res),
  });
  const run = f.runtime.startRun({ input: '持续调用业务工具', sessionId: 'limit-native-task' });
  const events = await finished(run);
  assert.equal(events.at(-1).event, 'run.failed', JSON.stringify(events));
  assert.match(events.at(-1).error, /2 turn limit/);
  assert.equal(toolCalls, 2);
  assert.equal(f.requests.length, 2, 'The over-limit turn must be aborted before another HTTP model request');
  assert.equal(f.closedBridges, 1);
  assert.deepEqual(f.errors, []);
});
