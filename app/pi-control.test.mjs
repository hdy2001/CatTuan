import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPiRuntime } from './pi-runtime.mjs';
import { createPiGateway } from './pi-gateway.mjs';

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

async function fixture(t, { handle, tools = [], env = {} }) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cattuan-pi-control-'));
  const requests = [];
  const errors = [];
  let runtime, gateway, closedBridges = 0;
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
    await gateway?.close();
    await runtime?.close();
    provider.closeAllConnections();
    if (provider.listening) await new Promise((resolve) => provider.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  runtime = await createPiRuntime({
    home, env: { PI_API_URL: `http://127.0.0.1:${provider.address().port}/v1`, LONGCAT_API_KEY: 'local-only-test-key', ...env },
    createPiTools: async () => ({ tools, close: async () => { closedBridges++; } }),
  });
  gateway = createPiGateway({ runtime, apiKey: 'control-key' });
  const address = await gateway.listen({ port: 0 });
  const url = `http://127.0.0.1:${address.port}`;
  const post = async (route, body = {}) => fetch(`${url}${route}`, { method: 'POST',
    headers: { Authorization: 'Bearer control-key', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return {
    runtime, requests, errors, post, get closedBridges() { return closedBridges; },
    async run(input, sessionId) {
      const response = await post('/v1/runs', { input, model: 'pi-agent', session_id: sessionId });
      assert.equal(response.status, 200);
      return (await response.json()).run_id;
    },
    async events(id) {
      const response = await fetch(`${url}/v1/runs/${id}/events`, { headers: { Authorization: 'Bearer control-key' } });
      assert.equal(response.status, 200);
      return (await response.text()).split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
    },
  };
}

test('native Pi consumes an HTTP steering request after an in-flight business tool', { timeout: 15000 }, async (t) => {
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
  const runId = await f.run('先做业务查询', 'steer-native-task');
  const reading = f.events(runId);
  await toolStarted.promise;
  const steered = await f.post(`/v1/runs/${runId}/steer`, { input: '加上北京的结果' });
  assert.equal(steered.status, 200);
  releaseTool.resolve();
  const events = await reading;
  assert.equal(events.at(-1).event, 'run.completed', JSON.stringify(events));
  assert.equal(events.at(-1).output, '已经按补充要求加入北京的结果。');
  assert.equal(events.at(-1).pending_steer, '');
  assert.deepEqual(events.map((event) => event.event), ['tool.started', 'tool.completed', 'run.completed']);
  assert.equal(f.requests.length, 2);
  assert.equal(f.closedBridges, 1);
  assert.deepEqual(f.errors, []);
  assert.equal((await f.post(`/v1/runs/${runId}/steer`, { input: '已结束' })).status, 409);
});

test('HTTP stop aborts an active native Pi model stream and settles as cancelled', { timeout: 15000 }, async (t) => {
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
  const runId = await f.run('等待一个慢模型', 'stop-native-task');
  const reading = f.events(runId);
  await streamStarted.promise;
  const stopped = await f.post(`/v1/runs/${runId}/stop`);
  assert.equal(stopped.status, 200);
  const events = await reading;
  await streamClosed.promise;
  assert.equal(events.at(-1).event, 'run.cancelled', JSON.stringify(events));
  assert.ok(!events.some((event) => event.event === 'run.completed'));
  assert.equal(f.runtime.getRun(runId).session, undefined);
  assert.equal(f.closedBridges, 1);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.errors, []);
});

test('native Pi stops a repeating model/tool loop at the configured turn limit', { timeout: 15000 }, async (t) => {
  let toolCalls = 0;
  const f = await fixture(t, {
    env: { PI_MAX_TURNS: '2' },
    tools: [businessTool(async () => {
      toolCalls++;
      return { content: [{ type: 'text', text: '{"continue":true}' }] };
    })],
    handle: ({ res }) => toolCall(res),
  });
  const runId = await f.run('持续调用业务工具', 'limit-native-task');
  const events = await f.events(runId);
  assert.equal(events.at(-1).event, 'run.failed', JSON.stringify(events));
  assert.match(events.at(-1).error, /2 turn limit/);
  assert.equal(toolCalls, 2);
  assert.equal(f.requests.length, 2, 'The over-limit turn must be aborted before another HTTP model request');
  assert.equal(f.closedBridges, 1);
  assert.deepEqual(f.errors, []);
});
