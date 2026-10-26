// 主 agent：真实的 agents（Pi runtime + 真实工具）+ 模拟模型和沙箱，App 的函数用假的。
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readdir, mkdir } from 'node:fs/promises';
import test from 'node:test';
import { createAgents } from './agents.mjs';
import { createMain } from './main.mjs';
import { createRuntime } from './runtime.mjs';

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
  res.end('data: [DONE]\n\n');
}
const textOf = (m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((c) => c.text || '').join(''));
const allText = (body) => body.messages.map(textOf).join('\n');
const until = async (check, ms = 10000) => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); }
};
const listen = async (server) => { await new Promise((ok) => server.listen(0, '127.0.0.1', ok)); return `http://127.0.0.1:${server.address().port}`; };

async function setup(reply) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cattuan-main-'));
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
  const sandbox = http.createServer((req, res) => res.end(JSON.stringify({ results: [{ title: `${new URL(req.url, 'http://x').searchParams.get('q')} 官网`, url: 'https://example.com/a', snippet: '营业到 22 点' }] })));
  const model = { id: 'LongCat-2.5-Preview', url: `${await listen(provider)}/v1`, key: 'fake', maxTokens: 512, contextWindow: 8192, maxTurns: 6 };
  const env = { CATTUAN_SANDBOX_URL: await listen(sandbox) };
  const agents = createAgents({ config: { env, models: { main: model, worker: model } } });
  const tasks = [];
  const goals = [];
  const posted = [];
  const acts = [];
  const quota = { tasks: '' };
  const actions = {
    tasks: () => tasks, goals: () => goals,
    createTask: (u, t) => { const task = { id: `t_${tasks.length + 1}`, uid: u.id, status: 'queued', round: 1, ...t }; if (t.forkChat) task.forked = agents.fork(u, t.forkChat, task.id); tasks.push(task); return task; },
    steerTask: async (t, text) => ({ state: 'sent', round: t.round || 1, text }),
    stopTask: (t) => t,
    overQuota: (_u, kind) => quota[kind] || '',
    goalLimit: () => '',
    scheduleLabel: () => '每 6 小时',
    createGoal: (u, g) => { const goal = { id: `g_${goals.length + 1}`, ...g, schedule: { every: 360 } }; goals.push(goal); return goal; },
    setGoalDone: (g) => { g.done = true; },
    taskResult: (t) => t.result || '（无）',
  };
  const main = createMain({
    agents, actions,
    context: (u, chatId) => `【现在】测试\n【聊天】${chatId}`,
    post: async (u, chatId, items) => { for (const it of items) posted.push({ uid: u.id, chatId, ...it }); },
    activity: { start: (u, chatId, title) => { const a = { title, steps: [] }; acts.push(a); return a; }, step: (a, s) => a.steps.push(s), end: (a, outcome, status) => Object.assign(a, { outcome, status }) },
    log: () => {},
  });
  const user = async (id) => { const home = path.join(dir, id); await mkdir(home, { recursive: true }); return { id, name: id, dir: home, home }; };
  const ended = (n = 1) => until(() => acts.filter((a) => a.status).length >= n);
  return { dir, model, requests, tasks, goals, posted, acts, quota, agents, main, ended, user,
    async close() { await agents.close(); provider.close(); sandbox.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('a reply plus subagent takes one model request, forks the chat and the reply carries the task id', { timeout: 30000 }, async () => {
  const s = await setup(() => ({ text: '好嘞，我去查查～', tools: [['subagent', { title: '找咖啡店', task: '找望京附近安静的咖啡店', category: 'life', skills: ['deep-research'] }]] }));
  try {
    const U1 = await s.user('u1');
    await s.main.userMessage(U1, 'c1', { text: '帮我找望京安静的咖啡店' });
    await s.ended();
    assert.equal(s.requests.length, 1, 'terminate should end the turn after the tool');
    assert.equal(s.tasks.length, 1);
    assert.equal(s.tasks[0].brief, '找望京附近安静的咖啡店');
    assert.deepEqual(s.tasks[0].skills, ['deep-research']);
    assert.equal(s.tasks[0].forkChat, 'c1', 'the subagent starts from a copy of this chat');
    assert.deepEqual(s.posted.map((m) => [m.text, m.taskId]), [['好嘞，我去查查～', 't_1']]);
    assert.match(s.acts[0].outcome, /派出子 agent「找咖啡店」/);
    assert.ok(s.acts[0].steps.includes('正在派出子 agent「找咖啡店」'));
    assert.match(allText(s.requests[0]), /【用户】帮我找望京安静的咖啡店/);
    assert.match(s.requests[0].messages[0].content, /你是「喵团」[\s\S]*聊天里和用户直接对话/, 'the main agent reads SOUL.md and MAIN.md');
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
    const U1 = await s.user('u1');
    await s.main.userMessage(U1, 'c1', { text: '帮我找望京的咖啡店' });
    await until(() => s.requests.length === 1);
    await s.main.userMessage(U1, 'c1', { text: '不对，是三里屯' });
    release();
    await s.ended();
    assert.equal(s.acts.length, 1, 'both messages are handled in a single main agent turn');
    assert.equal(s.tasks.length, 1);
    assert.equal(s.tasks[0].brief, '找三里屯的咖啡店');
    assert.equal(s.posted.at(-1).taskId, 't_1');
  } finally { await s.close(); }
});

test('the main agent searches by itself, answers directly and records what it did', { timeout: 30000 }, async () => {
  const s = await setup((body) => (body.messages.at(-1).role === 'tool'
    ? { text: '蓝果中古营业到晚上 10 点。' }
    : { text: '我查查～', tools: [['deep_web_search', { query: '蓝果中古首饰' }]] }));
  try {
    const U1 = await s.user('u1');
    await s.main.userMessage(U1, 'c1', { text: '你知道蓝果中古首饰吗' });
    await s.ended();
    assert.equal(s.requests.length, 2);
    assert.match(textOf(s.requests[1].messages.at(-1)), /蓝果中古首饰 官网/);
    assert.deepEqual(s.posted.map((m) => m.text), ['我查查～', '蓝果中古营业到晚上 10 点。']);
    assert.ok(s.acts[0].steps.includes('正在搜「蓝果中古首饰」'));
    assert.match(s.acts[0].outcome, /搜「蓝果中古首饰」，找到 1 条结果/);
    assert.equal(s.tasks.length, 0, 'no subagent for a one-step lookup');
  } finally { await s.close(); }
});

test('a finished task is told in the same session with its attachments, and later turns can use its result', { timeout: 30000 }, async () => {
  const s = await setup((body) => {
    const last = textOf(body.messages.at(-1));
    if (last.includes('【后台任务结果】')) return { text: '找到 3 家，最推荐 Manner。' };
    assert.match(allText(body), /第三家电话 010-1234/);
    return { text: '第三家电话是 010-1234。' };
  });
  try {
    const U1 = await s.user('u1');
    const doc = { type: 'document', title: '找咖啡店', body: '全文', sources: [] };
    await s.main.taskFinished(U1, 'c1', { task: { id: 't_9' }, title: '转述「找咖啡店」的结果', input: '【后台任务结果】任务 t_9 做完了：第三家电话 010-1234',
      fallback: '找到 3 家', attachments: [doc], last: { taskId: 't_9', round: 1 } });
    await s.ended();
    assert.deepEqual(s.posted.map((m) => [m.text, m.partOf, m.taskId, m.attachments]), [['找到 3 家，最推荐 Manner。', 't_9', 't_9', [doc]]]);
    await s.main.userMessage(U1, 'c1', { text: '第三家电话多少' });
    await s.ended(2);
    assert.equal(s.posted.at(-1).text, '第三家电话是 010-1234。');
    assert.equal(s.tasks.length, 0, 'answers from the session, no new task');
  } finally { await s.close(); }
});

test('the main agent gets work tools and chat tools but cannot place calls itself, and a question card rides on the reply', { timeout: 30000 }, async () => {
  const s = await setup(() => ({ text: '还差时间～', tools: [['ask_user', { questions: [{ label: '几点？', options: ['下午三点', '晚上七点'] }] }]] }));
  try {
    const U1 = await s.user('u1');
    await s.main.userMessage(U1, 'c1', { text: '帮我约美甲' });
    await s.ended();
    const names = s.requests[0].tools.map((t) => t.function.name);
    for (const name of ['deep_web_search', 'image_search', 'attach', 'subagent', 'ask_user', 'create_goal']) assert.ok(names.includes(name), name);
    for (const name of ['phone_call', 'goal_update']) assert.ok(!names.includes(name), name);
    assert.equal(s.posted.length, 1);
    assert.equal(s.posted[0].text, '还差时间～');
    assert.deepEqual(s.posted[0].attachments[0].questions.map((q) => q.options.map((o) => o.label)), [['下午三点', '晚上七点']]);
  } finally { await s.close(); }
});

test('images reach the main agent as local paths and no task is created for them', { timeout: 30000 }, async () => {
  const s = await setup(() => ({ text: '是绣球花～' }));
  try {
    const U1 = await s.user('u1');
    await s.main.userMessage(U1, 'c1', { text: '这是什么花', images: ['/data/users/u1/uploads/a.jpg'] });
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
    const U1 = await s.user('u1');
    s.quota.tasks = '今天的额度用完啦';
    await s.main.userMessage(U1, 'c1', { text: '找点猫猫图' });
    await s.ended();
    assert.equal(s.tasks.length, 0);
    assert.equal(s.requests.length, 2);
    assert.equal(s.posted.at(-1).text, '抱歉，今天额度用完了');
  } finally { await s.close(); }
});

test('a model failure falls back to a short apology', { timeout: 30000 }, async () => {
  const s = await setup(() => ({ status: 500 }));
  try {
    const U1 = await s.user('u1');
    await s.main.userMessage(U1, 'c1', { text: '在吗' });
    await s.ended();
    assert.equal(s.posted.at(-1).text, '我这边网络有点卡，等下再说一次？');
    assert.equal(s.acts[0].status, 'failed');
  } finally { await s.close(); }
});

test('chats and users keep separate sessions under each home', { timeout: 30000 }, async () => {
  const s = await setup((body) => ({ text: `收到：${textOf(body.messages.at(-1)).match(/【用户】(.+)/)?.[1]}` }));
  try {
    const U1 = await s.user('u1');
    const U2 = await s.user('u2');
    await s.main.userMessage(U1, 'c1', { text: '秘密A' });
    await s.ended(1);
    await s.main.userMessage(U1, 'c2', { text: '你好B' });
    await s.ended(2);
    await s.main.userMessage(U2, 'c1', { text: '你好C' });
    await s.ended(3);
    assert.doesNotMatch(allText(s.requests[1]), /秘密A/);
    assert.doesNotMatch(allText(s.requests[2]), /秘密A/);
    assert.equal((await readdir(path.join(s.dir, 'u1', 'pi', 'sessions'))).length, 2);
    assert.equal((await readdir(path.join(s.dir, 'u2', 'pi', 'sessions'))).length, 1);
  } finally { await s.close(); }
});

test('a subagent copied from the chat at dispatch time continues the whole conversation', { timeout: 30000 }, async () => {
  const s = await setup((_body, n) => (n === 1 ? { text: '好嘞～', tools: [['subagent', { title: '找咖啡店', task: '找三家，交回店名和电话' }]] } : { text: '找到三家' }));
  try {
    const U1 = await s.user('u1');
    await s.main.userMessage(U1, 'c1', { text: '帮我找望京安静的咖啡店' });
    await s.ended();
    assert.equal(s.tasks[0].forked, true);
    const rt = await s.agents.runtimeOf(U1);
    const run = rt.startRun({ input: '【你现在是子 agent】要做的事：找三家，交回店名和电话', sessionId: 'task-t_1' });
    await run.done;
    assert.equal(run.status, 'completed');
    const body = s.requests.at(-1);
    assert.match(allText(body), /帮我找望京安静的咖啡店[\s\S]*好嘞～[\s\S]*【你现在是子 agent】/);
    assert.ok(body.tools.some((t) => t.function.name === 'phone_call'), 'the subagent can place calls');
    // 复制时 subagent 这次调用还没有结果：Pi 补上结果，请求里的工具调用都有对应的结果
    const calls = body.messages.flatMap((m) => m.tool_calls || []).map((c) => c.id);
    assert.equal(calls.length, 1);
    assert.deepEqual(body.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id), calls);
    assert.doesNotMatch(allText(body), /已派出子 agent/, 'the copy was taken before the tool returned');
  } finally { await s.close(); }
});

test('runtime is shared by profile name, so the main and worker models can differ', async () => {
  const seen = [];
  const agents = createAgents({ config: { env: {}, models: { main: { id: 'm' }, worker: { id: 'w' } } },
    createRuntime: async ({ profiles }) => { seen.push(Object.keys(profiles), profiles.main.model.id, profiles.worker.model.id); return { close() {} }; } });
  await agents.runtimeOf({ id: 'u', home: os.tmpdir() });
  await agents.runtimeOf({ id: 'u', home: os.tmpdir() });
  assert.deepEqual(seen, [['main', 'worker'], 'm', 'w']);
  assert.equal(typeof createRuntime, 'function');
});
