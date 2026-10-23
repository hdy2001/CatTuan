import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import test from 'node:test';
import { createPiRuntime } from './pi-runtime.mjs';
import { createPiGateway } from './pi-gateway.mjs';
import { recordToolEvent } from './pi-events.mjs';


async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function modelResponse(res, delta, finishReason = 'stop') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const base = { id: 'test-chat', object: 'chat.completion.chunk', created: 1, model: 'LongCat-2.5-Preview' };
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}

async function events(url, key, lastEventId) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${key}`, ...(lastEventId === undefined ? {} : { 'Last-Event-ID': String(lastEventId) }) } });
  assert.equal(response.status, 200);
  return (await response.text()).split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
}

test('native Pi SDK runs a native business tool, replays SSE, and restores the task conversation', { timeout: 30000 }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cattuan-pi-integration-'));
  const requests = [];
  const provider = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      requests.push(body);
      if (req.url !== '/v1/chat/completions') throw new Error(`Unexpected model path: ${req.url}`);
      const last = body.messages.at(-1);
      if (last.role === 'tool') return modelResponse(res, { content: '测试记账完成。' });
      if (String(last.content).includes('延续测试')) return modelResponse(res, { content: '保留了上一轮上下文。' });
      modelResponse(res, { tool_calls: [{ index: 0, id: 'repeated-provider-call-id', type: 'function', function: {
        name: 'ledger_add', arguments: JSON.stringify({ entries: [{ amount: 12.5, category: '餐饮', note: 'Pi 隔离测试' }] }),
      } }] }, 'tool_calls');
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  let gateway;
  try {
    await writeFile(path.join(home, 'config.yaml'), 'platform_toolsets:\n  api_server: [ledger, skills, memory, session_search]\n');
    await writeFile(path.join(home, 'SOUL.md'), '你是喵团。仅在这个隔离测试目录里记账。\n');
    const providerUrl = await listen(provider);
    const env = { PI_API_URL: `${providerUrl}/v1`, LONGCAT_API_KEY: 'fake-local-key' };
    const start = async () => {
      const runtime = await createPiRuntime({ home, env });
      gateway = createPiGateway({ runtime, apiKey: 'test-gateway-key' });
      const address = await gateway.listen({ port: 0 });
      return `http://127.0.0.1:${address.port}`;
    };
    let url = await start();
    assert.equal((await fetch(`${url}/v1/models`)).status, 401);
    assert.equal((await (await fetch(`${url}/health`)).json()).runtime, 'pi');
    const createRun = async (input) => {
      const response = await fetch(`${url}/v1/runs`, { method: 'POST', headers: { Authorization: 'Bearer test-gateway-key', 'Content-Type': 'application/json' }, body: JSON.stringify({ input, session_id: 'task-native-integration', model: 'pi-agent' }) });
      assert.equal(response.status, 200);
      return (await response.json()).run_id;
    };
    const runId = await createRun('记账隔离测试：午饭 12.5 元。');
    const stream = await events(`${url}/v1/runs/${runId}/events`, 'test-gateway-key');
    assert.equal(stream.at(-1).event, 'run.completed', JSON.stringify(stream));
    assert.equal(stream.at(-1).output, '测试记账完成。');
    const began = stream.find((event) => event.event === 'tool.started');
    const ended = stream.find((event) => event.event === 'tool.completed');
    assert.equal(began.tool, 'ledger_add');
    assert.equal(began.args.entries[0].amount, 12.5);
    assert.equal(ended.tool_call_id, began.tool_call_id);
    assert.ok(began.tool_call_id.startsWith(`${runId}:`), 'Tool IDs must be isolated between runs and users');
    assert.equal(ended.error, false);
    const task = { steps: [] };
    for (const event of stream) recordToolEvent(task, event);
    for (const event of stream) recordToolEvent(task, event);
    assert.equal(task.steps.length, 1, 'App steps remain unique when SSE events replay');
    assert.equal(task.steps[0].name, 'ledger_add');
    assert.equal(task.steps[0].status, 'done');
    assert.equal(JSON.parse(ended.result).added[0].amount, 12.5);
    const ledger = JSON.parse(await readFile(path.join(home, 'ledger/entries.json'), 'utf8'));
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].note, 'Pi 隔离测试');
    assert.equal(requests.length, 2, 'Pi must complete a real model → tool → model loop');
    assert.deepEqual(requests[0].thinking, { type: 'disabled' });
    const toolNames = requests[0].tools.map((tool) => tool.function.name);
    assert.ok(toolNames.includes('ledger_add'));
    assert.ok(!toolNames.some((name) => ['bash', 'read', 'write', 'edit', 'terminal', 'delegate_task'].includes(name)));
    const replay = await events(`${url}/v1/runs/${runId}/events`, 'test-gateway-key', began.seq);
    assert.deepEqual(replay, stream.filter((event) => event.seq > began.seq));

    await gateway.close();
    gateway = undefined;
    url = await start();
    const followup = await createRun('延续测试：上一轮做了什么？');
    const resumed = await events(`${url}/v1/runs/${followup}/events`, 'test-gateway-key');
    assert.equal(resumed.at(-1).event, 'run.completed', JSON.stringify(resumed));
    assert.ok(requests.at(-1).messages.some((message) => message.role === 'tool'), 'Persisted Pi conversation must include the previous tool result');
    assert.ok(requests.at(-1).messages.some((message) => message.role === 'assistant' && message.content === '测试记账完成。'));
  } finally {
    await gateway?.close();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});
