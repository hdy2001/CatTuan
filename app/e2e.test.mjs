// 端到端：在临时数据目录里起整套 App（模拟模型 + 模拟沙箱），经 HTTP 接口走完聊天、派子 agent、附件、插话、停止、
// 打电话、目标、App 重启续跑和账号隔离。模拟模型按请求里有没有 subagent 工具分辨主 agent（main）和子 agent（worker），
// 不带工具的一次性 JSON 请求算 llm；场景由测试里的 script(role, body) 决定怎么回。
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { writeFakeCli, record } from './calls/fake-cli.mjs';

const APP = path.dirname(fileURLToPath(import.meta.url));

function chunk(res, delta, finish = null) {
  res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}
let callSeq = 0;
function respond(res, { text, tools = [] }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  chunk(res, { role: 'assistant', ...(text && { content: text }) });
  tools.forEach(([name, args], index) => chunk(res, { tool_calls: [{ index, id: `call_${name}_${++callSeq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }));
  chunk(res, {}, tools.length ? 'tool_calls' : 'stop');
  res.end('data: [DONE]\n\n');
}
const textOf = (m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((c) => c.text || '').join(''));
const lastText = (body) => textOf(body.messages.at(-1));
const anyText = (body, needle) => body.messages.some((m) => textOf(m).includes(needle));
const afterTool = (body) => body.messages.at(-1).role === 'tool';

async function listen(server) {
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  return server.address().port;
}
async function freePort() {
  const s = http.createServer();
  const port = await listen(s);
  await new Promise((ok) => s.close(ok));
  return port;
}
async function until(check, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// 起整套服务。script(role, body, req) → { text, tools } | { json }（llm）| Promise
async function stack(script, env = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cattuan-e2e-'));
  const requests = [];
  const model = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks));
    const role = !body.stream ? 'llm' : (body.tools || []).some((t) => t.function?.name === 'subagent') ? 'main' : 'worker';
    requests.push({ role, body });
    try {
      const out = await script(role, body, req);
      if (role === 'llm') return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(out.json) } }] }));
      respond(res, out);
    } catch (e) { if (!res.headersSent) { res.writeHead(500); res.end(e.message); } }
  });
  const sandbox = http.createServer((req, res) => {
    if (req.url.startsWith('/live/frames')) return res.end('{}');
    if (req.url.startsWith('/live')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return; } // 一直开着、不推东西
    if (req.url.startsWith('/web/search')) return res.end(JSON.stringify({ results: [{ title: '示例结果', url: 'https://example.com/', snippet: '摘要' }] }));
    if (req.url.startsWith('/web/read')) return res.end(JSON.stringify({ title: '示例', text: '正文', finalUrl: 'https://example.com/' }));
    res.writeHead(404); res.end('{}');
  });
  const modelUrl = `http://127.0.0.1:${await listen(model)}/v1`;
  const sandboxUrl = `http://127.0.0.1:${await listen(sandbox)}`;
  const appPort = await freePort();
  const appUrl = `http://127.0.0.1:${appPort}`;
  const log = [];
  const appEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TZ: process.env.TZ || 'Asia/Shanghai',
    CATTUAN_DATA_DIR: dir, CATTUAN_SANDBOX_URL: sandboxUrl, LONGCAT_API_KEY: 'fake-e2e-key',
    PORT: String(appPort), DISPATCH_API_URL: modelUrl, PI_API_URL: modelUrl, PI_MAX_TURNS: '8', ...env };

  // 账号：直接写库，建好主目录（和 scripts/user.mjs add 一样）
  process.env.CATTUAN_DATA_DIR = dir;
  const { openAccounts } = await import('./accounts.mjs');
  const { provision } = await import('./homes.mjs');
  const accounts = openAccounts(dir);
  for (const name of ['alice', 'bob']) provision(await accounts.createUser({ name, password: 'password-e2e' }));

  let app;
  async function boot() {
    app = spawn(process.execPath, ['server.mjs'], { cwd: APP, env: appEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    app.stdout.on('data', (d) => log.push(String(d)));
    app.stderr.on('data', (d) => log.push(String(d)));
    await until(async () => (await fetch(`${appUrl}/api/health`).catch(() => null))?.ok, 'app health');
  }
  async function shutdown() {
    if (app.exitCode === null) { app.kill('SIGTERM'); await new Promise((ok) => app.once('exit', ok)); }
  }
  await boot();

  async function login(name) {
    const r = await fetch(`${appUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, password: 'password-e2e', token: true }) });
    assert.equal(r.status, 200, await r.clone().text());
    const { token } = await r.json();
    const call = async (pathname, { method = 'GET', body } = {}) => {
      const res = await fetch(`${appUrl}${pathname}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body && { 'Content-Type': 'application/json' }) }, body: body && JSON.stringify(body) });
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch { json = text; }
      return { status: res.status, body: json };
    };
    return {
      call,
      state: async () => (await call('/api/state')).body,
      send: (text) => call('/api/message', { method: 'POST', body: { text } }),
      waitFor: (pred, what) => until(async () => pred(await (await call('/api/state')).body), what),
    };
  }

  return {
    requests, login, log,
    worker: () => requests.filter((r) => r.role === 'worker').map((r) => r.body),
    async restart() { await shutdown(); await boot(); },
    async close() {
      await shutdown();
      accounts.db.close();
      model.closeAllConnections(); sandbox.closeAllConnections();
      await Promise.all([new Promise((ok) => model.close(ok)), new Promise((ok) => sandbox.close(ok))]);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const botTexts = (s) => s.messages.filter((m) => m.role === 'bot').map((m) => m.text || '');
async function run(t, s, body) {
  try { await body(); } catch (e) { console.error(s.log.join('').slice(-4000)); throw e; } finally { await s.close(); }
}

test('e2e: chat, subagent with a document, steering, stop and account isolation', { timeout: 120000 }, async (t) => {
  let releaseSlow, releaseSteer;
  const slow = new Promise((ok) => { releaseSlow = ok; });
  const steerGate = new Promise((ok) => { releaseSteer = ok; });
  const s = await stack(async (role, body, req) => {
    const last = lastText(body);
    if (role === 'main') {
      if (afterTool(body)) return { text: '' };
      if (last.includes('【后台任务结果】') && last.includes('调研咖啡')) return { text: '找到三家咖啡店，最推荐 Manner。' };
      if (last.includes('【后台任务结果】')) return { text: '改好了～' };
      if (last.includes('E2E 你好')) return { text: '你好呀～' };
      if (last.includes('E2E 调研')) return { text: '好嘞，我去查～', tools: [['subagent', { title: '调研咖啡', task: '调研望京咖啡店', category: 'life', skills: ['deep-research'] }]] };
      if (last.includes('E2E 慢任务')) return { text: '收到～', tools: [['subagent', { title: '慢任务', task: 'E2E-SLOW 慢慢做' }]] };
      if (last.includes('E2E 插话')) return { text: '在做～', tools: [['subagent', { title: '插话任务', task: 'E2E-STEER 查一下' }]] };
      return { text: '嗯嗯' };
    }
    if (anyText(body, 'E2E-SLOW')) {
      await new Promise((ok) => { req.once('close', ok); slow.then(ok); }); // 一直不回，直到被停掉
      return { text: '慢任务结束' };
    }
    if (anyText(body, 'E2E-STEER')) {
      if (!afterTool(body)) { await steerGate; return { tools: [['deep_web_search', { query: '北京' }]] }; }
      return { text: anyText(body, '换成上海') ? '已按要求换成上海。' : '没看到插话' };
    }
    if (!afterTool(body)) return { tools: [['attach', { document: { title: '望京咖啡店', body: '## 结论\nManner 最安静 [1]', sources: [{ title: '点评', url: 'https://example.com/r' }] } }]] };
    return { text: '调研结果：望京有三家咖啡店，Manner 最安静。' };
  });
  await run(t, s, async () => {
    const alice = await s.login('alice');
    const bob = await s.login('bob');

    await t.test('main agent replies in chat', async () => {
      assert.equal((await alice.send('E2E 你好')).status, 200);
      await alice.waitFor((st) => botTexts(st).includes('你好呀～'), 'reply');
    });

    let taskId;
    await t.test('the subagent result and its document come back to the chat', async () => {
      await alice.send('E2E 调研 望京咖啡店');
      const st = await alice.waitFor((x) => botTexts(x).includes('找到三家咖啡店，最推荐 Manner。') && x, 'task delivered');
      const task = st.tasks.find((k) => k.title === '调研咖啡');
      taskId = task.id;
      assert.equal(task.status, 'done');
      assert.match(task.result.text, /Manner 最安静/);
      assert.deepEqual(task.skills, ['deep-research']);
      assert.equal(task.steps[0].title, '附上「望京咖啡店」');
      const msg = st.messages.find((m) => m.text === '找到三家咖啡店，最推荐 Manner。');
      assert.equal(msg.taskId, task.id);
      assert.deepEqual(msg.attachments, [{ type: 'document', title: '望京咖啡店', body: '## 结论\nManner 最安静 [1]', sources: [{ n: 1, title: '点评', url: 'https://example.com/r' }] }]);
      assert.ok(st.messages.some((m) => m.role === 'bot' && m.text === '好嘞，我去查～' && m.taskId === task.id));
      const worker = s.worker();
      assert.ok(worker[0].messages.some((m) => textOf(m).includes('E2E 调研 望京咖啡店')), 'the subagent sees the forked chat');
      assert.match(lastText(worker[0]), /先用 skill_view 加载这些技能，按里面的方法做：deep-research/);
      assert.match(worker[0].messages[0].content, /在后台替主 agent 办事的子 agent/, 'the subagent reads WORKER.md');
      assert.ok(!worker[0].tools.some((x) => x.function.name === 'subagent'), 'subagents cannot dispatch subagents');
      assert.equal((await alice.call('/api/profile')).body.reports, 1);
    });

    await t.test('steering a running task reaches the same run', async () => {
      await alice.send('E2E 插话');
      const t1 = await alice.waitFor((x) => x.tasks.find((k) => k.title === '插话任务' && k.status === 'running'), 'steer task running');
      await until(() => s.worker().some((b) => anyText(b, 'E2E-STEER')), 'worker asked');
      const r = await alice.call(`/api/tasks/${t1.id}/steer`, { method: 'POST', body: { text: '换成上海' } });
      assert.equal(r.status, 200);
      assert.equal(r.body.state, 'sent');
      releaseSteer();
      const done = await alice.waitFor((x) => x.tasks.find((k) => k.id === t1.id && k.status === 'done'), 'steered task done');
      assert.equal(done.result.text, '已按要求换成上海。');
      assert.equal(done.revisions[0].state, 'delivered');
      assert.equal(done.round, 1);
    });

    await t.test('stopping a running task', async () => {
      await alice.send('E2E 慢任务');
      const st = await alice.waitFor((x) => x.tasks.find((k) => k.title === '慢任务' && k.status === 'running'), 'slow task running');
      assert.equal((await alice.call(`/api/tasks/${st.id}/stop`, { method: 'POST' })).status, 200);
      await alice.waitFor((x) => x.tasks.find((k) => k.id === st.id)?.status === 'stopped', 'slow task stopped');
    });

    await t.test('accounts are isolated', async () => {
      const st = await bob.state();
      assert.ok(!st.messages.some((m) => /E2E|你好呀/.test(m.text || '')));
      assert.equal(st.tasks.length, 0);
      assert.equal((await bob.call(`/api/tasks/${taskId}/retry`, { method: 'POST' })).status, 404);
      assert.equal((await bob.call(`/api/tasks/${taskId}/stop`, { method: 'POST' })).status, 404);
      assert.equal((await alice.call('/api/tasks/nope/stop', { method: 'PATCH' })).status, 405);
    });
  });
  releaseSlow();
});

test('e2e: a phone call reports progress and comes back with its call card', { timeout: 120000 }, async (t) => {
  // 假的木星 CLI：拨出去拿到 C-e2e，第一次查话单就有结果（不会真的打电话）
  const fake = await mkdtemp(path.join(os.tmpdir(), 'cattuan-e2e-cli-'));
  t.after(() => rm(fake, { recursive: true, force: true }));
  const cli = writeFakeCli(fake, { aicall: { out: { contactId: 'C-e2e' } },
    query: [{ out: [record('C-e2e', { lines: [{ role: 'robot', text: '您好，我是喵团' }, { role: 'customer', text: '下午三点有位' }] })] }] });
  const s = await stack(async (role, body) => {
    if (role === 'llm') return { json: { outcome: 'answered', answers: {}, summary: '下午三点有位' } };
    const last = lastText(body);
    if (role === 'main') {
      if (afterTool(body)) return { text: '' };
      if (last.includes('【后台任务结果】')) return { text: '✅ 下午三点有位～' };
      return { text: '📞 好，我打过去问问', tools: [['subagent', { title: '问美甲', task: '打给栗子美甲问下午三点有没有位', skills: ['phone-call'] }]] };
    }
    if (!afterTool(body)) return { tools: [['phone_call', { to: '010-12345678', name: '栗子美甲（和平里店）', goal: '问下午三点有没有位', mode: 'ask', category: '美甲' }]] };
    return { text: '栗子美甲：下午三点有位。' };
  }, { JUPITER_CLI: cli.bin, JUPITER_TENANT_ID: 'tenant-e2e', JUPITER_ROUTE_POINT: '1', JUPITER_POLL_SECONDS: '0' });
  await run(t, s, async () => {
    const alice = await s.login('alice');
    await alice.send('帮我问问栗子美甲下午三点有没有位');
    const st = await alice.waitFor((x) => botTexts(x).includes('✅ 下午三点有位～') && x, 'call delivered');
    const task = st.tasks.find((k) => k.title === '问美甲');
    const step = task.steps.find((x) => x.name === 'phone_call');
    assert.equal(step.title, '打完给「栗子美甲（和平里店）」的电话');
    assert.equal(step.progress.call.stage, 'done');
    const msg = st.messages.find((m) => m.text === '✅ 下午三点有位～');
    assert.equal(msg.attachments[0].type, 'calls');
    assert.equal(msg.attachments[0].calls[0].short, '栗子美甲');
    const log = (await alice.call('/api/calls')).body;
    assert.equal(log.line, '美团专线');
    assert.equal(log.calls[0].summary, '下午三点有位');
    assert.equal(log.calls[0].taskId, task.id);
    assert.equal(log.calls[0].ref, 'C-e2e');
    assert.equal(log.calls[0].lines.length, 2);
    const media = JSON.parse(cli.calls()[0].argv.at(-1));
    assert.deepEqual([media.电话号码, media.merchantName, media.category, media.mode, media.allowedInfo], ['01012345678', '栗子美甲（和平里店）', '美甲', 'ask', '不提供任何顾客信息']);
  });
});

test('e2e: goals check quietly, tell news through the main agent, and can be created from one sentence', { timeout: 120000 }, async (t) => {
  let news = false;
  const s = await stack(async (role, body) => {
    if (role === 'llm') return { json: { title: '盯机票', brief: '看北京到上海的机票价格', schedule: { every: 120 } } };
    const last = lastText(body);
    if (role === 'main') {
      if (afterTool(body)) return { text: '' };
      if (last.includes('【目标进展】')) return { text: '天气变了：明天有雨☔' };
      if (last.includes('E2E 盯着')) return { text: '好，我帮你盯着～', tools: [['create_goal', { title: '盯天气', brief: '每天看看北京天气', schedule: { every: 360 } }]] };
      return { text: '嗯嗯' };
    }
    if (afterTool(body)) return { text: news ? '明天转雨，记得带伞。' : '北京晴，25 度，和上次一样。' };
    return { tools: [['goal_update', news ? { status: '明天有雨', notify: true, done: false } : { status: '北京晴，25 度', notify: false, done: false }]] };
  });
  await run(t, s, async () => {
    const alice = await s.login('alice');
    await alice.send('E2E 盯着北京天气');
    const goal = await alice.waitFor((x) => x.goals.find((g) => g.title === '盯天气' && g.log?.some((l) => l.type === 'check')), 'goal checked');
    assert.equal(goal.status.text, '北京晴，25 度');
    assert.deepEqual(goal.log.map((l) => l.type), ['created', 'check']);
    assert.ok(goal.chatId);
    assert.ok(!botTexts(await alice.state()).some((x) => /北京晴/.test(x)), 'no news means no chat message');
    assert.ok(s.worker()[0].tools.some((x) => x.function.name === 'goal_update'));

    news = true;
    assert.equal((await alice.call(`/api/goals/${goal.id}/run`, { method: 'POST' })).status, 200);
    const st = await alice.waitFor((x) => botTexts(x).includes('天气变了：明天有雨☔') && x, 'goal news');
    const msg = st.messages.find((m) => m.text === '天气变了：明天有雨☔');
    assert.equal(msg.goalId, goal.id);
    assert.equal(st.goals.find((g) => g.id === goal.id).log.at(-1).notify, true);

    const created = await alice.call('/api/goals', { method: 'POST', body: { text: '帮我盯着北京到上海的机票' } });
    assert.equal(created.status, 200);
    assert.equal(created.body.title, '盯机票');
    assert.deepEqual(created.body.schedule, { every: 120 });
    const patched = await alice.call(`/api/goals/${created.body.id}`, { method: 'PATCH', body: { enabled: false } });
    assert.equal(patched.body.log.at(-1).type, 'paused');
  });
});

test('e2e: a task interrupted by an App restart resumes in the same session', { timeout: 120000 }, async (t) => {
  let hold = true;
  const s = await stack(async (role, body, req) => {
    const last = lastText(body);
    if (role === 'main') {
      if (afterTool(body)) return { text: '' };
      if (last.includes('【后台任务结果】')) return { text: '接着做完啦～' };
      return { text: '收到～', tools: [['subagent', { title: '长任务', task: 'E2E-LONG 做完交回' }]] };
    }
    if (hold) { await new Promise((ok) => req.once('close', ok)); return { text: '' }; }
    return { text: anyText(body, 'App 重启打断了上一轮') ? '重启后做完了。' : '没看到续跑说明' };
  });
  await run(t, s, async () => {
    let alice = await s.login('alice');
    await alice.send('E2E 长任务');
    await alice.waitFor((x) => x.tasks.find((k) => k.title === '长任务' && k.status === 'running'), 'long task running');
    await until(() => s.worker().length, 'worker asked');
    hold = false;
    await s.restart();
    alice = await s.login('alice');
    const st = await alice.waitFor((x) => botTexts(x).includes('接着做完啦～') && x, 'resumed task delivered');
    const task = st.tasks.find((k) => k.title === '长任务');
    assert.equal(task.status, 'done');
    assert.equal(task.result.text, '重启后做完了。');
    assert.ok(s.worker().at(-1).messages.some((m) => textOf(m).includes('E2E-LONG')), 'the resumed run keeps the original session');
  });
});
