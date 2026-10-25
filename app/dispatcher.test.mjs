import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import test from 'node:test';
import { createPiRuntime, forkSession, sessionDir } from './pi-runtime.mjs';
import { createDispatcher } from './dispatcher.mjs';

// 模拟 LongCat（OpenAI 流式接口）：reply(body, n) 决定第 n 次请求怎么回
function chunk(res, delta, finish = null) {
  const base = { id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'LongCat-2.5-Preview' };
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}
function respond(res, { text, tools = [] }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  chunk(res, { role: 'assistant', ...(text && { content: text }) });
  tools.forEach(([name, args], index) => chunk(res, { tool_calls: [{ index, id: `call_${name}_${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }));
  chunk(res, {}, tools.length ? 'tool_calls' : 'stop');
  res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}
const textOf = (m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((c) => c.text || '').join(''));
const allText = (body) => body.messages.map(textOf).join('\n');
const until = async (check, ms = 10000) => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); }
};

async function setup(reply) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cattuan-dispatcher-'));
  const requests = [];
  const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks));
    requests.push(body);
    try {
      const out = await reply(body, requests.length);
      if (out.status) { res.writeHead(out.status, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'mock failure' } })); }
      respond(res, out);
    } catch (e) { res.writeHead(500); res.end(e.message); }
  });
  await new Promise((ok) => provider.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${provider.address().port}/v1`;
  const tasks = [];
  const goals = [];
  const posted = [];
  const acts = [];
  const quota = { tasks: '' };
  const hooks = {};
  let pending = null;
  const actions = {
    tasks: () => tasks, goals: () => goals,
    createTask: (u, t) => { const task = { id: `t_${tasks.length + 1}`, uid: u.id, status: 'queued', round: 1, ...t }; hooks.createTask?.(u, task); tasks.push(task); return task; },
    steerTask: async (t, text) => ({ state: 'sent', round: t.round || 1, text }),
    stopTask: (t) => t,
    overQuota: (_u, kind) => quota[kind] || '',
    goalLimit: () => '',
    normAsk: (a) => (a?.questions?.length ? { type: 'ask', questions: a.questions } : null),
    pendingCall: () => pending, setPendingCall: (_u, v) => { pending = v; },
    createGoal: (u, g) => { const goal = { id: `g_${goals.length + 1}`, ...g }; goals.push(goal); return goal; },
    setGoalDone: (g) => { g.done = true; },
    taskResult: (t) => t.result || '（无）',
  };
  // 主 agent 干活的工具（真实的是 pi-tools.mjs 那套）：一个假搜索，外加一个应该被去掉的 phone_call
  const workTool = (name, run) => ({ name, label: name, description: name, parameters: { type: 'object', properties: { query: { type: 'string' } } },
    async execute(_id, args) { return { content: [{ type: 'text', text: JSON.stringify(run(args)) }], details: {} }; } });
  const workTools = async () => ({ systemPrompt: '', close() {}, tools: [
    workTool('deep_web_search', ({ query }) => ({ query, results: [{ n: 1, title: `${query} 官网`, url: 'https://example.com/a', snippet: '营业到 22 点' }] })),
    workTool('phone_call', () => ({ dialed: false })),
  ] });
  const dispatcher = createDispatcher({
    workTools,
    createRuntime: (u, createPiTools) => createPiRuntime({
      home: path.join(dir, u.id), agentDir: path.join(dir, u.id, 'pi-chat'), createPiTools, emitMessages: true,
      instructions: () => '你是测试用的喵团。',
      env: { PI_MODEL: 'LongCat-2.5-Preview', PI_API_URL: url, PI_API_KEY: 'fake', PI_MAX_TURNS: '6', PI_MAX_TOKENS: '512' },
    }),
    actions,
    context: (u, chatId) => `【现在】测试\n【聊天】${chatId}`,
    post: async (u, chatId, items) => { for (const it of items) posted.push({ uid: u.id, chatId, ...it }); },
    activity: { start: (u, chatId, title) => { const a = { title, steps: [] }; acts.push(a); return a; }, step: (a, s) => a.steps.push(s), end: (a, outcome, status) => Object.assign(a, { outcome, status }) },
    log: () => {},
  });
  const ended = (n = 1) => until(() => acts.filter((a) => a.status).length >= n);
  return { dir, url, requests, tasks, goals, posted, acts, quota, hooks, dispatcher, ended, getPending: () => pending,
    async close() { await dispatcher.close(); provider.close(); await rm(dir, { recursive: true, force: true }); } };
}
const U1 = { id: 'u1' };

test('a reply plus subagent takes one model request, forks the chat and the reply carries the task id', { timeout: 30000 }, async () => {
  const s = await setup(() => ({ text: '好嘞，我去查查～', tools: [['subagent', { title: '找咖啡店', task: '找望京附近安静的咖啡店', category: 'life' }]] }));
  try {
    await s.dispatcher.userMessage(U1, 'c1', { text: '帮我找望京安静的咖啡店' });
    await s.ended();
    assert.equal(s.requests.length, 1, 'terminate should end the turn after the tool');
    assert.equal(s.tasks.length, 1);
    assert.equal(s.tasks[0].brief, '找望京附近安静的咖啡店');
    assert.equal(s.tasks[0].forkChat, 'c1', 'the subagent starts from a copy of this chat');
    assert.deepEqual(s.posted.map((m) => [m.text, m.taskId]), [['好嘞，我去查查～', 't_1']]);
    assert.match(s.acts[0].outcome, /派出子 agent「找咖啡店」/);
    assert.ok(s.acts[0].steps.includes('subagent'));
    assert.match(allText(s.requests[0]), /【用户】帮我找望京安静的咖啡店/);
  } finally { await s.close(); }
});

test('a second message sent while the first turn is thinking joins that turn', { timeout: 30000 }, async () => {
  let release;
  const gate = new Promise((ok) => { release = ok; });
  const s = await setup(async (body, n) => {
    if (n === 1) { await gate; return { text: '在呢～' }; }
    assert.match(allText(body), /不对，是三里屯/);
    return { text: '好，改成三里屯～', tools: [['subagent', { title: '找咖啡店', task: '找三里屯的咖啡店' }]] };
  });
  try {
    await s.dispatcher.userMessage(U1, 'c1', { text: '帮我找望京的咖啡店' });
    await until(() => s.requests.length === 1);
    await s.dispatcher.userMessage(U1, 'c1', { text: '不对，是三里屯' });
    release();
    await s.ended();
    assert.equal(s.acts.length, 1, 'both messages are handled in a single dispatcher turn');
    assert.equal(s.tasks.length, 1);
    assert.equal(s.tasks[0].brief, '找三里屯的咖啡店');
    assert.equal(s.posted.at(-1).taskId, 't_1');
  } finally { await s.close(); }
});

test('the main agent searches by itself, answers directly and records what was searched', { timeout: 30000 }, async () => {
  const s = await setup((body) => (body.messages.at(-1).role === 'tool'
    ? { text: '蓝果中古营业到晚上 10 点。' }
    : { text: '我查查～', tools: [['deep_web_search', { query: '蓝果中古首饰' }]] }));
  try {
    await s.dispatcher.userMessage(U1, 'c1', { text: '你知道蓝果中古首饰吗' });
    await s.ended();
    assert.equal(s.requests.length, 2);
    assert.match(textOf(s.requests[1].messages.at(-1)), /蓝果中古首饰 官网/);
    assert.deepEqual(s.posted.map((m) => m.text), ['我查查～', '蓝果中古营业到晚上 10 点。']);
    assert.deepEqual(s.posted[1].search.queries, ['蓝果中古首饰']);
    assert.deepEqual(s.posted[1].search.sources, [{ title: '蓝果中古首饰 官网', url: 'https://example.com/a' }]);
    assert.ok(s.acts[0].steps.includes('deep_web_search'));
    assert.equal(s.tasks.length, 0, 'no subagent for a one-step lookup');
  } finally { await s.close(); }
});

test('a finished task is told in the same session and later turns can use its full result', { timeout: 30000 }, async () => {
  const s = await setup((body) => {
    const last = textOf(body.messages.at(-1));
    if (last.includes('【后台任务结果】')) return { text: '找到 3 家，最推荐 Manner。' };
    assert.match(allText(body), /第三家电话 010-1234/);
    return { text: '第三家电话是 010-1234。' };
  });
  try {
    const task = { id: 't_9', title: '找咖啡店', round: 1 };
    await s.dispatcher.taskFinished(U1, 'c1', { task, title: '转述「找咖啡店」的结果', input: '【后台任务结果】任务 t_9 做完了：第三家电话 010-1234',
      fallback: '找到 3 家', report: { text: '', report: { title: '找咖啡店', body: '全文' } }, attach: {}, all: { partOf: 't_9' }, last: { taskId: 't_9', round: 1 } });
    await s.ended();
    assert.deepEqual(s.posted.map((m) => [m.text, m.partOf, m.taskId, !!m.report]), [
      ['找到 3 家，最推荐 Manner。', 't_9', undefined, false], ['', 't_9', 't_9', true]]);
    await s.dispatcher.userMessage(U1, 'c1', { text: '第三家电话多少' });
    await s.ended(2);
    assert.equal(s.posted.at(-1).text, '第三家电话是 010-1234。');
    assert.equal(s.tasks.length, 0, 'answers from the session, no new task');
  } finally { await s.close(); }
});

test('the main agent gets work tools and chat tools but cannot place calls itself', { timeout: 30000 }, async () => {
  const s = await setup(() => ({ text: '在呢～' }));
  try {
    await s.dispatcher.userMessage(U1, 'c1', { text: '在吗' });
    await s.ended();
    const names = s.requests[0].tools.map((t) => t.function.name);
    for (const name of ['deep_web_search', 'subagent', 'ask_user', 'propose_call', 'create_goal']) assert.ok(names.includes(name), name);
    for (const name of ['phone_call', 'web_search', 'create_task']) assert.ok(!names.includes(name), name);
  } finally { await s.close(); }
});

test('images reach the main agent as local paths and no task is created for them', { timeout: 30000 }, async () => {
  const s = await setup(() => ({ text: '是绣球花～' }));
  try {
    await s.dispatcher.userMessage(U1, 'c1', { text: '这是什么花', images: ['/data/users/u1/uploads/a.jpg'] });
    await s.ended();
    assert.match(allText(s.requests[0]), /vision_analyze[\s\S]*\/data\/users\/u1\/uploads\/a\.jpg/);
    assert.equal(s.tasks.length, 0);
    assert.equal(s.posted.at(-1).text, '是绣球花～');
  } finally { await s.close(); }
});

test('an exhausted task quota is reported back to the model instead of creating a task', { timeout: 30000 }, async () => {
  const s = await setup((body) => (body.messages.at(-1).role === 'tool'
    ? { text: `抱歉，${/额度用完/.test(textOf(body.messages.at(-1))) ? '今天额度用完了' : '?'}` }
    : { tools: [['subagent', { title: '找图', task: '找猫猫图' }]] }));
  try {
    s.quota.tasks = '今天的额度用完啦';
    await s.dispatcher.userMessage(U1, 'c1', { text: '找点猫猫图' });
    await s.ended();
    assert.equal(s.tasks.length, 0);
    assert.equal(s.requests.length, 2);
    assert.equal(s.posted.at(-1).text, '抱歉，今天额度用完了');
  } finally { await s.close(); }
});

test('a model failure falls back to a short apology', { timeout: 30000 }, async () => {
  const s = await setup(() => ({ status: 500 }));
  try {
    await s.dispatcher.userMessage(U1, 'c1', { text: '在吗' });
    await s.ended();
    assert.equal(s.posted.at(-1).text, '我这边网络有点卡，等下再说一次？');
    assert.equal(s.acts[0].status, 'failed');
  } finally { await s.close(); }
});

test('chats and users keep separate sessions', { timeout: 30000 }, async () => {
  const s = await setup((body) => ({ text: `收到：${textOf(body.messages.at(-1)).match(/【用户】(.+)/)?.[1]}` }));
  try {
    await s.dispatcher.userMessage(U1, 'c1', { text: '秘密A' });
    await s.ended(1);
    await s.dispatcher.userMessage(U1, 'c2', { text: '你好B' });
    await s.ended(2);
    await s.dispatcher.userMessage({ id: 'u2' }, 'c1', { text: '你好C' });
    await s.ended(3);
    assert.doesNotMatch(allText(s.requests[1]), /秘密A/);
    assert.doesNotMatch(allText(s.requests[2]), /秘密A/);
    assert.equal((await readdir(path.join(s.dir, 'u1', 'pi-chat', 'sessions'))).length, 2);
    assert.equal((await readdir(path.join(s.dir, 'u2', 'pi-chat', 'sessions'))).length, 1);
  } finally { await s.close(); }
});

test('a subagent copied from the chat at dispatch time continues the whole conversation', { timeout: 30000 }, async () => {
  const s = await setup((_body, n) => (n === 1 ? { text: '好嘞～', tools: [['subagent', { title: '找咖啡店', task: '找三家，交回店名和电话' }]] } : { text: '找到三家' }));
  const home = path.join(s.dir, 'u1');
  // 和 server.mjs 的 createTask 一样：派出的这一刻复制主 agent 的会话
  s.hooks.createTask = (_u, t) => { t.forked = forkSession({ home, fromDir: sessionDir(path.join(home, 'pi-chat'), 'chat-c1'), toDir: sessionDir(path.join(home, 'pi'), `task-${t.id}`) }); };
  let sub;
  try {
    await s.dispatcher.userMessage(U1, 'c1', { text: '帮我找望京安静的咖啡店' });
    await s.ended();
    assert.equal(s.tasks[0].forked, true);
    sub = await createPiRuntime({ home, createPiTools: async () => ({ systemPrompt: '', tools: [], close() {} }),
      env: { PI_MODEL: 'LongCat-2.5-Preview', PI_API_URL: s.url, PI_API_KEY: 'fake', PI_MAX_TURNS: '6', PI_MAX_TOKENS: '512' } });
    const run = sub.startRun({ input: '【你现在是子 agent】要做的事：找三家，交回店名和电话', session_id: 'task-t_1' });
    await run.done;
    assert.equal(run.status, 'completed');
    const body = s.requests.at(-1);
    assert.match(allText(body), /帮我找望京安静的咖啡店[\s\S]*好嘞～[\s\S]*【你现在是子 agent】/);
    // 复制时 subagent 这次调用还没有结果：Pi 补上结果，请求里的工具调用都有对应的结果
    const calls = body.messages.flatMap((m) => m.tool_calls || []).map((c) => c.id);
    assert.equal(calls.length, 1);
    assert.deepEqual(body.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id), calls);
    assert.doesNotMatch(allText(body), /已派出子 agent/, 'the copy was taken before the tool returned');
  } finally { await sub?.close(); await s.close(); }
});
