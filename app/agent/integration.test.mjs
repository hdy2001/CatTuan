// 真实 Pi SDK → 模拟模型 → 真实业务工具（记忆）的往返，以及 runtime 重建后在同一个会话里接着聊。
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import test from 'node:test';
import { createAgents } from './agents.mjs';
import { recordStep } from '../core/tasks.mjs';

function modelResponse(res, delta, finishReason = 'stop') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const base = { id: 'test-chat', object: 'chat.completion.chunk', created: 1, model: 'LongCat-2.5-Preview' };
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}

const done = (run) => new Promise((resolve) => run.done.then(() => resolve(run.events)));

test('native Pi SDK runs a native business tool and restores the task conversation after a restart', { timeout: 30000 }, async () => {
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
      if (last.role === 'tool') return modelResponse(res, { content: '测试记忆完成。' });
      if (String(last.content).includes('延续测试')) return modelResponse(res, { content: '保留了上一轮上下文。' });
      modelResponse(res, { tool_calls: [{ index: 0, id: 'repeated-provider-call-id', type: 'function', function: {
        name: 'memory', arguments: JSON.stringify({ action: 'add', target: 'memory', content: 'Pi 隔离测试' }),
      } }] }, 'tool_calls');
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  let agents;
  try {
    await writeFile(path.join(home, 'config.yaml'), 'toolsets: [skills, memory, session_search]\n');
    await writeFile(path.join(home, 'SOUL.md'), '你是喵团。仅在这个隔离测试目录里写记忆。\n');
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const model = { id: 'LongCat-2.5-Preview', url: `http://127.0.0.1:${provider.address().port}/v1`, key: 'fake-local-key', maxTokens: 1024, contextWindow: 8192, maxTurns: 6 };
    const config = { env: {}, models: { main: model, worker: model } };
    const u = { id: 'u_test', name: '测试', dir: home, home };
    agents = createAgents({ config });
    const rt = await agents.runtimeOf(u);
    const run = rt.startRun({ input: '记忆隔离测试：记住 Pi 隔离测试。', sessionId: 'task-t_native' });
    const stream = await done(run);
    assert.equal(stream.at(-1).event, 'run.completed', JSON.stringify(stream));
    assert.equal(stream.at(-1).output, '测试记忆完成。');
    const began = stream.find((event) => event.event === 'tool.started');
    const ended = stream.find((event) => event.event === 'tool.completed');
    assert.equal(began.tool, 'memory');
    assert.equal(began.args.content, 'Pi 隔离测试');
    assert.equal(began.title, '正在记住「Pi 隔离测试」');
    assert.equal(ended.tool_call_id, began.tool_call_id);
    assert.ok(began.tool_call_id.startsWith(`${run.id}:`), 'Tool IDs must be isolated between runs');
    assert.equal(ended.error, false);
    assert.equal(ended.details.success, true);
    const task = { steps: [] };
    for (const event of [...stream, ...stream]) recordStep(task, event);
    assert.equal(task.steps.length, 1, 'App steps remain unique when events replay');
    assert.equal(task.steps[0].status, 'done');
    assert.match(await readFile(path.join(home, 'memories/MEMORY.md'), 'utf8'), /Pi 隔离测试/);
    assert.equal(requests.length, 2, 'Pi must complete a real model → tool → model loop');
    assert.deepEqual(requests[0].thinking, { type: 'disabled' });
    assert.match(requests[0].messages[0].content, /你是喵团/, 'the worker reads SOUL.md from its home');
    const toolNames = requests[0].tools.map((tool) => tool.function.name);
    assert.ok(toolNames.includes('memory') && toolNames.includes('attach'));
    assert.ok(!toolNames.some((name) => ['bash', 'read', 'write', 'edit', 'terminal', 'phone_call', 'deep_web_search'].includes(name)), toolNames.join());

    await agents.close();
    agents = createAgents({ config });
    const followup = (await agents.runtimeOf(u)).startRun({ input: '延续测试：上一轮做了什么？', sessionId: 'task-t_native' });
    const resumed = await done(followup);
    assert.equal(resumed.at(-1).event, 'run.completed', JSON.stringify(resumed));
    assert.ok(requests.at(-1).messages.some((message) => message.role === 'tool'), 'Persisted Pi conversation must include the previous tool result');
    assert.ok(requests.at(-1).messages.some((message) => message.role === 'assistant' && message.content === '测试记忆完成。'));
  } finally {
    await agents?.close();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});
