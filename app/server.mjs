// CatTuan BFF —— Muse 式「调度者 + 后台执行 agent」：
//   调度者（dispatcher）：直接调 LongCat、不带工具，几秒内用聊天口吻短回复，并决定要不要派后台任务。
//   执行 agent（executor）：Hermes（搜索 / 社媒账号 / 做网页 / 识图 / 记账 / 记忆工具），在后台跑，App 关了也继续。
//   任务完成后，调度者把结果转成聊天消息发回来；聊天、任务、目标都存在服务端，经 SSE 推给 App。
//   目标（goal，仿 Muse Goal）：持续运行、定期检查的后台目标，有新进展才在聊天里说，目标列表显示最新状态。
//   记账：调度者能直接记账；账本与执行 agent 的 ledger 插件共用这个人主目录下的 ledger/，AI 自动维护「记账管家」目标。
//   多人：账号见 app/accounts.mjs（只能邀请，scripts/user.mjs 管）；每个人的聊天、任务、目标存在 <数据目录>/users/<id>/，
//   执行 agent 每人一个（各自的 HERMES_HOME，见 app/homes.mjs，由 scripts/agents.mjs 守护）；沙箱浏览器大家共用，平台由管理员登录。
// 零依赖：node app/server.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { openAccounts } from './accounts.mjs';
import { TEMPLATE, dataDir, userDir, homeOf, agentOf, readEnvFile } from './homes.mjs';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const DATA_DIR = dataDir(); // CATTUAN_DATA_DIR，默认 app/data

// 仓库的 hermes-home/.env：大家共用的 LongCat key、Langfuse 的 key（每个人 agent 自己的端口和 key 在各自主目录的 .env）
const hermesEnv = readEnvFile(path.join(TEMPLATE, '.env'));
const LONGCAT_KEY = process.env.LONGCAT_API_KEY || hermesEnv.LONGCAT_API_KEY
  || readEnvFile(path.join(os.homedir(), '.hermes/.env')).LONGCAT_API_KEY;
const LONGCAT_URL = 'https://api.longcat.chat/openai/v1/chat/completions';
const DISPATCH_MODEL = process.env.DISPATCH_MODEL || 'LongCat-2.5-Preview';
const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || '127.0.0.1'; // 线上也只听本机，由 Caddy 反代出去
// 对外地址：放到 HTTPS 反代后面时设成 https://app.example.com（来源校验、网站的 CSP 都按它来）；本机开发不用设。
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
const APP_ORIGINS = PUBLIC_ORIGIN ? [PUBLIC_ORIGIN] : [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
// 网站：执行 agent 的 publish_site 写到这个人主目录的 sites/<id>/，App 在单独端口上提供（和 App 不同源）。
const SITES_PORT = Number(process.env.SITES_PORT || PORT + 1);
// 网站的对外地址：线上是单独的子域名（https://sites.example.com），和 App 不同源；本机是 :3211。
const SITES_ORIGIN = (process.env.SITES_ORIGIN || `http://localhost:${SITES_PORT}`).replace(/\/+$/, '');
// 后台任务并发：全局最多几个同时跑（沙箱浏览器是串行的，开多了也只是排队），每人最多几个，轮流取
const MAX_RUNNING = Number(process.env.MAX_RUNNING || 4);
const MAX_RUNNING_PER_USER = Number(process.env.MAX_RUNNING_PER_USER || 2);
// 普通成员每天的用量上限（管理员不限）：大家共用一个 LongCat key，主要防目标检查和后台任务把额度跑光
const QUOTA = {
  messages: Number(process.env.QUOTA_MESSAGES_PER_DAY || 300),
  tasks: Number(process.env.QUOTA_TASKS_PER_DAY || 40),
  goalChecks: Number(process.env.QUOTA_GOAL_CHECKS_PER_DAY || 48),
  goals: Number(process.env.QUOTA_GOALS || 5),
  goalMinEvery: Number(process.env.QUOTA_GOAL_MIN_EVERY || 60),
};
const accounts = openAccounts(DATA_DIR);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json',
};
const STEP_LABEL = {
  official_photos: '看社媒账号', official_account: '找社媒账号', idol_photo_search: '搜图片', memory: '翻记忆',
  session_search: '翻聊天记录', vision_analyze: '看图', tool_search: '准备工具', tool_describe: '准备工具',
  ledger_query: '查账', ledger_add: '记账', ledger_delete: '删账', ledger_memory: '整理记账记忆',
  deep_web_search: '网页搜索', read_webpage: '读网页', skill_view: '翻技能手册', skill_store: '找技能', fetch_url: '读网址',
  publish_site: '发布网页', read_site: '读网站源码', check_site: '检查网页',
};

// ---------- 每个人的状态（服务端持久化）：<数据目录>/users/<id>/state.json ----------
// 聊天、消息、任务、目标、动态、位置、统计都按人分开存。任务、目标、动态上记着 uid，后台流程（任务队列、目标调度、
// agent 推来的工具调用、沙箱的实时画面）凭它找回是谁的；上传的图、浏览回放也放在各自的目录下。
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const newId = (p) => `${p}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const users = new Map(); // 用户 id → { id, name, role, status, dir, home, state, clients, saveTimer }
const U = (x) => users.get(x?.uid);
const active = (u) => u?.status !== 'disabled';

// 载入一个人的状态：第一次用到时从磁盘读，之后一直是内存里这一份（账号信息变了就跟着更新）
function loadUser(row) {
  const known = users.get(row.id);
  if (known) return Object.assign(known, { name: row.name, role: row.role, status: row.status });
  const dir = userDir(row.id);
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  const state = { messages: [], tasks: [], goals: [], chats: [], activity: [], ...readJson(path.join(dir, 'state.json'), {}) };
  delete state.feed; // 「动态」已由目标取代
  const u = { id: row.id, name: row.name, role: row.role, status: row.status, dir, home: homeOf(row), state, clients: new Set(), saveTimer: null };
  users.set(u.id, u);
  for (const x of [...state.tasks, ...state.goals, ...state.activity]) x.uid = u.id; // 单用户版的老数据上没有 uid
  for (const t of state.tasks) {
    // App 重启时 Hermes 那边可能还在跑这一轮（/v1/runs）：启动后按 run id 接回事件流，不重跑。
    if (t.status === 'running' && t.runId) { t.reattach = true; continue; }
    // 其余没跑完的任务：重新排队，启动后接着跑（不再直接判失败）。
    if (t.status === 'running' || t.status === 'queued') Object.assign(t, { status: 'queued', steps: [], startedAt: undefined, resumed: true, runId: undefined });
  }
  // 喵团简历上的累计数据：任务、报告用计数器（state.tasks 只留最近 80 个）；第一次启用时按现有数据起个头
  state.stats ||= {
    tasksDone: state.tasks.filter((t) => t.status === 'done' && t.kind !== 'goal').length,
    reports: state.messages.filter((m) => m.report).length,
    since: [...state.tasks.map((t) => t.createdAt), ...state.messages.map((m) => m.at)].filter(Boolean).sort()[0] || new Date().toISOString(),
  };
  for (const a of state.activity) if (a.status === 'running') Object.assign(a, { status: 'failed', step: '', outcome: 'App 重启，这件事中断了' });
  // 加聊天功能之前的消息都归到一个聊天里
  if (!state.chats.length && state.messages.length) {
    const first = state.messages[0].at || new Date().toISOString();
    const chat = { id: newId('c'), title: NEW_CHAT_TITLE, createdAt: first, updatedAt: state.messages.at(-1).at || first };
    const firstAsk = state.messages.find((m) => m.role === 'me' && m.text);
    if (firstAsk) chat.title = firstAsk.text.replace(/\s+/g, ' ').slice(0, 20);
    state.chats.push(chat);
    state.messages.forEach((m) => { m.chatId = chat.id; });
    state.currentChat = chat.id;
  }
  if (!state.chats.some((c) => c.id === state.currentChat)) {
    if (state.chats.length) state.currentChat = chatList(u)[0].id; else newChat(u);
  }
  // 按最新的解析规则重算已经发出的研究报告（解析规则改过时，老报告也能显示干净）。
  for (const m of state.messages) {
    const t = m.report && state.tasks.find((x) => x.id === m.taskId);
    if (t?.result?.text) m.report = { title: t.title, ...parseReport(t.result.text) };
  }
  // 发布网页功能上线前，agent 把整页 HTML 贴在了回复里：补发布成网站，挂到那条结果消息上。
  for (const t of state.tasks) {
    if (t.status !== 'done' || !t.result?.text || t.result.sites?.length) continue;
    t.result = rescueHtmlSite(u, t.result, t.title);
    const m = t.result.sites?.length && state.messages.findLast((x) => x.role === 'bot' && x.taskId === t.id);
    if (m && !m.sites?.length) m.sites = t.result.sites;
  }
  // 清掉已经不在任务列表里的回放帧
  try {
    const keep = new Set(state.tasks.map((t) => t.id));
    for (const d of fs.readdirSync(path.join(dir, 'frames'))) if (!keep.has(d)) fs.rmSync(path.join(dir, 'frames', d), { recursive: true, force: true });
  } catch {}
  save(u);
  return u;
}

// 先写临时文件再换名：写到一半进程被杀也不会把整个状态写坏
function writeState(u) {
  clearTimeout(u.saveTimer);
  u.saveTimer = null;
  const s = u.state;
  const file = path.join(u.dir, 'state.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({
    // 每个聊天最多留最近 300 条
    messages: s.chats.flatMap((c) => s.messages.filter((m) => m.chatId === c.id).slice(-300)),
    chats: s.chats, currentChat: s.currentChat, stats: s.stats, activity: s.activity.slice(-60),
    tasks: s.tasks.slice(-80), goals: s.goals, location: s.location,
  }));
  fs.renameSync(`${file}.tmp`, file);
}
function save(u) {
  clearTimeout(u.saveTimer);
  u.saveTimer = setTimeout(() => writeState(u), 200);
}
// systemd 重启（每次发版）时，把还没落盘的状态写完再退
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    for (const u of users.values()) if (u.saveTimer) writeState(u);
    process.exit(0);
  });
}

// SSE：只推给这个人自己开着的页面
function broadcast(u, ev) {
  const frame = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of u.clients) res.write(frame);
}
const watching = () => [...users.values()].some((u) => u.clients.size > 0); // 有没有人开着 App：决定沙箱推不推连续画面

// ---------- 轨迹（Langfuse，调试用）：hermes-home/.env 里有 HERMES_LANGFUSE_* 才开（scripts/start-langfuse.sh 会写上） ----------
// 调度者做的每件事（一条喵团动态：回消息、转述结果、推目标进展、建目标）是一条 trace：每次 LongCat 调用一个 generation，
// 每一步一个 event，调度结果（模型原始输出 → App 兜底改写后的决定）一个 event。后台任务每一轮在 App 这边也记一条：
// 发给执行 agent 的完整任务说明、结局、出错原因（agent 没收到请求、连接断了这类 Hermes 那边看不到的问题）。
// Langfuse 会话 = Hermes 会话：和任务有关的都记在 task-<任务 id>，Hermes 的 langfuse 插件把执行 agent 的每一轮（每次 LLM 调用、
// 每个工具调用）也记在这个会话里。在 Langfuse 的 Sessions 里打开 task-<id>，就是从用户消息、调度决策、执行 agent 到转述的完整轨迹。
// 和任务无关的聊天记在 chat-<聊天 id>。用 OTLP/HTTP JSON 直接发（零依赖）；Langfuse 没开、发送失败都只丢轨迹，不影响 App。
const LF_URL = (hermesEnv.HERMES_LANGFUSE_BASE_URL || 'https://cloud.langfuse.com').replace(/\/+$/, '');
const LF_AUTH = hermesEnv.HERMES_LANGFUSE_PUBLIC_KEY && hermesEnv.HERMES_LANGFUSE_SECRET_KEY
  ? `Basic ${Buffer.from(`${hermesEnv.HERMES_LANGFUSE_PUBLIC_KEY}:${hermesEnv.HERMES_LANGFUSE_SECRET_KEY}`).toString('base64')}` : '';
const ACT_LABEL = { message: '回消息', deliver: '转述结果', goal: '目标' };
const traceCtx = new AsyncLocalStorage(); // 当前在做哪件事（哪条动态）：longcat() 据此把调用记到那条 trace 下
const lfOpen = new Map(); // 还没做完的事：动态 id → { act, traceId, rootId, start, input, spans }
const lfQueue = [];
let lfTimer = null;
let lfWarnedAt = 0;
let lfProject = null;
let lfProjectAskedAt = 0;
const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');
const nanos = (ms) => String(BigInt(Math.round(ms)) * 1_000_000n);

function otelValue(v) {
  if (typeof v === 'boolean') return { boolValue: v };
  if (Number.isInteger(v)) return { intValue: String(v) };
  if (typeof v === 'number') return { doubleValue: v };
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return { arrayValue: { values: v.map((x) => ({ stringValue: x })) } };
  return { stringValue: (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 50_000) };
}

// 同一条 trace 的每个 span 都带上 trace 名、会话、标签和是谁（Langfuse v4 按 observation 聚合；Users 页能按人看）
const traceAttrs = (name, session, tags, user) => ({ 'langfuse.trace.name': name, 'langfuse.session.id': session, 'langfuse.trace.tags': ['cattuan', ...tags], 'langfuse.user.id': user });

function lfSpan({ traceId, spanId = hex(8), parentId, name, start, end, attrs }) {
  if (!LF_AUTH) return;
  lfQueue.push({
    traceId, spanId, ...(parentId && { parentSpanId: parentId }), name: String(name || '').slice(0, 200), kind: 1,
    startTimeUnixNano: nanos(start), endTimeUnixNano: nanos(end ?? start),
    attributes: Object.entries(attrs).filter(([, v]) => v != null && v !== '').map(([key, v]) => ({ key, value: otelValue(v) })),
  });
  lfTimer ||= setTimeout(lfFlush, 1000);
}

// 攒一秒发一批
async function lfFlush() {
  lfTimer = null;
  const spans = lfQueue.splice(0, 200);
  if (lfQueue.length) lfTimer = setTimeout(lfFlush, 1000);
  try {
    const r = await fetch(`${LF_URL}/api/public/otel/v1/traces`, {
      method: 'POST',
      headers: { Authorization: LF_AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'cattuan-app' } }] },
        scopeSpans: [{ scope: { name: 'cattuan-dispatcher' }, spans }],
      }] }, cleanStrings),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  } catch (e) {
    if (Date.now() - lfWarnedAt > 60_000) { lfWarnedAt = Date.now(); console.error('[langfuse] 轨迹没发出去：', e.message); }
  }
}

// 一件事开始：建 trace。子 span 先攒着，做完时一起发（派了任务、改了任务之后才知道该记到哪个会话）。
function lfStart(a, input) {
  if (!LF_AUTH) return;
  a.traceId = hex(16);
  lfOpen.set(a.id, { act: a, traceId: a.traceId, rootId: hex(8), start: Date.now(), input, spans: [] });
}

function lfChild(a, span) {
  const o = a && lfOpen.get(a.id);
  if (o) o.spans.push({ ...span, traceId: o.traceId, parentId: o.rootId });
  else lfSpan({ ...span, traceId: hex(16), attrs: { ...traceAttrs(`调度者 · ${span.name}`, '', ['standalone']), ...span.attrs } });
}

const lfEvent = (a, name, attrs = {}) => lfChild(a, { name, start: Date.now(), attrs: { 'langfuse.observation.type': 'event', ...attrs } });

function lfEnd(a) {
  const o = lfOpen.get(a.id);
  if (!o) return;
  lfOpen.delete(a.id);
  const session = a.taskId ? `task-${a.taskId}` : a.chatId || a.replyIn ? `chat-${a.chatId || a.replyIn}` : a.goalId ? `goal-${a.goalId}` : '';
  const common = traceAttrs(`调度者 · ${ACT_LABEL[a.kind] || a.kind}`, session, [`kind:${a.kind}`], U(a)?.name);
  for (const s of o.spans) lfSpan({ ...s, attrs: { ...common, ...s.attrs } });
  lfSpan({ traceId: o.traceId, spanId: o.rootId, name: a.title, start: o.start, end: Date.now(), attrs: {
    ...common, 'langfuse.observation.type': 'agent',
    'langfuse.trace.input': o.input, 'langfuse.observation.input': o.input,
    'langfuse.trace.output': a.outcome, 'langfuse.observation.output': a.outcome,
    ...(a.status === 'failed' && { 'langfuse.observation.level': 'ERROR', 'langfuse.observation.status_message': a.outcome }),
    'langfuse.trace.metadata.activity_id': a.id, 'langfuse.trace.metadata.task_id': a.taskId,
    'langfuse.trace.metadata.goal_id': a.goalId, 'langfuse.trace.metadata.chat_id': a.chatId || a.replyIn,
  } });
}

// 一直没做完的事（中途抛错没走到 endActivity）：5 分钟后也把攒下的发出去，这种往往正是要查的
setInterval(() => {
  for (const o of lfOpen.values()) if (Date.now() - o.start > 300_000) lfEnd({ ...o.act, status: 'failed', outcome: '这件事一直没做完' });
}, 60_000).unref();

// 后台任务的一轮（App 这边看到的）：发给执行 agent 的说明、结局。执行 agent 内部的每一步在同一会话里 Hermes 那条 trace 上。
function lfRound(t, { prompt, round, runId, steps, r }) {
  if (!LF_AUTH) return;
  t.traced = true; // 开轨迹之前建的任务，改了一轮以后也有轨迹了
  const outcome = r.lost ? 'lost' : t.status === 'queued' ? 'revised' : t.status;
  const note = { lost: 'agent 重启过，这一轮没了，重新排队', revised: '中途的修改没赶上，接着改下一轮', stopped: '停了' }[outcome];
  const output = r.error || r.text || note || '';
  lfSpan({ traceId: hex(16), name: `${t.title} · 第 ${round} 轮`, start: Date.parse(t.startedAt) || Date.now(), end: Date.now(), attrs: {
    ...traceAttrs('后台任务 · App 侧', `task-${t.id}`, [`task:${t.kind}`, `outcome:${outcome}`], U(t)?.name),
    'langfuse.observation.type': 'agent',
    'langfuse.trace.input': prompt, 'langfuse.observation.input': prompt,
    'langfuse.trace.output': output, 'langfuse.observation.output': output,
    ...(outcome !== 'done' && { 'langfuse.observation.level': outcome === 'failed' ? 'ERROR' : 'WARNING', 'langfuse.observation.status_message': r.error || note }),
    'langfuse.trace.metadata.task_id': t.id, 'langfuse.trace.metadata.round': round, 'langfuse.trace.metadata.run_id': runId,
    'langfuse.trace.metadata.goal_id': t.goalId, 'langfuse.trace.metadata.steps': steps,
  } });
}

// App 里「轨迹」链接的前缀：要 Langfuse 项目 id，问一次（Langfuse 还没起来就过一分钟再问）
function traceBase() {
  if (!LF_AUTH) return null;
  if (!lfProject && Date.now() - lfProjectAskedAt > 60_000) {
    lfProjectAskedAt = Date.now();
    fetch(`${LF_URL}/api/public/projects`, { headers: { Authorization: LF_AUTH }, signal: AbortSignal.timeout(5_000) })
      .then((r) => r.json()).then((j) => { lfProject = j.data?.[0]?.id || null; }).catch(() => {});
  }
  // 本机自托管时 key 里写的是 127.0.0.1，浏览器登录态在 localhost 上
  return lfProject && `${LF_URL.replace('//127.0.0.1', '//localhost')}/project/${lfProject}`;
}

// ---------- 喵团动态（仿 Muse Activity）：主 agent（调度者）每做一件事记一条 ----------
// 回一条消息、转述一个任务结果、推一条目标新进展、建一个目标，都是一条动态：做到哪一步（step）、做完的结果（outcome）。
// App 顶栏状态显示正在做的那一步，点开是「喵团动态」面板。后台任务自己的步骤还在任务里。

// replyIn：做完会往哪个聊天发消息。App 在那个聊天里显示「…」（仿 Muse：执行过程聊天里只有省略号，步骤看顶栏）。
// input：这件事的完整输入（用户原话、任务结果），只进轨迹，不存。
function startActivity(u, { title, kind = 'message', chatId, replyIn, taskId, goalId, input }) {
  const a = { id: newId('a'), uid: u.id, kind, title: String(title || '').replace(/\s+/g, ' ').slice(0, 40), chatId, replyIn, taskId, goalId, status: 'running', step: '', steps: [], at: new Date().toISOString() };
  lfStart(a, input ?? title);
  u.state.activity.push(a);
  if (u.state.activity.length > 60) u.state.activity.splice(0, u.state.activity.length - 60);
  return a;
}

function pushActivity(a) {
  const u = U(a);
  save(u);
  broadcast(u, { type: 'activity', activity: a });
}

function activityStep(a, text) {
  if (a?.status !== 'running') return;
  a.step = String(text).slice(0, 40);
  a.steps.push({ at: new Date().toISOString(), text: a.step });
  lfEvent(a, a.step);
  pushActivity(a);
}

function endActivity(a, outcome, status = 'done') {
  if (a?.status !== 'running') return;
  Object.assign(a, { status, step: '', outcome: String(outcome || '').replace(/\s+/g, ' ').slice(0, 80), endedAt: new Date().toISOString() });
  lfEnd(a);
  pushActivity(a);
}

// 消息默认进当前聊天；任务结果带着 chatId 回到派它的那个聊天。那个聊天已经删了就不发（结果在「任务」里还能看）。
function addMessage(u, m) {
  const s = u.state;
  const msg = { id: newId('m'), at: new Date().toISOString(), chatId: s.currentChat, ...m };
  const chat = s.chats.find((c) => c.id === msg.chatId);
  if (!chat) return null;
  s.messages.push(msg);
  chat.updatedAt = msg.at;
  if (chat.title === NEW_CHAT_TITLE && msg.role === 'me' && msg.text) chat.title = msg.text.replace(/\s+/g, ' ').slice(0, 20);
  save(u);
  broadcast(u, { type: 'message', message: msg });
  return msg;
}

// ---------- 聊天：可以开新聊天、删旧聊天；后台任务、目标、记账、网站是所有聊天共用的 ----------
const WELCOME = '嗨～我是喵团，你的私人助理 🐱 查资料、找附近好去处、做网页、记账、帮你盯着关心的事，都可以交给我～';
const NEW_CHAT_TITLE = '新聊天';

function newChat(u) {
  const at = new Date().toISOString();
  const chat = { id: newId('c'), title: NEW_CHAT_TITLE, createdAt: at, updatedAt: at };
  u.state.chats.push(chat);
  u.state.currentChat = chat.id;
  addMessage(u, { role: 'bot', text: WELCOME });
  return chat;
}

// 聊天列表：最近用过的在前，带最后一条消息预览。q：搜标题和所有消息内容，预览换成命中的那句话。
function chatList(u, q = '') {
  const needle = String(q).trim().toLowerCase();
  const flat = (t) => String(t || '').replace(/\s+/g, ' ');
  return u.state.chats.map((c) => {
    const msgs = u.state.messages.filter((m) => m.chatId === c.id);
    const last = msgs.at(-1);
    let preview = flat(last?.text || (last?.photos?.length ? '[图片]' : '')).slice(0, 40);
    if (needle) {
      const hit = msgs.findLast((m) => flat(m.text).toLowerCase().includes(needle));
      if (!hit && !c.title.toLowerCase().includes(needle)) return null;
      if (hit) { const t = flat(hit.text); const i = t.toLowerCase().indexOf(needle); preview = `${i > 12 ? '…' : ''}${t.slice(Math.max(0, i - 12), i + needle.length + 28)}`; }
    }
    return { ...c, count: msgs.filter((m) => m.role === 'me').length, preview };
  }).filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ---------- LongCat（调度者用，直连，不带工具） ----------
// JS 的 .slice() 按 UTF-16 截字符串，可能把 emoji 切成半个（孤立代理项）。Hermes（Python）存库时会因此报错、把任务标成失败，
// 所以发给 Hermes / LongCat 的请求体统一清掉半个字符。
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const cleanStrings = (_, v) => (typeof v === 'string' ? v.replace(LONE_SURROGATE, '') : v);

// name：这次调用是干什么的（调度决策、转述……），轨迹里的 generation 名
async function longcat(system, user, maxTokens = 600, { json = false, name = 'LongCat' } = {}) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const start = Date.now();
  const trace = (attrs) => lfChild(traceCtx.getStore(), { name, start, end: Date.now(), attrs: {
    'langfuse.observation.type': 'generation', 'langfuse.observation.model.name': DISPATCH_MODEL,
    'langfuse.observation.model.parameters': { max_tokens: maxTokens, json }, 'langfuse.observation.input': messages, ...attrs,
  } });
  const call = () => fetch(LONGCAT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${LONGCAT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: DISPATCH_MODEL, max_tokens: maxTokens, thinking: { type: 'disabled' },
      ...(json && { response_format: { type: 'json_object' } }),
      messages,
    }, cleanStrings),
    signal: AbortSignal.timeout(60_000),
  });
  try {
    // 代理/网络偶尔抖一下会直接 "fetch failed"（连接没建立），隔一秒重试一次。
    const r = await call().catch(async (e) => {
      if (e.name === 'TimeoutError') throw e;
      console.error('[longcat] 重试：', e.message, e.cause?.code || '');
      await new Promise((ok) => setTimeout(ok, 1000));
      return call();
    });
    if (!r.ok) throw new Error(`LongCat ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const body = await r.json();
    const content = (body.choices?.[0]?.message?.content || '').trim();
    trace({
      'langfuse.observation.output': content,
      ...(body.usage && { 'langfuse.observation.usage_details': { input: body.usage.prompt_tokens, output: body.usage.completion_tokens } }),
      'langfuse.observation.metadata.finish_reason': body.choices?.[0]?.finish_reason,
    });
    return content;
  } catch (e) {
    trace({ 'langfuse.observation.level': 'ERROR', 'langfuse.observation.status_message': e.message });
    throw e;
  }
}

// 模型偶尔少写一个收尾的 } 或 ]：先按原样解析，不行就补齐没闭合的括号再试。都不行返回 null。
function parseJsonLoose(raw) {
  const text = String(raw || '');
  const start = text.indexOf('{');
  if (start < 0) return null;
  const body = text.slice(start, text.lastIndexOf('}') + 1) || text.slice(start);
  try { return JSON.parse(body); } catch {}
  const stack = [];
  let inStr = false;
  let esc = false;
  let end = start;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') stack.pop();
    if (!inStr && '}]"0123456789eln'.includes(c)) end = i; // 记住最后一个可能结束值的位置
  }
  try { return JSON.parse(text.slice(start, end + 1) + stack.reverse().join('')); } catch { return null; }
}

// 平台登录怎么跟用户说：管理员自己能在「社媒账号」里点登录；普通成员登录不了（沙箱浏览器大家共用，平台账号由管理员统一登录）
const LOGIN_TALK = {
  admin: {
    hint: '平台没登录时，就让用户去「+」→「社媒账号」登录。',
    rule: '- 平台登录：X / Instagram / Weverse / 小红书 要用户先在「+」→「社媒账号」点「登录」、在弹出的窗口里自己登录。用户要看这些平台的内容、而【平台登录】显示它未登录时，不派任务，reply 直接引导，比如「X 还没登录哦，去「+」→「社媒账号」点「登录 X」，在弹出的窗口里自己登一下（建议小号），好了再叫我～」。',
    say: '- 结果里说某个平台需要登录（或被风控）时，一定要说去「+」→「社媒账号」点「登录 X」（换成对应平台），这句不能省。',
  },
  member: {
    hint: '平台没登录时，就告诉用户这个平台要等管理员登录。',
    rule: '- 平台登录：X / Instagram / Weverse / 小红书 的账号由管理员统一登录，用户自己登录不了。用户要看这些平台的内容、而【平台登录】显示它未登录时，不派任务，reply 直接说明，比如「X 这边还没登录，得等管理员登一下，你可以跟管理员说一声～」。',
    say: '- 结果里说某个平台需要登录（或被风控）时，一定要说这个平台要等管理员登录一下，这句不能省。',
  },
};
const loginTalk = (u) => LOGIN_TALK[u?.role] || LOGIN_TALK.member;

const DISPATCHER_SYSTEM = (L) => `你是「喵团」的前台，用户的朋友，像朋友发微信一样聊天。
- 回复要短：通常 1 句，最多 2 句；口语化，可以带语气词或颜文字；不用列表、不用 markdown，不解释你怎么做。
- 先分清用户是在「问」还是在「让你做」：只是问你知不知道、是什么、怎么样、靠不靠谱、多少钱 → search（常识直接答）；让你去做（帮我找、去搜、看看某个账号、盯着、做网页、记账、调研）→ 派任务 / 目标 / 记账。【后台任务】里以前派过类似的任务，不代表这次也要派。
- 后台执行 agent 能做的事：上网搜索、读网页、深度调研写报告；做网页；读微博 / X / Instagram / Weverse / B 站 / 小红书上任何公开账号（品牌、机构、博主、个人公开主页都行，关不关注都能读）；按关键词搜小红书笔记（附近美食、店铺、景点、攻略、打卡地……问「附近」时结合【用户位置】）；搜图片；识别图片；查天气等实用信息（缺技能会自己装）；记账查账；记住用户偏好。不要对用户说「看不了这个账号」「搜不了附近」这类话；${L.hint}
- 普通搜索（search）：用户随口问一句、上网查一下就能答的（「你知道 X 吗」「X 是什么」「X 多少钱」「X 最近怎么样」「某家店 / 某个品牌 / 某个人是谁」），写 search，不派任务：query 填最可能搜到的搜索词（3–8 个词，带上关键限定，比如平台名、城市）。即使问的是小红书上的店或博主，只要是「你知道…吗」「…怎么样」这类了解性的问题，也先用普通搜索，不派任务；App 会马上搜网页再回答，搜不到会告诉用户还能去小红书上搜、深度搜索等。例：「你知道小红书上的蓝果中古首饰吗」→ search「蓝果中古首饰 小红书」，task 填 null。写 search 时 reply 填 null。
- 你自己不能搜图、不能看社媒账号、不能记东西、不能看图片内容。凡是需要这些的（查天气、找图、搜小红书笔记、找附近的吃喝玩乐、关注/取关或查看公开账号、记住偏好、识别用户发的图、查动态），派一个后台任务给执行 agent，reply 里只简短说你去办了，比如「好嘞，我去查查～」。用户明确说「去小红书上搜」「帮我在小红书上找」时派任务，不用 search。
- 做网页：执行 agent 能把内容做成一个网页（可视化网站、导游图、攻略页、对比表、清单、行程、H5 小页面），做好后聊天里会出现网站卡片，用户在 App 里点开就能看。用户要网站/网页/可视化时派任务，brief 写清楚内容、用途和想要的样子；内容还要查的，把要查什么也写进 brief，让执行 agent 查完再做。要改【网站】里已有的网站时，brief 里写上它的 id。
- 闲聊、情绪回应、问任务进度：直接回复，不派任务。问进度时根据【后台任务】回答。
- 不要凭记忆回答事实：问到具体的店、品牌、产品、博主、人物、事件、价格、地址、营业时间、新闻这类事，你的记忆很可能是错的或过时的，一律写 search 去查，不要在 reply 里直接回答，也不要说「知道呀」然后编内容；就算【最近聊天】里你以前这样回答过，也要重新 search，不要照搬。只有常识（比如「中古首饰是什么意思」）可以直接答。
- 同一件事已经有任务在跑或排队，就不要重复派。
- 改任务（steer）：用户是在对【后台任务】里某个排队中、进行中或刚结束的任务提修改（「不要…」「换成…」「再加上…」「这个不好」「改成…」「重做一下」「顺便也…」），写 steer，不要派新任务：task_id 填那个任务的 id，instruction 写清楚要怎么改（完整、脱离聊天也能看懂），只写用户这次说的修改，不要自己添加用户没提的要求（比如用户没说就别加「做成网站」）。进行中的会被插话调整，做完的会在原任务上接着改一轮。reply 简短说你让它改了，比如「收到，让它换成真地图，不用重来～」。分不清改的是哪个任务就先问一句，不写 steer。明显是另一件新事，或者是很久以前的老任务，才派新任务。目标检查（·目标检查）不能 steer。
- 停止（stop）：用户说「别弄了」「不用了」「先停一下」时，stop 填那个排队中或进行中任务的 id；reply 简短确认。
${L.rule}
- brief 写给执行 agent，要完整、能独立执行：做什么、涉及的人或事物（中文名/外文名）、时间范围、地点、用户偏好；找图时写上要避开已经展示过的图（给出 id）。
- 记账：用户说了一笔收支（如「午饭35」「打车 22 块」「发工资 8000」），直接写进 ledger，reply 简短确认（如「记好啦，午饭 ¥35」），不派任务。查账、分析消费、设预算这类派任务（执行 agent 有记账工具和记账记忆）。
- 位置：【用户位置】是用户在 App 里共享的大致位置。用户问「我在哪」「附近」「这边」时以它为准，派任务时把位置写进 brief；没共享时，简短提醒用户可以在「+」→「位置」里共享，不要猜他在哪。
- 深度搜索：用户要你全面查清楚、调研、对比、找资料或找途径（不是一两句就能答的事），task 里写 "research": true；brief 写清楚要回答的问题、范围和希望得到的结论。reply 说一句你去深挖一下。
- 版权：用户要免费下载或看付费内容（杂志、书、课程、影视的 PDF、网盘资源、破解版）时，照样派深度搜索，但 brief 写明「只找合法的免费或低价途径（图书馆数字资源、官方免费内容、正版优惠），不找盗版下载链接」；reply 里轻松说一句盗版链接不帮找，但会帮他找合法免费看的办法。
- 目标：用户想长期持续关注某件事（「帮我盯着…」「以后每天…」「有新的就告诉我」），建一个 goal，它会定期自动检查，有新进展时会主动告诉用户；reply 简短说你会一直盯着。schedule 用 {"every": 分钟数} 或 {"at": "HH:MM"}，没说频率就 {"every": 360}。【目标】里已有同类目标（没完成的）就不要重复建。
- 完成目标：用户说某个目标办完了、不用再盯 / 不用再提醒了（「那个不用盯了」「机票我买好了」「生日提醒取消吧」），goal_done 填【目标】里对应目标的 id 数组，reply 简短确认；分不清是哪个就先问一句，不写 goal_done。
只输出一个 JSON，没有的字段填 null：
{"reply": "...", "search": {"query": "..."}, "task": {"title": "不超过 12 个字", "brief": "...", "research": false}, "steer": {"task_id": "t_xxx", "instruction": "..."}, "stop": "t_xxx", "goal": {"title": "不超过 12 个字", "brief": "每次检查做什么、关注谁、什么算新进展", "schedule": {"every": 360}}, "goal_done": ["g_xxx"], "ledger": [{"type": "expense 或 income", "amount": 35, "category": "餐饮", "note": "午饭", "date": null}], "ledger_delete": ["l_xxx"]}
ledger 的 date 默认填 null（表示今天），只有用户明确说了别的日子（如「昨天」）才按【现在】换算成 YYYY-MM-DD。
ledger 只写【用户新消息】里新说的收支；【今日账目】里已有的、聊天记录里之前提过的都不要再写，否则会重复记账。
删账：用户明确要删某几笔（或对你「要删掉吗」回答肯定）时，在 ledger_delete 里填【今日账目】中对应的 id 数组；不确定是哪笔就先问。没有就填 null。
支出分类：餐饮、交通、购物、娱乐、旅行、居住、医疗、学习、人情、其他；收入分类：工资、副业、红包、其他。`;

const COMPLETION_SYSTEM = (L) => `你是「喵团」的前台，用户的私人助理。后台任务刚结束，像真人发微信一样把结果告诉用户。
- 直接给信息：结论、名字、数字、价格、时间、下一步。不说客套和过渡（「搞定啦」「帮你查好了」「希望对你有帮助」），不复述用户的问题，不说「点下面的卡片」「详情见报告」这类指引——图片、网站、研究报告会自动附在消息下面。
- 每条消息一句话，尽量 25 字以内，最长 40 字；口语化，不用 markdown、列表、序号，表情最多一个。
- 默认只发 1 条；一条说不下才拆成 2–3 条，每条只讲一件事，按重要性排。最多 3 条。
- 研究报告：只说最关键的结论（推荐哪个、答案是什么、最要注意的一点），细节都在报告里，不要逐条复述。
- 网站：一句说做好了，加一个亮点；不要说附件、文件、下载、代码、用浏览器打开。
${L.say}
- 失败：一句说没弄成和原因（说人话，不贴报错），一句下一步建议。
- 不要提 id、GALLERY、工具名、执行 agent。
只输出 JSON：{"messages": ["第一条", "第二条"]}`;

// 前台转述：1–3 条短消息（一条说不下才拆开）
async function sayResult(u, prompt, fallback) {
  try {
    const out = parseJsonLoose(await longcat(COMPLETION_SYSTEM(loginTalk(u)), prompt, 300, { json: true, name: '转述' }));
    const parts = (Array.isArray(out?.messages) ? out.messages : [out?.reply ?? out?.text])
      .map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 3);
    if (parts.length) return parts;
  } catch (e) { console.error('[say]', e.message); }
  return [fallback];
}

const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));
// 一条一条发，中间停一下像在打字。first / last：只挂在第一条 / 最后一条上的字段；all：每条都带。
async function sendParts(u, items, { first = {}, last = {}, all = {} } = {}) {
  for (const [i, it] of items.entries()) {
    if (i) await pause(it.text ? 500 + Math.min(1500, it.text.length * 45) : 400);
    addMessage(u, { role: 'bot', ...all, ...it, ...(i === 0 ? first : {}), ...(i === items.length - 1 ? last : {}) });
  }
}

const statusLabel = { queued: '排队中', running: '进行中', done: '已完成', failed: '失败', stopped: '已停止' };
const PLATFORM_LABEL = { weibo: '微博', x: 'X', instagram: 'Instagram', weverse: 'Weverse', bilibili: 'B 站', xiaohongshu: '小红书' };
const secsSince = (iso) => Math.round((Date.now() - Date.parse(iso)) / 1000);
const nowText = () => new Date().toLocaleString('zh-CN', { hour12: false, weekday: 'short' });

function dispatcherContext(u) {
  const state = u.state;
  let profile = '';
  try { profile = fs.readFileSync(path.join(u.home, 'memories/USER.md'), 'utf8').split(/\n?§\n?/).map((s) => s.trim()).filter(Boolean).join('；'); } catch {}
  const follows = readJson(path.join(u.home, 'official_accounts.json'), [])
    .map((a) => `${a.name}（${PLATFORM_LABEL[a.platform || 'weibo'] || a.platform}${a.idol ? `·${a.idol}` : ''}）`).join('、');
  const logins = (sandboxSessions?.platforms || []).filter((p) => p.canLogin)
    .map((p) => `${p.label}${p.loggedIn ? '已登录' : p.needsLogin ? '未登录' : '未登录（可免登录读）'}`).join('、');
  const tasks = state.tasks.slice(-8).map((t) => {
    const step = t.steps?.at(-1)?.label;
    const when = t.status === 'running' ? `（已 ${secsSince(t.startedAt)} 秒${step ? `，在${step}` : ''}）`
      : t.endedAt ? `（${agoText(Date.now() - Date.parse(t.endedAt))}结束）` : '';
    return `- ${t.id} [${statusLabel[t.status]}${t.kind === 'goal' ? '·目标检查' : ''}${t.round > 1 ? `·第 ${t.round} 轮` : ''}] ${t.title}${when}：${t.brief.replace(/\s+/g, ' ').slice(0, 60)}`;
  }).join('\n');
  // 前台凭记忆直接说的话（没经过搜索 / 后台任务）标出来：调度者别把自己以前编的「事实」当真、照搬
  const who = (m) => (m.role === 'me' ? '用户' : m.search || m.taskId || m.partOf || m.goalId || m.steerOf || m.stopOf ? '喵团' : '喵团（凭记忆，没查证）');
  const history = state.messages.filter((m) => m.chatId === state.currentChat).slice(-15, -1).map((m) => `${who(m)}：${m.text || ''}`
    + (m.images?.length ? '（发了图片）' : '') + (m.photos?.length ? `（附图 ${m.photos.length} 张，id：${m.photos.map((p) => p.id).join(',')}）` : '')
    + (m.goalId && m.taskId ? '（来自目标）' : '') + (m.report ? `（发了研究报告：${m.report.title}）` : '')).join('\n');
  const goals = state.goals.map((g) => `- ${g.id} ${g.title}（${g.done ? '已完成' : `${scheduleLabel(g.schedule)}${g.enabled ? '' : '，已暂停'}`}）：${g.status?.text || ''}`).join('\n');
  const s = ledgerSummary(u);
  const todayEntries = readLedger(u).filter((e) => e.date === today()).slice(-30)
    .map((e) => `\n- ${e.id}：${e.note || e.category} ${e.type === 'income' ? '+' : '-'}${money(e.amount)}（${e.category}）`).join('');
  return `【现在】${nowText()}\n【用户画像】${profile || '（还不知道）'}\n【用户位置】${locationLine(u) || '（没共享）'}\n【已关注账号】${follows || '（无）'}`
    + (logins ? `\n【平台登录】微博免登录；${logins}` : '') + `\n【目标】\n${goals || '（无）'}`
    + `\n【记账】本月支出 ${money(s.expense)}，收入 ${money(s.income)}，今天支出 ${money(s.todayExpense)}`
    + `\n【今日账目】${todayEntries || '（无）'}`
    + `\n【网站】${listSites(u).slice(0, 5).map((x) => `\n- ${x.id}：${x.title}（第 ${x.version} 版）`).join('') || '（无）'}`
    + `\n【后台任务】\n${tasks || '（无）'}\n【最近聊天】\n${history || '（无）'}`;
}

async function dispatch(u, text, imageCount) {
  const state = u.state;
  await sandbox('/sessions', 1_500).catch(() => {}); // 刷新【平台登录】；沙箱没开就沿用上次的
  const raw = await longcat(DISPATCHER_SYSTEM(loginTalk(u)),
    `${dispatcherContext(u)}\n\n【用户新消息】${text || '（只发了图）'}${imageCount ? `（附带 ${imageCount} 张图片）` : ''}\n\n只输出 JSON。`, 600, { json: true, name: '调度决策' });
  let out;
  // 解析不了时，至少把 reply 那句话抠出来，别把一串 JSON 发给用户。
  out = parseJsonLoose(raw) || { reply: /"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)?.[1] || '收到～', task: null };
  // steer / stop 只认【后台任务】里真有的任务；改任务时就不再派新任务。
  const steerOf = state.tasks.find((t) => t.id === out.steer?.task_id && t.kind !== 'goal');
  const steer = steerOf && String(out.steer.instruction || '').trim() ? { task: steerOf, instruction: String(out.steer.instruction).trim() } : null;
  const stop = state.tasks.find((t) => t.id === out.stop && ['running', 'queued'].includes(t.status)) || null;
  if (steer || stop) out.task = null;
  // 普通搜索：App 自己马上去搜（不派后台任务）；带图的、改任务 / 停任务时不搜
  let search = !imageCount && !steer && !stop && typeof out.search?.query === 'string' && out.search.query.trim() ? out.search.query.trim().slice(0, 80) : null;
  // 兜底：用户明显只是在「问」（你知道…吗、…是什么、…怎么样），没让动手、也不涉及附近 / 自己的东西，调度者却派了普通任务 → 改成普通搜索
  const asking = /(知道|了解|听说过|认识).{1,40}(吗|么|不)[？?。！!～~]*$|是什么|是谁|怎么样|靠谱吗|好不好|多少钱/.test(text || '');
  const doing = /帮我|给我|去|搜|找|查|看看|盯|做|整理|调研|深度|附近|周边|这边|我的|记/.test(String(text || '').replace(/(知道|了解|听说过|认识)/, ''));
  if (!search && asking && !doing && out.task?.brief && !out.task.research && !imageCount && !steer && !stop) {
    search = String(text).replace(/^(你|您)?(知道|了解|听说过|认识)/, '').replace(/[吗呢？?。！!～~\s]+$/, '').trim().slice(0, 80) || null;
  }
  if (search) out.task = null;
  if (imageCount && !out.task && !steer) {
    // 调度者看不到图，带图的消息一律交给执行 agent。
    out.task = { title: '看看你发的图', brief: `用户发来 ${imageCount} 张图片，并说：「${text || '（没说话）'}」。看懂图里是谁、什么场合，按用户意思处理（比如找同场更多图）。` };
  }
  const d = {
    reply: String(out.reply || '收到～'),
    search,
    task: out.task?.brief ? out.task : null,
    steer,
    stop,
    goal: out.goal?.brief ? out.goal : null,
    goalDone: (Array.isArray(out.goal_done) ? out.goal_done : []).map((id) => state.goals.find((g) => g.id === String(id) && !g.done)).filter(Boolean),
    ledger: Array.isArray(out.ledger) ? out.ledger : [],
    ledgerDelete: Array.isArray(out.ledger_delete) ? out.ledger_delete.map(String) : [],
  };
  // 轨迹：模型给的决定 → App 校验、兜底改写后真正执行的决定（两边不一样时就是要查的地方）
  lfEvent(traceCtx.getStore(), '调度结果', { 'langfuse.observation.input': out, 'langfuse.observation.output': {
    ...d, steer: steer && { task_id: steer.task.id, instruction: steer.instruction }, stop: stop?.id, goalDone: d.goalDone.map((g) => g.id),
  } });
  return d;
}

// ---------- 普通搜索：随口一问、上网查一下就能答的问题（仿 Claude 的网页搜索） ----------
// 搜一次 → 判断结果相不相关 → 不相关换个词再搜一次 → 回答；没查到就照实说，并给出还能怎么查的选项。
// 用沙箱浏览器里的必应（/web/search），和执行 agent 的 deep_web_search 是同一个；过程实时推到聊天里。
const SEARCH_JUDGE = `你在帮助理判断网页搜索结果能不能回答用户的问题。只输出 JSON：
{"relevant": true 或 false, "next": "结果不相关时，换一个更可能搜到的搜索词（换说法、去掉或加上限定词）；相关就填 null", "note": "不超过 12 个字，说结果怎么样，比如：结果不相关，换个词再搜"}`;
const SEARCH_ANSWER = `你是「喵团」的前台，用户的私人助理。你刚上网搜了一下，根据搜索结果回答用户，像真人发微信。
- 结果里有答案：直接说，带上关键事实（名字、数字、时间、地点），1–3 条短消息，每条一句话；sources 填你用到的结果编号。
- 结果里没有、或者都不相关：照实说没查到，一句话说可能的原因（比如小红书、抖音上的店铺和小账号基本不被搜索引擎收录，太新的事还没被收录）；需要的话顺口问一句下一步（比如「要不要我去小红书上搜搜？」「要我深挖一下吗？」），用户直接回一句就行，不要列选项。
- 不要编造搜索结果里没有的事实；不用 markdown、列表、序号；不要说「根据搜索结果」「我搜了一下」这类过程话。
只输出 JSON：{"messages": ["…"], "found": true 或 false, "sources": [1, 2]}`;

async function webSearchRows(q) {
  const r = await sandbox(`/web/search?q=${encodeURIComponent(q)}`, 45_000);
  if (r.status !== 200) throw new Error(r.body?.message || `搜索失败 ${r.status}`);
  return (r.body?.results || []).slice(0, 8).map((x) => ({ title: String(x.title || '').slice(0, 80), url: String(x.url || ''), snippet: String(x.snippet || '').slice(0, 160) }));
}
const rowsText = (rows) => rows.map((r) => `[${r.n}] ${r.title} | ${r.url}\n${r.snippet}`).join('\n') || '（没有结果）';

// 仿 Muse：聊天里不放搜索过程卡片和一键选项，搜的时候只有「…」，搜了什么在顶栏状态和「喵团动态」里看；搜完直接发回答。
async function quickSearch(u, chatId, question, query, act) {
  const queries = [];
  let rows = [];
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      activityStep(act, `上网搜「${query}」`);
      const got = (await webSearchRows(query)).map((r, i) => ({ ...r, n: rows.length + i + 1 }));
      rows = rows.concat(got);
      queries.push(query);
      if (attempt === 1) break;
      activityStep(act, '看搜索结果');
      const j = parseJsonLoose(await longcat(SEARCH_JUDGE, `用户的问题：${question}\n搜索词：${query}\n结果：\n${rowsText(got)}`, 160, { json: true, name: '判断搜索结果' })) || {};
      if (j.relevant !== false) break;
      if (!j.next || String(j.next).trim() === query) break;
      query = String(j.next).trim().slice(0, 80);
    }
  } catch (e) {
    activityStep(act, '搜索暂时用不了');
    console.error('[search]', e.message);
  }
  let out = {};
  activityStep(act, '组织回答');
  try {
    out = parseJsonLoose(await longcat(SEARCH_ANSWER, `现在是 ${nowText()}\n用户的问题：${question}\n搜索结果：\n${rowsText(rows)}`, 450, { json: true, name: '组织回答' })) || {};
  } catch (e) { console.error('[search]', e.message); }
  const parts = (Array.isArray(out.messages) ? out.messages : []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 3);
  if (!parts.length) parts.push(rows.length ? '搜了一下，没找到靠谱的答案。' : '搜索暂时用不了，等下再试试？');
  const used = new Set((Array.isArray(out.sources) ? out.sources : []).map(Number));
  const sources = rows.filter((r) => used.has(r.n)).map(({ title, url }) => ({ title, url }));
  // 说不完的拆成几条接着发；search 只是记下这是查过的（调度者别当成凭记忆说的），聊天里不显示
  activityStep(act, '发消息');
  const group = newId('s');
  await sendParts(u, parts.map((text, i) => ({ text, ...(i < parts.length - 1 && { partOf: group }) })),
    { all: { chatId, search: { queries, sources, found: !!out.found } } });
  endActivity(act, `${queries.length ? `搜了 ${queries.length} 次网页，` : ''}${out.found ? '回答：' : '没查到，'}${parts[0]}`);
}

// ---------- 执行 agent（Hermes）：每人一个，地址和 key 在这个人主目录的 .env 里 ----------
function agentFor(u) {
  const a = agentOf(u.home);
  if (!a) throw new Error('你的执行 agent 还没配好，找管理员看看（node scripts/user.mjs list）');
  return a;
}

function hermesFetch(u, pathname, body) {
  const a = agentFor(u);
  return fetch(a.url + pathname, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${a.key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body, cleanStrings) : undefined,
  });
}

// cattuan-bridge 插件推送时带的是它那个 agent 的 key：凭 key 认出是谁的 agent
function userByAgentKey(key) {
  for (const u of users.values()) if (key && agentOf(u.home)?.key === key) return u;
  return null;
}

// Hermes 的 function_call_output.output 是 [{type:'input_text', text:'<json>'}] 片段数组。
function photosFromToolOutput(output) {
  const raw = Array.isArray(output) ? output.map((p) => p?.text || '').join('') : String(output ?? '');
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.photos) ? parsed.photos : [];
  } catch { return []; }
}

// 把回复里的 `GALLERY: id1,id2` 换成图片列表，正文去掉这一行。
function resolveGallery(text, pool) {
  const m = /GALLERY:\s*([\w,\s，]+)/i.exec(text || '');
  const ids = m ? m[1].split(/[,，\s]+/).filter(Boolean) : [];
  const byId = new Map(pool.map((p) => [p.id, p]));
  let photos = [...new Set(ids)].map((id) => byId.get(id)).filter(Boolean);
  if (!photos.length && !m) photos = pool.slice(0, 6);
  return { text: (text || '').replace(/`?GALLERY:[^\n]*`?/i, '').trim(), photos };
}

// ---------- 工具调用明细：cattuan-bridge 插件推过来（/v1/runs 的事件流里只有工具名，没有参数和结果） ----------
const toolCalls = new Map(); // tool_call_id → { tool, args, result, at, waiters }

function toolCallEntry(id) {
  let c = toolCalls.get(id);
  if (!c) toolCalls.set(id, (c = { at: Date.now(), waiters: [] }));
  return c;
}

function onBridgeToolCall({ phase, tool_call_id: id, tool, args, result }) {
  if (!id) return;
  const c = toolCallEntry(id);
  c.tool = tool || c.tool;
  c.args = c.args || (args && typeof args === 'object' ? args : {});
  if (phase === 'end') c.result = String(result ?? '');
  c.waiters = c.waiters.filter((done) => !done());
}

// 事件流和插件推送谁先到不一定：等插件那边的 args / result 到了再处理，最多等 ms 毫秒。
function waitToolCall(id, field, ms) {
  const c = toolCallEntry(id);
  if (c[field] !== undefined) return Promise.resolve(c);
  return new Promise((resolve) => {
    const done = () => { if (c[field] === undefined) return false; clearTimeout(timer); resolve(c); return true; };
    const timer = setTimeout(() => { c.waiters = c.waiters.filter((w) => w !== done); resolve(c); }, ms);
    c.waiters.push(done);
  });
}
setInterval(() => { for (const [id, c] of toolCalls) if (Date.now() - c.at > 3600_000) toolCalls.delete(id); }, 600_000);

// ---------- 跑一轮：POST /v1/runs 开始，GET /v1/runs/{id}/events 收事件 ----------
// 用 runs 而不是 /v1/responses，是因为 runs 能中途插话（/steer）和停止（/stop）。同一个任务的每一轮都在
// 同一个 Hermes 会话（task-<任务 id>）里跑，后面的修改轮记得前面做过什么。
const RUN_END = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted']);

async function runRound(t, input) {
  const u = U(t);
  if (!t.runId) {
    const r = await hermesFetch(u, '/v1/runs', { model: 'hermes-agent', input, session_id: t.sessionId });
    if (!r.ok) throw new Error(`agent ${r.status}: ${(await r.text()).slice(0, 200)}`);
    updateTask(t, { runId: (await r.json()).run_id, lastSeq: -1 });
    if (t.stopRequested) stopRun(t); // 还没拿到 run id 时用户就点了停止
  }
  const a = agentFor(u);
  const res = await fetch(`${a.url}/v1/runs/${t.runId}/events`, {
    headers: { Authorization: `Bearer ${a.key}`, ...(t.lastSeq >= 0 && { 'Last-Event-ID': String(t.lastSeq) }) },
  });
  if (res.status === 404) return { lost: true }; // agent 重启过，这一轮没了
  if (!res.ok) throw new Error(`agent ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const pool = [];
  const sites = new Map(); // publish_site 发布的网站（同一个网站改了几版只留最后一版）
  const pending = []; // 等插件推送结果的工具调用
  let end = null;
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (!data) continue;
      const ev = JSON.parse(data);
      if (Number.isInteger(ev.seq)) { t.lastSeq = ev.seq; save(u); }
      if (ev.event === 'tool.started') onToolStarted(t, ev.tool_call_id, ev.tool);
      else if (ev.event === 'tool.completed') pending.push(onToolCompleted(t, ev.tool_call_id, pool, sites));
      else if (RUN_END.has(ev.event)) end = ev;
    }
    if (end) break;
  }
  await Promise.all(pending);
  if (!end) throw new Error('和执行 agent 的连接断了');
  if (end.event === 'run.failed') throw new Error(end.error || '执行 agent 运行失败');
  if (end.event !== 'run.completed') return { stopped: true };
  return { ...resolveGallery(end.output || '', pool), sites: [...sites.values()], pendingSteer: end.pending_steer || '' };
}

function onToolStarted(t, id, name) {
  const label = STEP_LABEL[name] || name;
  const last = t.steps.at(-1);
  const step = { id, name, label, status: 'running' };
  if (last?.label === label) Object.assign(last, step); else t.steps.push(step); // 连续同类步骤合并显示
  updateTask(t, {});
  waitToolCall(id, 'args', 2000).then((c) => {
    // 延迟加载的工具经 tool_call 转发时，按里面真正的工具名显示和记录
    const call = realCall({ name, arguments: JSON.stringify(c.args || {}), call_id: id });
    const s = t.steps.find((x) => x.id === id);
    if (s && call.name !== name) { Object.assign(s, { name: call.name, label: STEP_LABEL[call.name] || call.name }); }
    trackResearch(t, call);
    updateTask(t, {});
  });
}

async function onToolCompleted(t, id, pool, sites) {
  const c = await waitToolCall(id, 'result', 5000);
  if (c.result !== undefined) {
    pool.push(...photosFromToolOutput(c.result));
    const site = siteFromToolOutput(U(t), c.result);
    if (site) { sites.set(site.id, site); broadcast(U(t), { type: 'site', site }); }
    trackResearchResult(t, { call_id: id, output: c.result });
  }
  const s = t.steps.find((x) => x.id === id);
  if (s) s.status = 'done';
  updateTask(t, {});
}

function stopRun(t) {
  return Promise.resolve().then(() => hermesFetch(U(t), `/v1/runs/${t.runId}/stop`, {})).catch((e) => console.error('[stop]', e.message));
}


function updateTask(t, patch) {
  Object.assign(t, patch);
  const u = U(t);
  save(u);
  broadcast(u, { type: 'task', task: t });
}

function createTask(u, { title, brief, kind = 'chat', images = [], goalId, chatId }) {
  const t = { id: newId('t'), uid: u.id, title: String(title).slice(0, 20), brief, kind, goalId, chatId, images, status: 'queued', steps: [], createdAt: new Date().toISOString(),
    ...(LF_AUTH && { traced: true }) }; // 开了轨迹以后建的任务，App 里才显示「轨迹」链接
  u.state.tasks.push(t);
  if (kind !== 'goal') accounts.bumpUsage(u.id, 'tasks'); // 目标检查另算（runGoal 里）
  save(u);
  broadcast(u, { type: 'task', task: t });
  setImmediate(pump);
  return t;
}

// 排队的任务按先来后到跑：全局最多 MAX_RUNNING 个，每人最多 MAX_RUNNING_PER_USER 个（一个人派一堆任务不会把别人堵住）
function pump() {
  const all = [...users.values()].filter(active).flatMap((u) => u.state.tasks);
  let running = all.filter((t) => t.status === 'running').length;
  const queued = all.filter((t) => t.status === 'queued').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  for (const t of queued) {
    if (running >= MAX_RUNNING) break;
    if (U(t).state.tasks.filter((x) => x.status === 'running').length >= MAX_RUNNING_PER_USER) continue;
    running++;
    runTask(t);
  }
}

// 普通成员的每日额度（管理员不限）：超了返回一句给用户看的话
function overQuota(u, kind) {
  if (u.role === 'admin') return '';
  const n = accounts.usage(u.id, kind);
  const limit = QUOTA[kind];
  const what = { messages: '条消息', tasks: '个后台任务', goalChecks: '次目标检查' }[kind];
  return n >= limit ? `今天的额度用完啦（每天 ${limit} ${what}），明天再来～` : '';
}

// ---------- 深度搜索：记录搜了什么、读了哪些网页，任务卡片里显示「搜索过程」 ----------
function parseArgs(raw) { try { return JSON.parse(raw || '{}'); } catch { return {}; } }
function toolOutputJson(output) {
  const raw = Array.isArray(output) ? output.map((p) => p?.text || '').join('') : String(output ?? '');
  try { return JSON.parse(raw); } catch { return {}; }
}

// 延迟加载的工具会经 tool_call 转发调用：按里面真正的工具名显示步骤、记录搜索过程。
function realCall(item) {
  if (item.name !== 'tool_call') return item;
  const args = parseArgs(item.arguments);
  const inner = Array.isArray(args.calls) ? args.calls[0] : args;
  if (!inner?.name) return item;
  return { ...item, name: inner.name, arguments: typeof inner.arguments === 'string' ? inner.arguments : JSON.stringify(inner.arguments || {}) };
}

function trackResearch(t, item) {
  const args = parseArgs(item.arguments);
  if (item.name !== 'deep_web_search' && item.name !== 'read_webpage') return;
  t.research ||= { searches: [], reads: [] };
  if (item.name === 'deep_web_search') t.research.searches.push({ id: item.call_id, q: String(args.query || '').slice(0, 80), at: new Date().toISOString() });
  else t.research.reads.push({ id: item.call_id, url: String(args.url || '').slice(0, 300), at: new Date().toISOString() });
}

function trackResearchResult(t, item) {
  const r = t.research;
  if (!r) return;
  const out = toolOutputJson(item.output);
  const s = r.searches.find((x) => x.id === item.call_id);
  if (s) s.n = out.results?.length ?? 0;
  const p = r.reads.find((x) => x.id === item.call_id);
  if (p) Object.assign(p, { title: String(out.title || '').slice(0, 80), ok: !out.error && !out.note && !!out.text, note: out.error || out.note || '' });
}

// 报告：正文 + 末尾的「SOURCES:」列表 → { body, sources: [{ n, title, url }] }
function parseReport(text) {
  const raw = String(text || '');
  const i = raw.search(/^\s*SOURCES[:：]\s*$/m);
  let body = (i >= 0 ? raw.slice(0, i) : raw).replace(/`?GALLERY:[^\n]*`?/i, '');
  // 去掉报告前面 agent 边做边说的过程话：优先从「REPORT:」那一行之后开始；没有就取最后一条「---」分隔线之后。
  const marker = body.search(/^\s*REPORT[:：]\s*$/m);
  if (marker >= 0) body = body.slice(marker).replace(/^\s*REPORT[:：]\s*/, '');
  else {
    const parts = body.split(/^\s*-{3,}\s*$/m);
    if (parts.length > 1 && parts.at(-1).trim().length > 200) body = parts.at(-1);
  }
  body = body.trim();
  const sources = i < 0 ? [] : raw.slice(i).split('\n').slice(1).map((line) => {
    const m = /^\s*\[(\d+)\]\s*(.*?)\s*\|\s*(https?:\/\/\S+)/.exec(line);
    return m && { n: Number(m[1]), title: m[2].slice(0, 120), url: m[3] };
  }).filter(Boolean);
  return { body, sources };
}

// ---------- 网站：执行 agent 做的网页（publish_site），App 内置浏览器里看 ----------
// 每个人的网站在自己主目录的 sites/<id>/；网站服务按 id 找（id 是随机的，大家的不会撞），知道链接的人都能看。
const SITE_ID = /^s_[0-9a-f]{8}$/;
const sitesDir = (u) => path.join(u.home, 'sites');

function readSite(u, id) {
  if (!SITE_ID.test(id || '')) return null;
  const meta = readJson(path.join(sitesDir(u), id, 'meta.json'), null);
  return meta && { id, title: meta.title || '未命名网站', description: meta.description || '', version: meta.version || 1, createdAt: meta.createdAt, updatedAt: meta.updatedAt || meta.createdAt };
}

function listSites(u) {
  let ids = [];
  try { ids = fs.readdirSync(sitesDir(u)); } catch {}
  return ids.map((id) => readSite(u, id)).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

// 网站服务用：这个 id 的网站在谁的目录里（停用账号的网站不再提供）
function findSiteDir(id) {
  if (!SITE_ID.test(id || '')) return null;
  for (const u of users.values()) {
    if (active(u) && fs.existsSync(path.join(sitesDir(u), id, 'meta.json'))) return path.join(sitesDir(u), id);
  }
  return null;
}

function siteFromToolOutput(u, output) {
  const site = toolOutputJson(output)?.site;
  if (site?.id) return readSite(u, site.id);
  // 经 tool_call 批量转发时结果可能包了一层：在原文里找 "site": {"id": "s_…"}
  const raw = Array.isArray(output) ? output.map((p) => p?.text || '').join('') : String(output ?? '');
  const id = /"site"\s*:\s*\{\s*"id"\s*:\s*"(s_[0-9a-f]{8})"/.exec(raw)?.[1];
  return id ? readSite(u, id) : null;
}

// 和 site-builder 插件写的格式一样：index.html + meta.json。
function saveSite(u, { title, html, description = '' }) {
  const id = `s_${crypto.randomBytes(4).toString('hex')}`;
  const dir = path.join(sitesDir(u), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  const at = isoNow();
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, title, description, version: 1, createdAt: at, updatedAt: at }, null, 2));
  const site = readSite(u, id);
  broadcast(u, { type: 'site', site });
  return site;
}

// agent 偶尔不调 publish_site，直接把整页 HTML 贴在回复里：替它发布，正文里的代码块换成一句话。
function rescueHtmlSite(u, result, fallbackTitle) {
  if (result.sites?.length) return result;
  const m = /```html\s*\n([\s\S]*?<\/html>)\s*```/i.exec(result.text || '');
  if (!m) return result;
  const title = (/<title>([^<]{1,60})<\/title>/i.exec(m[1])?.[1] || fallbackTitle).trim();
  const site = saveSite(u, { title, html: m[1] });
  const text = `${result.text.slice(0, m.index)}（网页已发布：${site.title}）${result.text.slice(m.index + m[0].length)}`.trim();
  return { ...result, text, sites: [site] };
}

const outputRule = (t) => (t.kind === 'research'
  ? '最后按 deep-research 的报告格式输出：先单独一行写 REPORT:，下面是完整报告，末尾必须有 SOURCES: 列表。'
  : '做完后输出：结果要点（不超过 300 字，重要事实写清楚）；如有图片，最后单独一行 GALLERY: id1,id2,...');

function firstPrompt(t) {
  const u = U(t);
  const where = locationLine(u);
  return `【后台任务：${t.title}】（现在是 ${nowText()}，任务编号：${t.id}）\n${t.brief}`
    // /v1/runs 不收图片：给本地路径，让 agent 自己用 vision_analyze 看
    + (t.images.length ? `\n\n用户发来的图片（本地文件，用 vision_analyze 看，image_url 填路径）：\n${t.images.map((img) => path.join(u.dir, 'uploads', path.basename(img))).join('\n')}` : '')
    + (where ? `\n（用户当前位置：${where}。用户说「附近」「这边」「本地」时以此为准；和位置无关的任务忽略这一行。）` : '')
    + (t.kind === 'research'
      ? `\n\n这是深度搜索任务：先 skill_view deep-research，按里面的步骤做（deep_web_search 多角度搜、read_webpage 读原文、交叉核对），${outputRule(t)}`
      : `\n\n你在后台执行，结果会由前台转述给用户。${outputRule(t)}`);
}

// 修改轮：在同一个 Hermes 会话里接着跑。会话里本来就有前面的过程，这里再附上上一轮结果，万一会话丢了也能接上。
function revisionPrompt(t) {
  const prev = t.result?.text ? `\n\n上一轮的结果（节选）：\n${t.result.text.slice(0, 1500)}` : '';
  return `【后台任务：${t.title} · 第 ${t.round} 轮修改】（现在是 ${nowText()}，任务编号：${t.id}）\n原来的任务：${t.brief}${prev}`
    + `\n\n用户对结果提出了修改：\n${(t.asks || []).map((a) => `- ${a}`).join('\n')}`
    + `\n\n在前面工作的基础上改：已经查到的信息、读过的网页不用重查，只补做或重做需要改的部分；之前发布过网站就用同一个 site_id 更新。${outputRule(t)}`;
}

// 用户的修改记录：state 是这条要求的去向
//   merged 并进了还没开始的任务说明 · sent 已发给正在跑的这一轮 · delivered 这一轮已按它调整
//   pending 没赶上这一轮，等跑完接着改 · round 开了新一轮来改 · dropped 任务停了，没用上
function setRevisions(t, from, patch) {
  for (const v of t.revisions || []) if (from.includes(v.state)) Object.assign(v, patch);
}

// 每一轮的结局：done 完成 · failed 失败 · stopped 停了 · revised 插话没赶上、接着改下一轮
function endRound(t, status) {
  t.history = [...(t.history || []), { round: t.round || 1, status, startedAt: t.startedAt, endedAt: isoNow() }];
}
const roundSecs = (t) => (t.startedAt && t.endedAt ? Math.max(0, Math.round((Date.parse(t.endedAt) - Date.parse(t.startedAt)) / 1000)) : null);

async function runTask(t) {
  const reattach = t.status === 'running' && t.runId; // App 重启时 Hermes 那边还在跑：接回这一轮
  if (!reattach) {
    t.sessionId ||= `task-${t.id}`;
    t.round ||= 1;
    updateTask(t, { status: 'running', startedAt: isoNow(), runId: undefined, lastSeq: -1, stopRequested: false });
  }
  let r;
  // 接回的这一轮：说明是按当前状态重新拼的，和当初发出去的可能略有出入
  const prompt = t.round > 1 ? revisionPrompt(t) : firstPrompt(t);
  const round = t.round || 1;
  try {
    r = await runRound(t, prompt);
  } catch (e) {
    r = { error: e.message };
  }
  const runId = t.runId;
  const steps = t.steps.map((s) => s.name).join(' → '); // 下面重新排队时会清空
  t.steps.forEach((s) => { s.status = 'done'; });
  if (r.lost) { // agent 重启过，这一轮没了：重新排队
    updateTask(t, { status: 'queued', runId: undefined, steps: [] });
  } else if (r.stopped || t.stopRequested) {
    endRound(t, 'stopped');
    setRevisions(t, ['sent', 'pending'], { state: 'dropped' });
    updateTask(t, { status: 'stopped', endedAt: isoNow(), runId: undefined });
  } else if (r.error) {
    endRound(t, 'failed');
    updateTask(t, { status: 'failed', endedAt: isoNow(), runId: undefined, error: r.error.slice(0, 300) });
    deliver(t).catch((e) => console.error('[deliver]', e.message));
  } else {
    const result = rescueHtmlSite(U(t), r, t.title);
    // 插话被接收了、但这一轮在送到之前就结束了（pending_steer），或者压根没赶上：不发结果，直接接着改一轮。
    if (!r.pendingSteer) setRevisions(t, ['sent'], { state: 'delivered' });
    const late = (t.revisions || []).filter((v) => v.state === 'pending' || (v.state === 'sent' && r.pendingSteer));
    if (late.length) {
      endRound(t, 'revised');
      const round = t.round + 1;
      late.forEach((v) => Object.assign(v, { state: 'round', round }));
      updateTask(t, { status: 'queued', runId: undefined, result, round, asks: late.map((v) => v.text), steps: [] });
    } else {
      endRound(t, 'done');
      if (t.kind !== 'goal') U(t).state.stats.tasksDone++;
      updateTask(t, { status: 'done', endedAt: isoNow(), runId: undefined, result, asks: undefined });
      deliver(t).catch((e) => console.error('[deliver]', e.message));
    }
  }
  lfRound(t, { prompt, round, runId, steps, r });
  pump();
}

// 用户要改一个任务（调度者的 steer，或接口）：按任务所处阶段处理，不另开新任务。
async function steerTask(t, text) {
  text = String(text || '').trim().slice(0, 500);
  if (!t || !text || t.kind === 'goal') return null;
  const rev = { id: newId('r'), at: isoNow(), text, round: t.round || 1 };
  t.revisions = [...(t.revisions || []), rev];
  if (t.status === 'queued' && (t.round || 1) === 1) {
    rev.state = 'merged';
    t.brief += `\n\n【用户补充】${text}`;
  } else if (t.status === 'queued') {
    rev.state = 'round';
    t.asks = [...(t.asks || []), text];
  } else if (t.status === 'running') {
    rev.state = 'pending';
    if (t.runId) {
      const r = await Promise.resolve().then(() => hermesFetch(U(t), `/v1/runs/${t.runId}/steer`, {
        input: `用户中途补充了要求：${text}\n在已经做的基础上按这个调整，不用从头再来。`,
      })).catch(() => null);
      if (r?.ok) rev.state = 'sent';
    }
  } else { // 已完成 / 失败 / 已停止：同一个会话里接着改一轮
    const round = (t.round || 1) + 1;
    Object.assign(rev, { state: 'round', round });
    Object.assign(t, { status: 'queued', round, asks: [text], steps: [], error: undefined, endedAt: undefined });
  }
  updateTask(t, {});
  setImmediate(pump);
  return rev;
}

function stopTask(t) {
  if (!t || !['running', 'queued'].includes(t.status)) return null;
  if (t.status === 'queued') {
    endRound(t, 'stopped');
    setRevisions(t, ['merged', 'round', 'pending'], { state: 'dropped' });
    updateTask(t, { status: 'stopped', endedAt: isoNow() });
  } else {
    updateTask(t, { stopRequested: true });
    if (t.runId) stopRun(t);
  }
  return t;
}

// 任务结束 → 调度者把结果转成聊天消息。
async function deliver(t) {
  if (t.kind === 'goal') return deliverGoal(t);
  const u = U(t);
  const act = startActivity(u, { title: `转述「${t.title}」的结果`, kind: 'deliver', chatId: t.chatId, replyIn: t.chatId || u.state.currentChat, taskId: t.id,
    input: t.status === 'done' ? t.result?.text : `失败：${t.error}` });
  try {
    await traceCtx.run(act, () => deliverTask(t, act));
  } catch (e) {
    endActivity(act, `没转述成：${e.message}`, 'failed');
    throw e;
  }
}

async function deliverTask(t, act) {
  const u = U(t);
  activityStep(act, t.status === 'done' ? '写消息' : '告诉你没弄成');
  const photos = t.result?.photos || [];
  const sites = t.result?.sites || [];
  const report = t.kind === 'research' && t.status === 'done' ? parseReport(t.result.text) : null;
  const body = report?.body || t.result?.text || '（无文字）';
  // 中途插话或做完后改过要求：告诉转述的模型以修改后的为准（任务标题还是最初那个）
  const asks = (t.revisions || []).filter((v) => v.round === (t.round || 1) && ['delivered', 'round'].includes(v.state)).map((v) => v.text);
  const redo = asks.length ? `（用户${t.round > 1 ? `看了结果后要求修改，这是第 ${t.round} 轮` : '中途改了要求'}：${asks.join('；')}。以修改后的要求为准，标题里的旧说法不算）` : '';
  const parts = await sayResult(u, t.status === 'done'
    ? `现在是 ${nowText()}\n任务：${t.title}${redo}\n${report?.body ? '研究报告（会单独附上）' : '结果'}：${body.slice(0, 2000)}\n附图：${photos.length} 张`
      + (sites.length ? `\n网站：${sites.map((s) => `「${s.title}」`).join('、')}（已发布，会附上网站卡片）` : '')
    : `任务：${t.title}\n失败了，原因：${t.error}`,
  t.status === 'done' ? (body.split('\n').find((l) => l.trim()) || '弄好了').slice(0, 60) : '这次没弄成，等下再试试？');
  // 研究报告单独一条（只有报告卡片）；没有报告时，图和网站挂在最后一条文字上。任务来源、用时挂在最后一条。
  const attach = { ...(photos.length && { photos }), ...(sites.length && { sites }) };
  const items = parts.map((text) => ({ text }));
  if (report?.body) { items.push({ text: '', report: { title: t.title, ...report }, ...attach }); u.state.stats.reports++; }
  else Object.assign(items.at(-1), attach);
  activityStep(act, '发消息');
  await sendParts(u, items, {
    all: { partOf: t.id, ...(t.chatId && { chatId: t.chatId }) },
    last: { taskId: t.id, round: t.round || 1, took: roundSecs(t) },
  });
  const extra = [report?.body && '研究报告', photos.length && `${photos.length} 张图`, sites.length && `网站「${sites[0].title}」`].filter(Boolean);
  endActivity(act, `${t.status === 'done' ? '' : '没弄成：'}${parts[0]}${extra.length ? `（附${extra.join('、')}）` : ''}`);
}

// ---------- 目标（仿 Muse Goal）：定期检查，有新进展才在聊天里说 ----------
const isoNow = () => new Date().toISOString();
const scheduleLabel = (s) => (s?.at ? `每天 ${s.at}` : s?.every >= 60 ? `每 ${+(s.every / 60).toFixed(1)} 小时` : `每 ${s?.every} 分钟`);

// minEvery：最短几分钟查一次（管理员 15，普通成员按 QUOTA_GOAL_MIN_EVERY）；比它还勤的按它算
function normalizeSchedule(s, minEvery = 15) {
  if (typeof s?.at === 'string' && /^\d{1,2}:\d{2}$/.test(s.at)) return { at: s.at.padStart(5, '0') };
  const every = Number(s?.every ?? s?.every_minutes);
  return { every: Number.isFinite(every) && every > 0 ? Math.max(minEvery, Math.round(every)) : 360 };
}

function nextRun(schedule, from = Date.now()) {
  if (schedule.at) {
    const [h, m] = schedule.at.split(':').map(Number);
    const d = new Date(from);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= from) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  return new Date(from + schedule.every * 60_000).toISOString();
}

function saveGoal(g) {
  const u = U(g);
  save(u);
  broadcast(u, { type: 'goal', goal: g });
}

// 目标的动态（仿 Muse 目标详情里的 Activity）：建好、每次检查的结论、暂停 / 继续、完成。目标详情里按时间倒序显示。
function goalLog(g, text) {
  g.log = [...(g.log || []), { at: isoNow(), text: String(text).replace(/\s+/g, ' ').slice(0, 90) }].slice(-30);
}

// 完成（仿 Muse 目标的勾选框）：不再检查，挪到「已完成」；取消完成就接着按原来的频率盯。
function setGoalDone(g, done, why = '') {
  if (!!g.done === done) return;
  g.done = done;
  g.enabled = !done;
  if (done) g.doneAt = isoNow();
  else { delete g.doneAt; g.nextRunAt = nextRun(g.schedule); }
  goalLog(g, done ? `完成${why ? `：${why}` : ''}` : '重新开始盯着');
  saveGoal(g);
}

const GOAL_SOURCE = { chat: '在聊天里建的', page: '在目标页建的', ai: '喵团自己建的' };

function createGoal(u, { title, brief, schedule, kind = 'general', createdBy = 'user', source = 'chat', runNow = true }) {
  const sched = normalizeSchedule(schedule, u.role === 'admin' ? 15 : QUOTA.goalMinEvery);
  const g = {
    id: newId('g'), uid: u.id, title: String(title).slice(0, 20), brief, kind, createdBy, schedule: sched, enabled: true,
    createdAt: isoNow(), status: { text: runNow ? '马上开始第一次检查' : `等待第一次检查（${scheduleLabel(sched)}）`, at: isoNow() },
    seen: [], nextRunAt: runNow ? isoNow() : nextRun(sched),
  };
  goalLog(g, `建好目标 · ${scheduleLabel(sched)} · ${GOAL_SOURCE[source] || ''}`);
  u.state.goals.push(g);
  saveGoal(g);
  if (runNow) runGoal(g);
  return g;
}

// 普通成员最多几个进行中的目标（AI 自己维护的「记账管家」不算）：超了返回一句给用户看的话
function goalLimit(u) {
  if (u.role === 'admin') return '';
  const n = u.state.goals.filter((g) => !g.done && g.kind !== 'ledger').length;
  return n >= QUOTA.goals ? `最多同时盯 ${QUOTA.goals} 个目标哦，先完成或删掉一个再加～` : '';
}

function goalBrief(g) {
  const last = g.status?.at ? new Date(g.status.at).toLocaleString('zh-CN', { hour12: false }) : '无';
  return `这是持续目标「${g.title}」的例行检查。
目标说明：${g.brief}
上次状态（${last}）：${g.lastRunAt ? g.status?.text : '（首次检查）'}
之前已经发给用户的图片 id（不要再选）：${g.seen.slice(-200).join(',') || '（无）'}

按目标说明检查有没有新进展，然后严格按这个格式输出：
第一行：STATUS: 一句话（不超过 30 字）写目标当前的最新状态
第二行：NEW: yes 或 no（有没有值得主动告诉用户的新信息；和上次状态比没有变化就是 no）
第三行：DONE: yes 或 no（目标说明里的事已经彻底办完、以后不用再检查时才 yes，比如一次性的提醒这次已经发出、要等的事已经发生；每天的天气、每年的生日这类周期性目标永远是 no）
如果 NEW: yes，接着写要点（不超过 200 字）；有图片就在最后单独一行写 GALLERY: id1,id2,...`;
}

function runGoal(g) {
  const u = U(g);
  if (g.done || !active(u)) return null;
  if (u.state.tasks.some((t) => t.goalId === g.id && (t.status === 'queued' || t.status === 'running'))) return null;
  g.nextRunAt = nextRun(g.schedule);
  const over = overQuota(u, 'goalChecks');
  if (over) { // 今天的检查次数用完了：这次跳过，到点再查
    g.status = { ...g.status, text: '今天的检查次数用完了，明天接着盯', at: isoNow() };
    saveGoal(g);
    return null;
  }
  accounts.bumpUsage(u.id, 'goalChecks');
  const task = createTask(u, { title: `目标：${g.title}`, brief: goalBrief(g), kind: 'goal', goalId: g.id });
  g.lastRunAt = isoNow();
  g.status = { ...g.status, checking: true };
  saveGoal(g);
  return task;
}

// 每 30 秒：同步一下账号（新邀请的、被停用的），再看谁的目标到点了
setInterval(() => {
  refreshUsers();
  for (const u of users.values()) {
    if (active(u)) for (const g of u.state.goals) if (g.enabled && Date.parse(g.nextRunAt) <= Date.now()) runGoal(g);
  }
}, 30_000);

// 账号库是 App 和 scripts/user.mjs 共用的：停用的人马上断开他开着的页面；新建的人载进来（他的目标、任务才会跑）
function refreshUsers() {
  const rows = new Map(accounts.listUsers().map((r) => [r.id, r]));
  for (const u of users.values()) {
    if ((rows.get(u.id)?.status || 'disabled') !== 'disabled') continue;
    u.status = 'disabled';
    for (const res of u.clients) res.end();
    u.clients.clear();
  }
  for (const row of rows.values()) if (row.status !== 'disabled') loadUser(row);
}

async function deliverGoal(t) {
  const u = U(t);
  const state = u.state;
  const g = state.goals.find((x) => x.id === t.goalId);
  if (!g) return;
  if (t.status !== 'done') {
    g.status = { text: `这次检查没成功：${String(t.error || '').slice(0, 30)}`, at: isoNow(), error: true };
    goalLog(g, g.status.text);
    return saveGoal(g);
  }
  const raw = t.result.text || '';
  const status = /STATUS[:：]\s*(.+)/i.exec(raw)?.[1]?.trim();
  const isNew = /NEW[:：]\s*(yes|是|true)/i.test(raw);
  const isDone = /DONE[:：]\s*(yes|是|true)/i.test(raw) && g.kind !== 'ledger';
  const body = raw.replace(/^.*STATUS[:：].*$/im, '').replace(/^.*NEW[:：].*$/im, '').replace(/^.*DONE[:：].*$/im, '').trim();
  g.status = { text: (status || body.split('\n')[0] || '已检查，暂无变化').slice(0, 60), at: isoNow() };
  goalLog(g, `检查：${g.status.text}${isNew ? '（有新进展，告诉你了）' : ''}`);
  saveGoal(g);
  if (isDone) setGoalDone(g, true, '目标达成，不用再盯了');
  if (!isNew) return; // 执行 agent 判断没有新进展：只更新状态小字，不打扰用户
  const photos = (t.result.photos || []).filter((p) => !g.seen.includes(p.id));
  g.seen = [...g.seen, ...photos.map((p) => p.id)].slice(-500);
  saveGoal(g);
  const act = startActivity(u, { title: `目标「${g.title}」有新进展`, kind: 'goal', replyIn: state.currentChat, goalId: g.id, taskId: t.id, input: raw });
  activityStep(act, '写消息');
  const parts = await traceCtx.run(act, () => sayResult(u, `现在是 ${nowText()}\n这是用户设的持续目标「${g.title}」检查到的新进展，请主动告诉用户（像朋友突然发来消息）。\n最新状态：${g.status.text}\n要点：${body.slice(0, 1500) || '（无）'}\n附图：${photos.length} 张`, g.status.text));
  activityStep(act, '发消息');
  await sendParts(u, parts.map((text) => ({ text })), { first: { taskId: t.id, goalId: g.id }, last: { ...(photos.length && { photos }) } });
  endActivity(act, `主动告诉你：${parts[0]}`);
}


// ---------- 记账：与执行 agent 的 ledger 插件共用这个人主目录下的 ledger/ ----------
const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD（本地时区）
const money = (n) => `¥${(Math.round(n * 100) / 100).toLocaleString('zh-CN')}`;
const ledgerFile = (u) => path.join(u.home, 'ledger', 'entries.json');
const readLedger = (u) => readJson(ledgerFile(u), []);

function writeLedger(u, entries) {
  const file = ledgerFile(u);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, file);
}

// 只接受最近 60 天内、不晚于今天的日期，防止模型编日期。
function saneDate(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return today();
  const days = (Date.parse(today()) - Date.parse(d)) / 86_400_000;
  return days >= 0 && days <= 60 ? d : today();
}

function addLedgerEntries(u, items, source) {
  const clean = items.map((e) => {
    const amount = Math.abs(Number(e?.amount));
    if (!(amount > 0)) return null;
    return {
      id: newId('l'), type: e.type === 'income' ? 'income' : 'expense', amount: Math.round(amount * 100) / 100,
      category: String(e.category || '其他').slice(0, 10), note: String(e.note || '').slice(0, 60),
      date: saneDate(e.date), createdAt: isoNow(), source,
    };
  }).filter(Boolean);
  if (!clean.length) return [];
  writeLedger(u, [...readLedger(u), ...clean]); // 写前重新读，避免覆盖执行 agent 同时写入的条目
  onLedgerChange(u);
  return clean;
}

function ledgerSummary(u) {
  const month = today().slice(0, 7);
  const inMonth = readLedger(u).filter((e) => e.date?.startsWith(month));
  const sum = (list) => list.reduce((a, e) => a + Number(e.amount || 0), 0);
  const expenses = inMonth.filter((e) => e.type === 'expense');
  const byCategory = {};
  for (const e of expenses) byCategory[e.category] = (byCategory[e.category] || 0) + Number(e.amount || 0);
  return {
    month, expense: sum(expenses), income: sum(inMonth.filter((e) => e.type === 'income')),
    todayExpense: sum(expenses.filter((e) => e.date === today())), count: inMonth.length,
    byCategory: Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([category, amount]) => ({ category, amount })),
  };
}

const LEDGER_GOAL_BRIEF = `帮用户把账管好：
1. 用 ledger_query 查今天和本月的收支（按分类）。
2. 用 ledger_memory read 读记账记忆，结合新账目更新它（发现的固定收支、消费习惯、用户提过的预算；没有预算就别编），有变化才 ledger_memory update。
3. STATUS 写本月支出，有预算时加上预算余量。
4. 只有这些情况才 NEW: yes：本月支出超过预算或达到预算 90%；某个分类明显比平时多；今天是周日（发一份本周小结）；发现疑似重复记账。`;

function ensureLedgerGoal(u) {
  return u.state.goals.find((g) => g.kind === 'ledger')
    || createGoal(u, { title: '记账管家', kind: 'ledger', createdBy: 'ai', source: 'ai', schedule: { at: '21:30' }, runNow: false, brief: LEDGER_GOAL_BRIEF });
}

// 每次记账后立刻刷新「记账管家」的状态小字（不用等 AI 检查）。
function onLedgerChange(u) {
  broadcast(u, { type: 'ledger' });
  const g = ensureLedgerGoal(u);
  const s = ledgerSummary(u);
  g.status = { text: `本月支出 ${money(s.expense)} · 今天 ${money(s.todayExpense)}`, at: isoNow() };
  saveGoal(g);
}

const GOAL_SYSTEM = `把用户想持续关注的事整理成一个「目标」，交给会定期执行检查的后台 agent（它能上网搜索和读网页、读各平台公开账号、搜图、查天气等实用信息、看用户记忆、查账记账）。
只输出 JSON：{"title": "不超过 12 个字", "brief": "每次检查要做什么、关注什么（人、事、价格、地点……）、什么算新进展", "schedule": {"every": 分钟数} 或 {"at": "HH:MM"}}
用户没说频率就 {"every": 360}；说「每天」默认 {"at": "09:00"}。`;

async function goalFromText(u, text) {
  const act = startActivity(u, { title: `新目标：${text}`, kind: 'goal' });
  activityStep(act, '理解这个目标');
  let out = {};
  try {
    out = parseJsonLoose(await traceCtx.run(act, () => longcat(GOAL_SYSTEM, `【现在】${nowText()}\n【用户画像】${dispatcherContext(u).split('\n')[1] || ''}\n【用户想要的目标】${text}`, 400, { json: true, name: '解析目标' }))) || {};
  } catch (e) {
    endActivity(act, `没建成：${e.message}`, 'failed');
    throw e;
  }
  if (!out.brief) { endActivity(act, '没理解这个目标', 'failed'); throw new Error('没理解这个目标'); }
  const g = createGoal(u, { title: out.title || text.slice(0, 12), brief: out.brief, schedule: out.schedule, source: 'page' });
  act.goalId = g.id;
  endActivity(act, `建好目标「${g.title}」· ${scheduleLabel(g.schedule)}，先查一次`);
  return g;
}

// ---------- 上传 / 图片代理 ----------
const MAX_UPLOAD = 8 << 20; // 单张图最大 8 MB
function saveUpload(u, dataUrl) {
  const m = /^data:image\/[\w+.-]+;base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (!buf.length || buf.length > MAX_UPLOAD) return null;
  const name = `${newId('u')}.jpg`;
  fs.writeFileSync(path.join(u.dir, 'uploads', name), buf); // 每人自己的目录：/api/uploads/<名字> 只在自己的目录里找
  return `/api/uploads/${name}`;
}

function isPrivateAddress(ip) {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

// 部分图床校验 Referer（微博 sinaimg、B 站 hdslb、X twimg、Instagram cdninstagram / fbcdn、Weverse wevpstatic）。
function refererFor(host) {
  if (host.endsWith('sinaimg.cn')) return 'https://weibo.com/';
  if (host.endsWith('hdslb.com')) return 'https://www.bilibili.com/';
  if (host.endsWith('twimg.com')) return 'https://x.com/';
  if (host.endsWith('cdninstagram.com') || host.endsWith('fbcdn.net')) return 'https://www.instagram.com/';
  if (host.endsWith('wevpstatic.net') || host.endsWith('weverse.io')) return 'https://weverse.io/';
  return undefined;
}

// ---------- 沙箱浏览器：平台登录状态 / 登录窗口（App 不碰账号密码，登录由用户在沙箱弹出的窗口里自己完成） ----------
const SANDBOX_URL = process.env.CATTUAN_SANDBOX_URL || 'http://127.0.0.1:8660';

// ---------- 浏览器实时画面：订阅沙箱 /live，转给 App；每个任务存最多 16 张关键帧做回放（仿 Claude Cowork） ----------
// 沙箱大家共用：画面只推给这个任务的主人，回放帧存在主人自己的目录下（frames/<任务 id>/）。
const MAX_KEYFRAMES = 16;
const setSandboxFrames = (on) => fetch(`${SANDBOX_URL}/live/frames?on=${on ? 1 : 0}`).catch(() => {});

// 沙箱一次只做一件事。一段操作（start…end）属于哪个任务：插件带了任务编号（从 Hermes 的会话 id 取）就用它；
// 没带时才看此刻哪个任务正卡在会用沙箱的工具步骤上。这样的任务分属不同的人时不猜：宁可不显示，也不把别人的画面挂到你的任务上。
const SANDBOX_TOOLS = new Set(['official_photos', 'official_account', 'xiaohongshu_search', 'deep_web_search', 'read_webpage', 'check_site']);
let liveOwner = null;
function findTask(id) {
  if (!id) return null;
  for (const u of users.values()) {
    const t = u.state.tasks.find((x) => x.id === id);
    if (t) return t;
  }
  return null;
}
function guessLiveTask() {
  const busy = [...users.values()].flatMap((u) => u.state.tasks)
    .filter((t) => t.status === 'running' && t.steps?.at(-1)?.status === 'running' && SANDBOX_TOOLS.has(t.steps.at(-1).name))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return busy.length && busy.every((t) => t.uid === busy[0].uid) ? busy[0] : null;
}

function onLiveEvent(ev) {
  if (ev.type === 'start') liveOwner = findTask(ev.task) || guessLiveTask();
  const t = findTask(ev.task) || liveOwner;
  if (ev.type === 'end') liveOwner = null;
  if (!t) return; // 不是 App 任务派的操作（比如调试），或者猜不准是谁的：不记
  const u = U(t);
  t.browser ||= { actions: [], frames: [], active: false };
  const b = t.browser;
  const at = new Date(ev.at || Date.now()).toISOString();
  if (ev.type === 'start' || ev.type === 'action') {
    if (ev.type === 'start') b.active = true;
    b.actions = [...b.actions, { at, text: ev.text, platform: ev.platform }].slice(-60);
    save(u);
    broadcast(u, { type: 'browser', taskId: t.id, active: b.active, action: b.actions.at(-1) });
  } else if (ev.type === 'end') {
    b.active = false;
    save(u);
    broadcast(u, { type: 'browser', taskId: t.id, active: false });
  } else if (ev.type === 'frame' && ev.data) {
    if (ev.key) {
      const dir = path.join(u.dir, 'frames', t.id);
      fs.mkdirSync(dir, { recursive: true });
      const name = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}.jpg`;
      fs.writeFileSync(path.join(dir, name), Buffer.from(ev.data, 'base64'));
      b.frames.push({ at, text: ev.text, url: ev.url, src: `/api/frames/${t.id}/${name}` });
      for (const old of b.frames.splice(0, Math.max(0, b.frames.length - MAX_KEYFRAMES))) {
        fs.rmSync(path.join(dir, path.basename(old.src)), { force: true });
      }
      save(u);
    }
    if (u.clients.size) broadcast(u, { type: 'browser-frame', taskId: t.id, url: ev.url, key: !!ev.key, data: ev.data });
  }
}

async function connectLive() {
  try {
    const res = await fetch(`${SANDBOX_URL}/live`);
    if (!res.ok) throw new Error(`live ${res.status}`);
    setSandboxFrames(watching());
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        buf = buf.slice(i + 2);
        if (data) { try { onLiveEvent(JSON.parse(data)); } catch {} }
      }
    }
  } catch {}
  setTimeout(connectLive, 3_000); // 沙箱重启或还没起来：过几秒再连
}
connectLive();
let sandboxSessions = null; // 最近一次拿到的各平台登录状态，给调度者参考

async function sandbox(pathname, timeout = 10_000) {
  const r = await fetch(SANDBOX_URL + pathname, { signal: AbortSignal.timeout(timeout) });
  const body = await r.json().catch(() => ({ error: 'failed', message: `沙箱返回 ${r.status}` }));
  if (r.ok && body.platforms) sandboxSessions = body;
  return { status: r.status, body };
}
const sandboxDown = (e) => ({ status: 502, body: { error: 'sandbox_down', message: `沙箱没连上（scripts/start.sh 会启动它）：${e.message}` } });

async function proxyImage(res, raw) {
  let url;
  try { url = new URL(raw); } catch { return sendJson(res, 400, { error: 'bad url' }); }
  // 手动跟重定向，每一跳都查是不是内网 / 本机地址：不然一个公网图片地址重定向一下，就能打到本机的 agent 和沙箱。
  let upstream;
  for (let hop = 0; ; hop++) {
    if (!['http:', 'https:'].includes(url.protocol)) return sendJson(res, 400, { error: 'bad url' });
    const { address } = await dns.lookup(url.hostname);
    if (isPrivateAddress(address)) return sendJson(res, 403, { error: 'forbidden' });
    const headers = { 'User-Agent': UA, Accept: 'image/*' };
    const referer = refererFor(url.hostname);
    if (referer) headers.Referer = referer;
    upstream = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    const next = upstream.status >= 300 && upstream.status < 400 && upstream.headers.get('location');
    if (!next) break;
    upstream.body?.cancel().catch(() => {});
    if (hop >= 4) return sendJson(res, 502, { error: 'too many redirects' });
    url = new URL(next, url);
  }
  const type = upstream.headers.get('content-type') || '';
  if (!upstream.ok || !type.startsWith('image/')) return sendJson(res, 502, { error: `upstream ${upstream.status}` });
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' });
  Readable.fromWeb(upstream.body).pipe(res);
}

// ---------- 用户位置：浏览器定位 → 反查城市/区。精确坐标只存本机，给 AI 的只有城市/区和约 1 公里精度的坐标 ----------
const LOCATION_FRESH = 24 * 3600_000; // 超过一天的位置不再告诉 AI
const GEO_UA = { 'User-Agent': 'CatTuan/0.1 (local personal assistant)', 'Accept-Language': 'zh-CN' };

function agoText(ms) {
  const m = Math.round(ms / 60_000);
  return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`;
}

function locationLine(u) {
  const loc = u.state.location;
  if (!loc || Date.now() - Date.parse(loc.at) > LOCATION_FRESH) return '';
  const km = Math.max(1, Math.round(loc.accuracy / 1000));
  return `${loc.label || '未知地点'}（误差约 ${km} 公里，坐标约 ${loc.lat.toFixed(2)},${loc.lon.toFixed(2)}，${agoText(Date.now() - Date.parse(loc.at))}更新）`;
}

const uniq = (parts) => parts.filter((p, i) => p && parts.indexOf(p) === i);

// 两家一起查再拼：市、区用 BigDataCloud（地级市和区都准，zh-Hans 给简体）；街道用 OpenStreetMap Nominatim。
// Nominatim 在中国的「city」常常是区，还会在区界附近给错区（把街道标到隔壁的区），所以只作兜底。
// 浏览器给的是 WGS-84 坐标，两家都按 WGS-84 解析。
async function reverseGeocode(lat, lon) {
  const get = (url) => fetch(url, { headers: GEO_UA, signal: AbortSignal.timeout(8_000) }).then((r) => r.json()).catch(() => null);
  const [osm, bdc] = await Promise.all([
    get(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16&accept-language=zh-CN`),
    get(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=zh-Hans`),
  ]);
  const a = osm?.address || {};
  const province = bdc?.principalSubdivision || a.state || '';
  const city = bdc?.city || (/市$/.test(a.state || '') ? a.state : '') || a.city || '';
  const bdcDistrict = bdc?.locality && bdc.locality !== city ? bdc.locality : '';
  const district = bdcDistrict || a.city_district || a.district || a.county || (a.city !== city ? a.city : '') || '';
  const suburb = a.suburb || a.town || a.township || a.village || '';
  return {
    country: a.country || bdc?.countryName || '', province, city, district, suburb,
    label: uniq([city || province, district, suburb]).join(' '),
  };
}

const distanceKm = (a, b) => {
  const r = Math.PI / 180;
  const x = (b.lon - a.lon) * r * Math.cos(((a.lat + b.lat) / 2) * r);
  return 6371 * Math.hypot(x, (b.lat - a.lat) * r);
};

async function setLocation(u, { lat, lon, accuracy }) {
  lat = Number(lat); lon = Number(lon); accuracy = Math.max(1, Number(accuracy) || 1000);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) throw new Error('坐标不对');
  const state = u.state;
  const prev = state.location;
  // 300 米内没动就沿用上次的地名，少调一次反查（Nominatim 限速每秒 1 次）。
  const place = prev?.label && distanceKm(prev, { lat, lon }) < 0.3 ? prev : await reverseGeocode(lat, lon);
  state.location = {
    lat, lon, accuracy: Math.round(accuracy), at: isoNow(),
    country: place.country || '', province: place.province || '', city: place.city || '', district: place.district || '', suburb: place.suburb || '',
    label: place.label || '',
  };
  save(u);
  broadcast(u, { type: 'location', location: state.location });
  return state.location;
}

// ---------- 技能管理：调 Hermes 的 Python 帮忙读写，避免从 Node 手改 config.yaml ----------
const HERMES_PY = path.resolve(APP_DIR, '../hermes-agent/.venv/bin/python');
const SKILLS_ADMIN = path.resolve(APP_DIR, '../scripts/skills_admin.py');
function skillsAdmin(u, ...args) {
  return new Promise((resolve) => {
    execFile(HERMES_PY, [SKILLS_ADMIN, ...args], { env: { ...process.env, HERMES_HOME: u.home }, timeout: 30_000, maxBuffer: 4 << 20 },
      (err, stdout) => {
        try { resolve(JSON.parse(stdout.trim().split('\n').pop())); } catch { resolve({ error: err?.message || '技能管理出错了' }); }
      });
  });
}

// ---------- HTTP ----------
// limit：请求体上限（默认 1 MB，发消息带图时放宽）。按 Buffer 收齐再解码，免得中文被切在两个 chunk 中间。
async function readBody(req, limit = 1 << 20) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('内容太大了'), { status: 413 });
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error('请求格式不对'), { status: 400 }); }
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function serveFile(res, file, fallback) {
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return fallback ? fallback() : sendJson(res, 404, { error: 'not found' });
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

// ---------- 登录 ----------
// cookie 里放登录会话的 token（库里只存哈希），HttpOnly + SameSite=Lax。线上走 HTTPS 时加 Secure 和 __Host- 前缀：
// 同一主域名下的别的子域名（比如放 agent 网页的 sites.）没法种一个同名 cookie 来冒充。
const SECURE = PUBLIC_ORIGIN.startsWith('https://');
const COOKIE = SECURE ? '__Host-cattuan' : 'cattuan_sid';
const sessionCookie = (token, maxAge = 30 * 86400) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${SECURE ? '; Secure' : ''}`;

function cookieToken(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return '';
}

// 真实的客户端 IP：在 Caddy 后面时请求都来自本机，用它加的 X-Forwarded-For（最后一个是 Caddy 看到的地址）
function clientIp(req) {
  const peer = req.socket.remoteAddress || '';
  const xff = req.headers['x-forwarded-for'];
  return xff && /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(peer) ? String(xff).split(',').at(-1).trim() : peer;
}

// 登录失败限流：同一个名字 15 分钟里错到 10 次、同一个 IP 错到 50 次（同一个办公室出口 IP 是共用的），就先锁 15 分钟
const LOCK_MS = 15 * 60_000;
const loginFails = new Map(); // 'ip:…' / 'name:…' → { n, at }
const loginLocked = (keys) => keys.some((k) => { const f = loginFails.get(k); return f && f.n >= (k.startsWith('ip:') ? 50 : 10) && Date.now() - f.at < LOCK_MS; });
function loginFailed(keys) {
  for (const k of keys) {
    const f = loginFails.get(k);
    loginFails.set(k, { n: f && Date.now() - f.at < LOCK_MS ? f.n + 1 : 1, at: Date.now() });
  }
}
setInterval(() => { for (const [k, f] of loginFails) if (Date.now() - f.at > LOCK_MS) loginFails.delete(k); }, 600_000).unref();

function startSession(req, res, user) {
  loadUser(user);
  res.setHeader('Set-Cookie', sessionCookie(accounts.createSession(user.id, { ip: clientIp(req), ua: req.headers['user-agent'] })));
  return sendJson(res, 200, { ok: true, name: user.name });
}

async function authRoute(req, res, url) {
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    const { name = '', password = '' } = await readBody(req);
    const keys = [`ip:${clientIp(req)}`, `name:${String(name).trim().toLowerCase()}`];
    if (loginLocked(keys)) return sendJson(res, 429, { error: '试错太多次了，15 分钟后再试' });
    const user = await accounts.verifyPassword(name, password);
    if (!user) { loginFailed(keys); return sendJson(res, 401, { error: '名字或密码不对' }); }
    for (const k of keys) loginFails.delete(k);
    return startSession(req, res, user);
  }
  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    accounts.deleteSession(cookieToken(req));
    res.setHeader('Set-Cookie', sessionCookie('', 0));
    return sendJson(res, 200, { ok: true });
  }
  // 现在是谁：没登录 / 过期了是 401（App 的实时连接断了会来问一下，401 就回登录页）
  if (url.pathname === '/api/auth/me') {
    const me = accounts.sessionUser(cookieToken(req));
    return me ? sendJson(res, 200, { name: me.name, role: me.role }) : sendJson(res, 401, { error: '请先登录' });
  }
  // 邀请链接（邀请码在链接的 # 后面，不会出现在任何请求地址和日志里）：只带 code 是先看是谁的邀请；带上 password 是设密码、激活并登录
  if (url.pathname === '/api/auth/invite' && req.method === 'POST') {
    const { code = '', password } = await readBody(req);
    if (password === undefined) {
      const inv = accounts.peekInvite(code);
      return inv ? sendJson(res, 200, { name: inv.name, reset: inv.status === 'active' }) : sendJson(res, 404, { error: '邀请链接无效或已过期，找管理员重新发一个' });
    }
    let user;
    try { user = await accounts.acceptInvite(code, password); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    return startSession(req, res, user);
  }
  return sendJson(res, 404, { error: 'not found' });
}

// 不用登录就能拿的：登录页和它用到的样式、图标（App 页面本身和所有接口都要登录）
const PUBLIC_FILES = new Set(['/style.css', '/longcat-icon.svg', '/longcat-logo.svg', '/icon.svg', '/manifest.webmanifest']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // 别的网页（包括 agent 做的网站）不能替用户调 App 的接口：有 Origin 的写请求必须来自 App 自己。
  // 在 HTTPS 反代后面，浏览器的 Origin 是 https://…，要和 PUBLIC_ORIGIN 比，不能拿 Host 拼 http://。
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin && req.headers.origin !== (PUBLIC_ORIGIN || `http://${req.headers.host}`)) {
    return sendJson(res, 403, { error: 'forbidden origin' });
  }
  try {
    // 健康检查（不用登录）：只给几个计数，scripts/restart.sh 据此判断忙不忙
    if (url.pathname === '/api/health') {
      const all = [...users.values()].flatMap((x) => x.state.tasks);
      return sendJson(res, 200, { ok: true, users: users.size, running: all.filter((t) => t.status === 'running').length, queued: all.filter((t) => t.status === 'queued').length });
    }
    if (url.pathname.startsWith('/api/auth/')) return await authRoute(req, res, url);
    // ---- 执行 agent 的工具调用明细（cattuan-bridge 插件推送，凭推送用的 agent key 认出是谁的 agent） ----
    if (url.pathname === '/api/agent/tool' && req.method === 'POST') {
      if (!userByAgentKey(String(req.headers.authorization || '').replace(/^Bearer /, ''))) return sendJson(res, 401, { error: 'unauthorized' });
      onBridgeToolCall(await readBody(req, 4 << 20));
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/login') return serveFile(res, path.join(PUBLIC_DIR, 'login.html'));
    if (PUBLIC_FILES.has(url.pathname)) return serveFile(res, path.join(PUBLIC_DIR, url.pathname));

    // ---- 下面都要登录：每个接口只碰这个人自己的数据，拿别人的 id 来查一律 404 ----
    const me = accounts.sessionUser(cookieToken(req));
    if (!me) {
      if (url.pathname.startsWith('/api/')) return sendJson(res, 401, { error: '请先登录' });
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
    const u = loadUser(me);
    const state = u.state;
    if (url.pathname === '/api/state') {
      return sendJson(res, 200, {
        me: { name: u.name, role: u.role },
        messages: state.messages.filter((m) => m.chatId === state.currentChat).slice(-200), chats: chatList(u), currentChat: state.currentChat,
        tasks: state.tasks.slice(-50), goals: state.goals, activity: state.activity.slice(-40), location: state.location || null, sites: listSites(u), sitesOrigin: SITES_ORIGIN,
        traceBase: u.role === 'admin' ? traceBase() : null, // 轨迹里是所有人的完整对话，只给管理员
      });
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
      const first = !watching();
      u.clients.add(res);
      if (first) setSandboxFrames(true); // 有人打开 App 了：让沙箱推连续画面
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      req.on('close', () => {
        clearInterval(ping);
        u.clients.delete(res);
        if (!watching()) setSandboxFrames(false);
      });
      return;
    }
    if (url.pathname === '/api/message' && req.method === 'POST') {
      const { text = '', images = [] } = await readBody(req, 10 << 20); // 前端把图缩到 1280px 再传，3 张绰绰有余
      const over = overQuota(u, 'messages');
      if (over) return sendJson(res, 429, { error: over });
      const files = images.slice(0, 3).map((img) => saveUpload(u, img)).filter(Boolean);
      if (!text.trim() && !files.length) return sendJson(res, 400, { error: 'empty' });
      accounts.bumpUsage(u.id, 'messages');
      const chatId = state.currentChat; // 调度者回复期间切了聊天，回复和任务也留在发消息的那个聊天
      addMessage(u, { role: 'me', text: text.trim(), images: files, chatId });
      // 主 agent 的这一轮：每一步记进「喵团动态」，App 顶栏实时显示做到哪一步
      const act = startActivity(u, { title: text.trim() || `看你发的 ${files.length} 张图`, chatId, replyIn: chatId,
        input: `${text.trim()}${files.length ? `（附带 ${files.length} 张图片）` : ''}` });
      activityStep(act, '想想怎么回');
      let d;
      try { d = await traceCtx.run(act, () => dispatch(u, text.trim(), files.length)); } catch (e) {
        console.error('[dispatch]', e.message);
        d = { reply: '我这边网络有点卡，等下再说一次？', search: null, task: null, steer: null, stop: null, goal: null, goalDone: [], ledger: [], ledgerDelete: [], failed: true };
      }
      // 额度：要派的后台任务、要建的目标超了，就不派、不建，回复换成说明
      const taskOver = d.task && overQuota(u, 'tasks');
      if (taskOver) { d.task = null; d.reply = taskOver; }
      const goalOver = d.goal && goalLimit(u);
      if (goalOver) { d.goal = null; d.reply = goalOver; }
      const did = []; // 这一轮做了什么，写进动态的结果
      if (d.ledgerDelete.length) {
        activityStep(act, `删账 ${d.ledgerDelete.length} 笔`);
        writeLedger(u, readLedger(u).filter((e) => !d.ledgerDelete.includes(e.id)));
        onLedgerChange(u);
        did.push(`删了 ${d.ledgerDelete.length} 笔账`);
      }
      if (d.ledger.length) {
        activityStep(act, '记账');
        const added = addLedgerEntries(u, d.ledger, 'chat');
        if (added.length) did.push(`记账：${added.map((e) => `${e.note || e.category} ${money(e.amount)}`).join('、')}`);
      }
      for (const g of d.goalDone) {
        activityStep(act, `完成目标「${g.title}」`);
        setGoalDone(g, true, '你在聊天里说不用再盯了');
        did.push(`完成目标「${g.title}」`);
      }
      if (d.goal) activityStep(act, `新建目标「${d.goal.title || '新目标'}」`);
      const goal = d.goal ? createGoal(u, { title: d.goal.title || '新目标', brief: d.goal.brief, schedule: d.goal.schedule }) : null;
      if (goal) { act.goalId = goal.id; did.push(`建了目标「${goal.title}」· ${scheduleLabel(goal.schedule)}`); }
      if (d.task) activityStep(act, `派后台任务「${d.task.title || '后台任务'}」`);
      const task = d.task ? createTask(u, { title: d.task.title || '后台任务', brief: d.task.brief, images: files, kind: d.task.research ? 'research' : 'chat', chatId }) : null;
      if (task) { act.taskId = task.id; did.push(`派出${task.kind === 'research' ? '深度搜索' : '后台任务'}「${task.title}」`); }
      if (d.stop) {
        activityStep(act, `停掉「${d.stop.title}」`);
        stopTask(d.stop);
        act.taskId = d.stop.id;
        did.push(`停了「${d.stop.title}」`);
      }
      if (d.search) { // 普通搜索：App 马上去搜，搜完直接发回答（搜的时候聊天里只有「…」，步骤在顶栏）
        traceCtx.run(act, () => quickSearch(u, chatId, text.trim(), d.search, act)).catch((e) => { console.error('[search]', e.message); endActivity(act, `搜索出错了：${e.message}`, 'failed'); });
        return sendJson(res, 200, { ok: true });
      }
      if (d.steer) activityStep(act, `让「${d.steer.task.title}」改一下`);
      const rev = d.steer ? await steerTask(d.steer.task, d.steer.instruction) : null;
      if (rev) { act.taskId = d.steer.task.id; did.push(`让「${d.steer.task.title}」${rev.state === 'round' ? `开第 ${rev.round} 轮改` : '按新要求调整'}`); }
      const round = task ? 1 : rev ? rev.round : d.stop ? d.stop.round || 1 : undefined;
      addMessage(u, { role: 'bot', text: d.reply, taskId: task?.id, goalId: goal?.id, chatId, round,
        ...(d.steer && { steerOf: d.steer.task.id }), ...(d.stop && { stopOf: d.stop.id }) });
      endActivity(act, d.failed ? '网络卡了，没想出来' : did.length ? did.join('；') : `回复：${d.reply}`, d.failed ? 'failed' : 'done');
      return sendJson(res, 200, { ok: true });
    }
    // ---- 喵团简历上的数字 ----
    if (url.pathname === '/api/profile') {
      return sendJson(res, 200, { ...state.stats, sites: listSites(u).length, goals: state.goals.length, ledger: readLedger(u).length, chats: state.chats.length, model: DISPATCH_MODEL });
    }
    // ---- 聊天：新建、切换、删除 ----
    if (url.pathname === '/api/chats' && req.method === 'GET') return sendJson(res, 200, { chats: chatList(u, url.searchParams.get('q') || ''), currentChat: state.currentChat });
    if (url.pathname === '/api/chats' && req.method === 'POST') {
      // 当前聊天还一句话没说过，就不再开一个空的
      const cur = state.chats.find((c) => c.id === state.currentChat);
      const chat = cur && !state.messages.some((m) => m.chatId === cur.id && m.role === 'me') ? cur : newChat(u);
      save(u);
      broadcast(u, { type: 'chats', currentChat: state.currentChat });
      return sendJson(res, 200, { chat });
    }
    const chatMatch = /^\/api\/chats\/([\w-]+)(\/open)?$/.exec(url.pathname);
    if (chatMatch) {
      const chat = state.chats.find((c) => c.id === chatMatch[1]);
      if (!chat) return sendJson(res, 404, { error: '这个聊天不在了' });
      if (chatMatch[2] && req.method === 'POST') {
        state.currentChat = chat.id;
      } else if (req.method === 'DELETE') {
        state.chats = state.chats.filter((c) => c.id !== chat.id);
        state.messages = state.messages.filter((m) => m.chatId !== chat.id);
        if (state.currentChat === chat.id) {
          if (state.chats.length) state.currentChat = chatList(u)[0].id; else newChat(u);
        }
      } else return sendJson(res, 405, { error: 'method not allowed' });
      save(u);
      broadcast(u, { type: 'chats', currentChat: state.currentChat });
      return sendJson(res, 200, { currentChat: state.currentChat });
    }
    // ---- 任务：重试（失败/停了的任务点「重试」）、停止、修改 ----
    const taskAction = /^\/api\/tasks\/([\w-]+)\/(retry|stop|steer)$/.exec(url.pathname);
    if (taskAction && req.method === 'POST') {
      const t = state.tasks.find((x) => x.id === taskAction[1]);
      if (!t) return sendJson(res, 404, { error: 'not found' });
      if (taskAction[2] === 'stop') {
        if (!stopTask(t)) return sendJson(res, 409, { error: '这个任务已经结束了' });
        if (t.kind !== 'goal') addMessage(u, { role: 'bot', text: `好，「${t.title}」先停了～`, stopOf: t.id, round: t.round || 1, ...(t.chatId && { chatId: t.chatId }) });
        return sendJson(res, 200, { ok: true });
      }
      if (taskAction[2] === 'steer') {
        const rev = await steerTask(t, (await readBody(req)).text);
        return rev ? sendJson(res, 200, rev) : sendJson(res, 400, { error: '改不了这个任务' });
      }
      if (t.status !== 'failed' && t.status !== 'stopped') return sendJson(res, 409, { error: '这个任务没失败，不用重试' });
      const over = t.kind !== 'goal' && overQuota(u, 'tasks');
      if (over) return sendJson(res, 429, { error: over });
      if (t.kind !== 'goal') accounts.bumpUsage(u.id, 'tasks');
      updateTask(t, { status: 'queued', error: undefined, steps: [], startedAt: undefined, endedAt: undefined, runId: undefined, retried: (t.retried || 0) + 1,
        ...((t.round || 1) === 1 && { result: undefined }) }); // 修改轮重试时保留上一轮结果，修改要求还在 asks 里
      if (t.kind !== 'goal') addMessage(u, { role: 'bot', text: `重新去办：${t.title}～`, taskId: t.id, round: t.round || 1, ...(t.chatId && { chatId: t.chatId }) });
      pump();
      return sendJson(res, 200, { ok: true });
    }
    // ---- 目标 ----
    if (url.pathname === '/api/goals' && req.method === 'POST') {
      const { text = '' } = await readBody(req);
      if (!text.trim()) return sendJson(res, 400, { error: '说说想让喵团盯着什么' });
      const over = goalLimit(u);
      if (over) return sendJson(res, 429, { error: over });
      return sendJson(res, 200, await goalFromText(u, text.trim()));
    }
    const goalMatch = /^\/api\/goals\/([\w-]+)(\/run)?$/.exec(url.pathname);
    if (goalMatch) {
      const g = state.goals.find((x) => x.id === goalMatch[1]);
      if (!g) return sendJson(res, 404, { error: 'not found' });
      if (goalMatch[2] && req.method === 'POST') return sendJson(res, 200, { task: runGoal(g) });
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        if ('done' in body) setGoalDone(g, !!body.done, '你标记的');
        else if (!g.done && !!body.enabled !== g.enabled) {
          g.enabled = !!body.enabled;
          if (g.enabled) g.nextRunAt = nextRun(g.schedule);
          goalLog(g, g.enabled ? '继续检查' : '暂停');
          saveGoal(g);
        }
        return sendJson(res, 200, g);
      }
      if (req.method === 'DELETE') {
        state.goals = state.goals.filter((x) => x.id !== g.id);
        save(u);
        broadcast(u, { type: 'goal-removed', id: g.id });
        return sendJson(res, 200, { ok: true });
      }
    }
    // ---- 记账 ----
    if (url.pathname === '/api/ledger' && req.method === 'GET') {
      const month = today().slice(0, 7);
      let memory = '';
      try { memory = fs.readFileSync(path.join(u.home, 'ledger', 'LEDGER.md'), 'utf8'); } catch {}
      const entries = readLedger(u).filter((e) => e.date?.startsWith(month)).sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));
      return sendJson(res, 200, { summary: ledgerSummary(u), entries: entries.slice(0, 100), memory });
    }
    if (url.pathname === '/api/ledger' && req.method === 'POST') {
      const added = addLedgerEntries(u, [await readBody(req)], 'app');
      return added.length ? sendJson(res, 200, added[0]) : sendJson(res, 400, { error: '金额不对' });
    }
    if (url.pathname.startsWith('/api/ledger/') && req.method === 'DELETE') {
      const id = path.basename(url.pathname);
      writeLedger(u, readLedger(u).filter((e) => e.id !== id));
      onLedgerChange(u);
      return sendJson(res, 200, { ok: true });
    }
    // ---- 用户位置 ----
    if (url.pathname === '/api/location' && req.method === 'POST') {
      try { return sendJson(res, 200, await setLocation(u, await readBody(req))); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (url.pathname === '/api/location' && req.method === 'DELETE') {
      state.location = null;
      save(u);
      broadcast(u, { type: 'location', location: null });
      return sendJson(res, 200, { ok: true });
    }
    // ---- 技能（只读展示；装不装由执行 agent 按需决定，见 hermes-home/plugins/skill-store） ----
    if (url.pathname === '/api/skills' && req.method === 'GET') return sendJson(res, 200, await skillsAdmin(u, 'list'));
    const skillMatch = /^\/api\/skills\/([\w.-]+)$/.exec(url.pathname);
    if (skillMatch && req.method === 'GET') return sendJson(res, 200, await skillsAdmin(u, 'show', skillMatch[1]));
    // ---- 社媒账号备忘录：已关注的账号（执行 agent 的 official_account 维护） ----
    if (url.pathname === '/api/follows') {
      return sendJson(res, 200, readJson(path.join(u.home, 'official_accounts.json'), []));
    }
    // ---- 沙箱登录（转发给沙箱的 /sessions、/login、/login/done）：登录状态大家都能看；登录窗口只有管理员能开 ----
    if (url.pathname === '/api/sessions') {
      const r = await sandbox('/sessions').catch(sandboxDown);
      return sendJson(res, r.status, r.body);
    }
    if ((url.pathname === '/api/login' || url.pathname === '/api/login/done') && u.role !== 'admin') {
      return sendJson(res, 403, { error: 'admin_only', message: '平台账号由管理员统一登录' });
    }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const { platform = '' } = await readBody(req);
      const r = await sandbox(`/login?platform=${encodeURIComponent(platform)}`, 90_000).catch(sandboxDown);
      return sendJson(res, r.status, r.body);
    }
    if (url.pathname === '/api/login/done' && req.method === 'POST') {
      const r = await sandbox('/login/done', 90_000).catch(sandboxDown);
      return sendJson(res, r.status, r.body);
    }
    const frameMatch = /^\/api\/frames\/(t_[a-z0-9]+)\/([\w-]+\.jpg)$/.exec(url.pathname);
    if (frameMatch) return serveFile(res, path.join(u.dir, 'frames', frameMatch[1], frameMatch[2]));
    if (url.pathname.startsWith('/api/uploads/')) return serveFile(res, path.join(u.dir, 'uploads', path.basename(url.pathname)));
    if (url.pathname === '/api/img') return await proxyImage(res, url.searchParams.get('u') || '');
    const file = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
    return serveFile(res, file, () => serveFile(res, path.join(PUBLIC_DIR, 'index.html')));
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message });
    else res.end();
  }
});

// ---------- 网站服务（:3211）：只读地提供 agent 做的网页 ----------
// 和 App 不同端口 = 不同源，网页里的脚本碰不到 App 的接口和存储；CSP 只放行 https 外链，
// 网页没法请求本机的 agent（8650）、沙箱（8660）和 App 接口；只能被 App 嵌入。
const SITE_CSP = [
  "default-src 'self' https: data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:",
  "style-src 'self' 'unsafe-inline' https:",
  `img-src 'self' https: data: blob: ${APP_ORIGINS.join(' ')}`, // 允许用 App 的图片代理
  "font-src 'self' https: data:",
  "connect-src 'self' https:",
  "media-src 'self' https: data: blob:",
  "frame-src https:",
  "form-action 'self'",
  "base-uri 'self'",
  `frame-ancestors ${APP_ORIGINS.join(' ')}`,
].join('; ');

const sitesServer = http.createServer((req, res) => {
  const notFound = () => { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('没有这个网站'); };
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let parts;
  try { parts = decodeURIComponent(new URL(req.url, 'http://x').pathname).split('/').filter(Boolean); } catch { return notFound(); }
  const [id, ...rest] = parts;
  const dir = findSiteDir(id);
  if (!dir) return notFound();
  if (!rest.length && !req.url.split('?')[0].endsWith('/')) { res.writeHead(301, { Location: `/${id}/` }); return res.end(); }
  const file = path.join(dir, ...(rest.length ? rest : ['index.html']));
  if (!file.startsWith(dir + path.sep) || /^(meta\.json|.*\.prev\..*|.*\.tmp)$/.test(path.basename(file))) return notFound();
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return notFound();
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Content-Security-Policy': SITE_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
});
sitesServer.listen(SITES_PORT, HOST);

// 启动：把没停用的账号都载进来，各自的任务接着跑、目标接着盯
for (const row of accounts.activeUsers()) loadUser(row);
if (!accounts.listUsers().length) console.log('还没有账号：node scripts/user.mjs invite <名字> --admin（从单用户版升级：node scripts/user.mjs adopt <你的名字>）');
if (fs.existsSync(path.join(DATA_DIR, 'state.json'))) console.warn(`单用户版的数据（${path.join(DATA_DIR, 'state.json')}）还没归到账号下：先停掉 App 和 agent，再 node scripts/user.mjs adopt <你的名字>`);

server.requestTimeout = 0;
server.listen(PORT, HOST, () => {
  const all = [...users.values()].flatMap((u) => u.state.tasks);
  const resumed = all.filter((t) => t.status === 'queued').length;
  console.log(`CatTuan app → ${PUBLIC_ORIGIN || `http://localhost:${PORT}`}  (${users.size} 个账号, 网站 ${SITES_ORIGIN}${resumed ? `，续跑 ${resumed} 个任务` : ''})`);
  setTimeout(() => {
    for (const t of all.filter((x) => x.reattach)) { delete t.reattach; runTask(t); }
    pump();
  }, 3_000); // 给 agent 一点启动时间，再接回 / 接着跑重启前没完成的任务
});
