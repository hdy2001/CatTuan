// 要约确认：调度者先写 call_confirm（只记 pendingCall，聊天里是一句普通回复），
// 用户点头后写 call_go，才派出 callMode=book 的任务。不打真电话，也不访问 LongCat。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PASSWORD = 'testpass1';
const CONFIRM_REPLY = '打给悦榕轩，明天下午三点两位美甲。要是改时间或者要定金，我先回来问你。现在打吗？';
const GO_REPLY = '📞 好，我打给悦榕轩约明天下午三点两位。';
const CONFIRM_BRIEF = '打给悦榕轩预约明天下午三点、两位美甲。改时间或要定金先回来问，先别答应。';
const NO_PENDING_REPLY = '我这边没有等你确认的电话了，要打给谁、约什么，再跟我说一下～';

const empty = { search: null, ask: null, steer: null, stop: null, goal: null, goal_done: null };
const confirmJson = {
  ...empty,
  reply: CONFIRM_REPLY,
  task: { title: '不该派出', brief: '模型若同时写了 task，确认阶段也不该派', call: 'book' },
  call_confirm: { title: '约悦榕轩', brief: CONFIRM_BRIEF, from: null },
  call_go: false,
  call_cancel: false,
};
const script = {
  completion: { messages: ['（测试）执行服务被拦住了，电话没打'] },
  rules: [
    {
      match: '【用户新消息】先问我时间',
      json: {
        ...empty,
        reply: '还差个时间。',
        ask: { questions: [{ tab: '时间', label: '什么时候去？', options: ['下午三点', '晚上七点'] }] },
        task: { title: '不该派出', brief: '提问时不派任务', call: 'book' },
        call_confirm: { title: '不该记下', brief: '提问时不记待确认电话', from: null },
        call_go: false,
        call_cancel: false,
      },
    },
    { match: '【用户新消息】约一下悦榕轩', json: confirmJson },
    { match: '【用户新消息】再约一次', json: { ...confirmJson, reply: '还是悦榕轩，明天下午三点两位。现在打吗？' } },
    {
      match: '【用户新消息】打吧',
      json: { ...empty, reply: GO_REPLY, task: null, call_confirm: null, call_go: true, call_cancel: false },
    },
    {
      match: '【用户新消息】不约了',
      json: { ...empty, reply: '好，那先不约了。', task: null, call_confirm: null, call_go: false, call_cancel: true },
    },
    {
      match: '【用户新消息】可以打了',
      json: { ...empty, reply: '📞 好，我现在打。', task: null, call_confirm: null, call_go: true, call_cancel: false },
    },
    {
      match: '【用户新消息】别问了直接约',
      json: {
        ...empty,
        reply: '好，我去约。',
        task: { title: '直接约店', brief: '打电话预约悦榕轩明天下午三点两位美甲', call: 'book', category: 'life' },
        call_confirm: null,
        call_go: false,
        call_cancel: false,
      },
    },
  ],
};

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(fn, ms = 3000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < ms) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) { last = error; }
    await sleep(40);
  }
  throw new Error(`timed out waiting: ${last && last.message ? last.message : JSON.stringify(last)}`);
}

test('聊天里没有单独的确认卡片：确认是普通文字，只有提问选项卡和通话组件', () => {
  const src = fs.readFileSync(path.join(APP_DIR, 'public/booking.js'), 'utf8');
  assert.match(src, /打之前确认、在打、没接通、要你定、结果都是普通文字消息/);
  assert.match(src, /if \(b\.type === 'ask'\) return askHtml\(b\);\s*if \(b\.type === 'calls'\) return b\.calls\.map\(callCardHtml\)\.join\(''\);\s*return '';/);
});

test('call_confirm 记下待确认的电话，call_go 才派出可预约任务', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cattuan-call-confirm-'));
  const scriptPath = path.join(dir, 'longcat.json');
  const logPath = path.join(dir, 'longcat.log');
  fs.writeFileSync(scriptPath, JSON.stringify(script));
  const created = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { openAccounts } from './accounts.mjs';
    const user = await openAccounts(process.env.CATTUAN_DATA_DIR).createUser({ name: 'calltest', password: process.env.CALLTEST_PASSWORD, role: 'admin' });
    process.stdout.write(user.id);
  `], {
    cwd: APP_DIR,
    env: { ...process.env, CATTUAN_DATA_DIR: dir, CALLTEST_PASSWORD: PASSWORD },
    encoding: 'utf8',
  });
  assert.equal(created.status, 0, created.stderr);
  const stateFile = path.join(dir, 'users', created.stdout.trim(), 'state.json');
  const port = await freePort();
  let logs = '';
  const child = spawn(process.execPath, ['--import', new URL('./call-confirm-fetch.mjs', import.meta.url).href, 'server.mjs'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      CATTUAN_DATA_DIR: dir,
      CATTUAN_LONGCAT_SCRIPT: scriptPath,
      CATTUAN_LONGCAT_LOG: logPath,
      PORT: String(port),
      HOST: '127.0.0.1',
      LONGCAT_API_KEY: 'stub',
      PUBLIC_ORIGIN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        sleep(2000).then(() => child.kill('SIGKILL')),
      ]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    try {
      const res = await fetch(`${base}/api/health`);
      return res.ok ? true : null;
    } catch { return null; }
  }, 15000).catch((error) => {
    throw new Error(`${error.message}\n${logs}`);
  });

  const api = async (pathname, { method = 'GET', body, token } = {}) => {
    const res = await fetch(base + pathname, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${pathname} → ${res.status} ${text.slice(0, 300)}\n${logs}`);
    return text ? JSON.parse(text) : null;
  };
  const token = (await api('/api/auth/login', { method: 'POST', body: { name: 'calltest', password: PASSWORD, token: true } })).token;
  const send = (text) => api('/api/message', { method: 'POST', token, body: { text } });
  const chat = () => api('/api/state', { token });
  const disk = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  // 状态是 200ms 防抖落盘的。等这条回复写进文件，同一次写入里的 pendingCall 才算数。
  const diskAfter = (text) => waitFor(() => {
    const saved = disk();
    return saved.messages?.some((m) => m.text === text) ? saved : null;
  });
  const bot = (state, text) => state.messages.find((m) => m.role === 'bot' && m.text === text);
  const prompts = () => fs.readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((row) => row.kind === 'dispatch');

  // 缺信息：提问选项卡优先，call_confirm 和 task 都被丢掉
  await send('先问我时间');
  let state = await chat();
  const asked = bot(state, '还差个时间。');
  assert.ok(asked, '应该先看到提问');
  assert.equal(asked.booking?.type, 'ask');
  assert.equal(asked.taskId, undefined);
  assert.equal(state.tasks.length, 0);
  assert.equal((await diskAfter('还差个时间。')).pendingCall, undefined);

  // 信息齐了：只记待确认，不派任务，回复上没有卡片
  await send('约一下悦榕轩');
  state = await chat();
  const confirm = bot(state, CONFIRM_REPLY);
  assert.ok(confirm, '确认回复应该原样出现在聊天里');
  assert.equal(confirm.booking, undefined);
  assert.equal(confirm.taskId, undefined);
  assert.equal(state.tasks.length, 0);
  const pending = (await diskAfter(CONFIRM_REPLY)).pendingCall;
  assert.equal(pending.brief, CONFIRM_BRIEF);
  assert.ok(pending.at);
  assert.deepEqual(pending.from, []);

  // 点头：按待确认的那通派任务，callMode 只能是 book，待确认清掉
  await send('打吧');
  state = await chat();
  const go = bot(state, GO_REPLY);
  assert.ok(go, '点头后的回复应该原样出现');
  assert.equal(go.booking, undefined);
  assert.ok(go.taskId);
  const booked = state.tasks.find((task) => task.id === go.taskId);
  assert.equal(booked.callMode, 'book');
  assert.equal(booked.title, '约悦榕轩');
  assert.match(booked.brief, new RegExp(`${CONFIRM_BRIEF}\\n用户已经确认，可以直接约。`));
  assert.equal((await diskAfter(GO_REPLY)).pendingCall, undefined);
  const goPrompt = prompts().find((row) => row.match === '【用户新消息】打吧');
  assert.equal(goPrompt.systemHasCallConfirm, true);
  assert.equal(goPrompt.systemAsksConfirm, true);
  assert.equal(goPrompt.pendingInPrompt, true);
  assert.match(goPrompt.pendingLine, /约悦榕轩/);
  assert.match(goPrompt.pendingLine, new RegExp(CONFIRM_BRIEF));

  // 改口不约：清掉待确认，不再派任务
  await send('再约一次');
  assert.equal((await diskAfter('还是悦榕轩，明天下午三点两位。现在打吗？')).pendingCall.title, '约悦榕轩');
  await send('不约了');
  state = await chat();
  assert.equal(bot(state, '好，那先不约了。').taskId, undefined);
  assert.equal(state.tasks.filter((task) => task.callMode === 'book').length, 1);
  assert.equal((await diskAfter('好，那先不约了。')).pendingCall, undefined);

  // 没有待确认时模型却写了 call_go：不派任务，回复改成说没有这通电话
  await send('可以打了');
  state = await chat();
  const stray = bot(state, NO_PENDING_REPLY);
  assert.ok(stray, '过期或不存在的确认不能说成已经在打');
  assert.equal(stray.taskId, undefined);
  assert.equal(state.messages.some((m) => m.text === '📞 好，我现在打。'), false);
  assert.equal(state.tasks.length, 1);

  // 模型跳过确认、直接在 task.call 里写 book：任务会派，但没有预约授权
  await send('别问了直接约');
  state = await chat();
  const direct = state.tasks.find((task) => task.title === '直接约店');
  assert.ok(direct);
  assert.equal(direct.callMode, undefined);
  assert.equal(bot(state, '好，我去约。').taskId, direct.id);
  assert.equal(state.tasks.filter((task) => task.callMode === 'book').length, 1);

  const evidence = {
    confirm: { text: confirm.text, booking: confirm.booking ?? null, taskId: confirm.taskId ?? null },
    pendingCall: { title: pending.title, brief: pending.brief },
    go: { text: go.text, booking: go.booking ?? null, taskId: go.taskId, callMode: booked.callMode },
    directBookWithoutConfirm: { title: direct.title, callMode: direct.callMode ?? null },
    strayCallGo: stray.text,
  };
  console.log(`call_confirm evidence ${JSON.stringify(evidence, null, 2)}`);
});
