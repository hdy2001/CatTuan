// CatTuan BFF —— Muse 式「调度者 + 后台执行 agent」：
//   调度者（dispatcher）：直接调 LongCat、不带工具，几秒内用聊天口吻短回复，并决定要不要派后台任务。
//   执行 agent（executor）：Hermes（搜索 / 社媒账号 / 做网页 / 识图 / 记账 / 记忆工具），在后台跑，App 关了也继续。
//   任务完成后，调度者把结果转成聊天消息发回来；聊天、任务、目标都存在服务端，经 SSE 推给 App。
//   目标（goal，仿 Muse Goal）：持续运行、定期检查的后台目标，有新进展才在聊天里说，目标列表显示最新状态。
//   记账：调度者能直接记账；账本与执行 agent 的 ledger 插件共用 hermes-home/ledger/，AI 自动维护「记账管家」目标。
// 零依赖：node app/server.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const DATA_DIR = path.join(APP_DIR, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const HERMES_HOME = path.resolve(APP_DIR, '../hermes-home');

function readEnvFile(file) {
  try {
    return Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]));
  } catch { return {}; }
}
const hermesEnv = readEnvFile(path.join(HERMES_HOME, '.env'));
const HERMES_URL = `http://127.0.0.1:${hermesEnv.API_SERVER_PORT || 8642}`;
const HERMES_KEY = hermesEnv.API_SERVER_KEY;
const LONGCAT_KEY = process.env.LONGCAT_API_KEY || hermesEnv.LONGCAT_API_KEY
  || readEnvFile(path.join(os.homedir(), '.hermes/.env')).LONGCAT_API_KEY;
const LONGCAT_URL = 'https://api.longcat.chat/openai/v1/chat/completions';
const DISPATCH_MODEL = process.env.DISPATCH_MODEL || 'LongCat-2.5-Preview';
const PORT = Number(process.env.PORT || 3210);
const LEDGER_DIR = path.join(HERMES_HOME, 'ledger');
const LEDGER_FILE = path.join(LEDGER_DIR, 'entries.json');
const LEDGER_MEMORY = path.join(LEDGER_DIR, 'LEDGER.md');
// 网站：执行 agent 的 publish_site 写到 hermes-home/sites/<id>/，App 在单独端口上提供（和 App 不同源）。
const SITES_DIR = path.join(HERMES_HOME, 'sites');
const SITES_PORT = Number(process.env.SITES_PORT || PORT + 1);
const MAX_RUNNING = 2;
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

// ---------- 状态（服务端持久化） ----------
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const state = { messages: [], tasks: [], goals: [], goalsInit: false, ...readJson(STATE_FILE, {}) };
delete state.feed; // 「动态」已由目标取代
for (const t of state.tasks) {
  // App 重启时 Hermes 那边可能还在跑这一轮（/v1/runs）：启动后按 run id 接回事件流，不重跑。
  if (t.status === 'running' && t.runId) { t.reattach = true; continue; }
  // 其余没跑完的任务：重新排队，启动后接着跑（不再直接判失败）。
  if (t.status === 'running' || t.status === 'queued') Object.assign(t, { status: 'queued', steps: [], startedAt: undefined, resumed: true, runId: undefined });
}
// 启动时按最新的解析规则重算已经发出的研究报告（解析规则改过时，老报告也能显示干净）。
setImmediate(() => {
  for (const m of state.messages) {
    const t = m.report && state.tasks.find((x) => x.id === m.taskId);
    if (t?.result?.text) m.report = { title: t.title, ...parseReport(t.result.text) };
  }
  // 发布网页功能上线前，agent 把整页 HTML 贴在了回复里：补发布成网站，挂到那条结果消息上。
  for (const t of state.tasks) {
    if (t.status !== 'done' || !t.result?.text || t.result.sites?.length) continue;
    t.result = rescueHtmlSite(t.result, t.title);
    const m = t.result.sites?.length && state.messages.findLast((x) => x.role === 'bot' && x.taskId === t.id);
    if (m && !m.sites?.length) m.sites = t.result.sites;
  }
  save();
});
const newId = (p) => `${p}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
// 喵团简历上的累计数据：任务、报告用计数器（state.tasks 只留最近 80 个）；第一次启用时按现有数据起个头
state.stats ||= {
  tasksDone: state.tasks.filter((t) => t.status === 'done' && t.kind !== 'goal').length,
  reports: state.messages.filter((m) => m.report).length,
  since: [...state.tasks.map((t) => t.createdAt), ...state.messages.map((m) => m.at)].filter(Boolean).sort()[0] || new Date().toISOString(),
};
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFileSync(STATE_FILE, JSON.stringify({
    // 每个聊天最多留最近 300 条
    messages: state.chats.flatMap((c) => state.messages.filter((m) => m.chatId === c.id).slice(-300)),
    chats: state.chats, currentChat: state.currentChat, stats: state.stats,
    tasks: state.tasks.slice(-80), goals: state.goals, goalsInit: state.goalsInit, location: state.location,
  })), 200);
}

const clients = new Set();
function broadcast(ev) {
  const frame = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(frame);
}

// 消息默认进当前聊天；任务结果带着 chatId 回到派它的那个聊天。那个聊天已经删了就不发（结果在「任务」里还能看）。
function addMessage(m) {
  const msg = { id: newId('m'), at: new Date().toISOString(), chatId: state.currentChat, ...m };
  const chat = state.chats.find((c) => c.id === msg.chatId);
  if (!chat) return null;
  state.messages.push(msg);
  chat.updatedAt = msg.at;
  if (chat.title === NEW_CHAT_TITLE && msg.role === 'me' && msg.text) chat.title = msg.text.replace(/\s+/g, ' ').slice(0, 20);
  save();
  broadcast({ type: 'message', message: msg });
  return msg;
}

// ---------- 聊天：可以开新聊天、删旧聊天；后台任务、目标、记账、网站是所有聊天共用的 ----------
const WELCOME = '嗨～我是喵团，你的私人助理 🐱 查资料、找附近好去处、做网页、记账、帮你盯着关心的事，都可以交给我～';
const NEW_CHAT_TITLE = '新聊天';
state.chats ||= [];

function newChat() {
  const at = new Date().toISOString();
  const chat = { id: newId('c'), title: NEW_CHAT_TITLE, createdAt: at, updatedAt: at };
  state.chats.push(chat);
  state.currentChat = chat.id;
  addMessage({ role: 'bot', text: WELCOME });
  return chat;
}

// 聊天列表：最近用过的在前，带最后一条消息预览。q：搜标题和所有消息内容，预览换成命中的那句话。
function chatList(q = '') {
  const needle = String(q).trim().toLowerCase();
  const flat = (t) => String(t || '').replace(/\s+/g, ' ');
  return state.chats.map((c) => {
    const msgs = state.messages.filter((m) => m.chatId === c.id);
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
  if (state.chats.length) state.currentChat = chatList()[0].id; else newChat();
}

// ---------- LongCat（调度者用，直连，不带工具） ----------
// JS 的 .slice() 按 UTF-16 截字符串，可能把 emoji 切成半个（孤立代理项）。Hermes（Python）存库时会因此报错、把任务标成失败，
// 所以发给 Hermes / LongCat 的请求体统一清掉半个字符。
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const cleanStrings = (_, v) => (typeof v === 'string' ? v.replace(LONE_SURROGATE, '') : v);

async function longcat(system, user, maxTokens = 600, { json = false } = {}) {
  const call = () => fetch(LONGCAT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${LONGCAT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: DISPATCH_MODEL, max_tokens: maxTokens, thinking: { type: 'disabled' },
      ...(json && { response_format: { type: 'json_object' } }),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }, cleanStrings),
    signal: AbortSignal.timeout(60_000),
  });
  // 代理/网络偶尔抖一下会直接 "fetch failed"（连接没建立），隔一秒重试一次。
  const r = await call().catch(async (e) => {
    if (e.name === 'TimeoutError') throw e;
    console.error('[longcat] 重试：', e.message, e.cause?.code || '');
    await new Promise((ok) => setTimeout(ok, 1000));
    return call();
  });
  if (!r.ok) throw new Error(`LongCat ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return ((await r.json()).choices?.[0]?.message?.content || '').trim();
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

const DISPATCHER_SYSTEM = `你是「喵团」的前台，用户的朋友，像朋友发微信一样聊天。
- 回复要短：通常 1 句，最多 2 句；口语化，可以带语气词或颜文字；不用列表、不用 markdown，不解释你怎么做。
- 后台执行 agent 能做的事：上网搜索、读网页、深度调研写报告；做网页；读微博 / X / Instagram / Weverse / B 站 / 小红书上任何公开账号（品牌、机构、博主、个人公开主页都行，关不关注都能读）；按关键词搜小红书笔记（附近美食、店铺、景点、攻略、打卡地……问「附近」时结合【用户位置】）；搜图片；识别图片；查天气等实用信息（缺技能会自己装）；记账查账；记住用户偏好。不要对用户说「看不了这个账号」「搜不了附近」这类话；平台没登录时，就让用户去「+」→「社媒账号」登录。
- 你自己不能上网、不能搜图、不能看社媒账号、不能记东西、不能看图片内容。凡是需要这些的（查资料、查天气、找图、搜小红书、找附近的吃喝玩乐、关注/取关或查看公开账号、记住偏好、识别用户发的图、查动态），派一个后台任务给执行 agent，reply 里只简短说你去办了，比如「好嘞，我去查查～」。
- 做网页：执行 agent 能把内容做成一个网页（可视化网站、导游图、攻略页、对比表、清单、行程、H5 小页面），做好后聊天里会出现网站卡片，用户在 App 里点开就能看。用户要网站/网页/可视化时派任务，brief 写清楚内容、用途和想要的样子；内容还要查的，把要查什么也写进 brief，让执行 agent 查完再做。要改【网站】里已有的网站时，brief 里写上它的 id。
- 闲聊、情绪回应、问任务进度：直接回复，不派任务。问进度时根据【后台任务】回答。
- 同一件事已经有任务在跑或排队，就不要重复派。
- 改任务（steer）：用户是在对【后台任务】里某个排队中、进行中或刚结束的任务提修改（「不要…」「换成…」「再加上…」「这个不好」「改成…」「重做一下」「顺便也…」），写 steer，不要派新任务：task_id 填那个任务的 id，instruction 写清楚要怎么改（完整、脱离聊天也能看懂），只写用户这次说的修改，不要自己添加用户没提的要求（比如用户没说就别加「做成网站」）。进行中的会被插话调整，做完的会在原任务上接着改一轮。reply 简短说你让它改了，比如「收到，让它换成真地图，不用重来～」。分不清改的是哪个任务就先问一句，不写 steer。明显是另一件新事，或者是很久以前的老任务，才派新任务。目标检查（·目标检查）不能 steer。
- 停止（stop）：用户说「别弄了」「不用了」「先停一下」时，stop 填那个排队中或进行中任务的 id；reply 简短确认。
- 平台登录：X / Instagram / Weverse / 小红书 要用户先在「+」→「社媒账号」点「登录」、在弹出的窗口里自己登录。用户要看这些平台的内容、而【平台登录】显示它未登录时，不派任务，reply 直接引导，比如「X 还没登录哦，去「+」→「社媒账号」点「登录 X」，在弹出的窗口里自己登一下（建议小号），好了再叫我～」。
- brief 写给执行 agent，要完整、能独立执行：做什么、涉及的人或事物（中文名/外文名）、时间范围、地点、用户偏好；找图时写上要避开已经展示过的图（给出 id）。
- 记账：用户说了一笔收支（如「午饭35」「打车 22 块」「发工资 8000」），直接写进 ledger，reply 简短确认（如「记好啦，午饭 ¥35」），不派任务。查账、分析消费、设预算这类派任务（执行 agent 有记账工具和记账记忆）。
- 位置：【用户位置】是用户在 App 里共享的大致位置。用户问「我在哪」「附近」「这边」时以它为准，派任务时把位置写进 brief；没共享时，简短提醒用户可以在「+」→「位置」里共享，不要猜他在哪。
- 深度搜索：用户要你全面查清楚、调研、对比、找资料或找途径（不是一两句就能答的事），task 里写 "research": true；brief 写清楚要回答的问题、范围和希望得到的结论。reply 说一句你去深挖一下。
- 版权：用户要免费下载或看付费内容（杂志、书、课程、影视的 PDF、网盘资源、破解版）时，照样派深度搜索，但 brief 写明「只找合法的免费或低价途径（图书馆数字资源、官方免费内容、正版优惠），不找盗版下载链接」；reply 里轻松说一句盗版链接不帮找，但会帮他找合法免费看的办法。
- 目标：用户想长期持续关注某件事（「帮我盯着…」「以后每天…」「有新的就告诉我」），建一个 goal，它会定期自动检查，有新进展时会主动告诉用户；reply 简短说你会一直盯着。schedule 用 {"every": 分钟数} 或 {"at": "HH:MM"}，没说频率就 {"every": 360}。【目标】里已有同类目标就不要重复建。
只输出一个 JSON，没有的字段填 null：
{"reply": "...", "task": {"title": "不超过 12 个字", "brief": "...", "research": false}, "steer": {"task_id": "t_xxx", "instruction": "..."}, "stop": "t_xxx", "goal": {"title": "不超过 12 个字", "brief": "每次检查做什么、关注谁、什么算新进展", "schedule": {"every": 360}}, "ledger": [{"type": "expense 或 income", "amount": 35, "category": "餐饮", "note": "午饭", "date": null}], "ledger_delete": ["l_xxx"]}
ledger 的 date 默认填 null（表示今天），只有用户明确说了别的日子（如「昨天」）才按【现在】换算成 YYYY-MM-DD。
ledger 只写【用户新消息】里新说的收支；【今日账目】里已有的、聊天记录里之前提过的都不要再写，否则会重复记账。
删账：用户明确要删某几笔（或对你「要删掉吗」回答肯定）时，在 ledger_delete 里填【今日账目】中对应的 id 数组；不确定是哪笔就先问。没有就填 null。
支出分类：餐饮、交通、购物、娱乐、旅行、居住、医疗、学习、人情、其他；收入分类：工资、副业、红包、其他。`;

const COMPLETION_SYSTEM = `你是「喵团」的前台，用户的私人助理。后台任务刚结束，像真人发微信一样把结果告诉用户。
- 直接给信息：结论、名字、数字、价格、时间、下一步。不说客套和过渡（「搞定啦」「帮你查好了」「希望对你有帮助」），不复述用户的问题，不说「点下面的卡片」「详情见报告」这类指引——图片、网站、研究报告会自动附在消息下面。
- 每条消息一句话，尽量 25 字以内，最长 40 字；口语化，不用 markdown、列表、序号，表情最多一个。
- 默认只发 1 条；一条说不下才拆成 2–3 条，每条只讲一件事，按重要性排。最多 3 条。
- 研究报告：只说最关键的结论（推荐哪个、答案是什么、最要注意的一点），细节都在报告里，不要逐条复述。
- 网站：一句说做好了，加一个亮点；不要说附件、文件、下载、代码、用浏览器打开。
- 结果里说某个平台需要登录（或被风控）时，一定要说去「+」→「社媒账号」点「登录 X」（换成对应平台），这句不能省。
- 失败：一句说没弄成和原因（说人话，不贴报错），一句下一步建议。
- 不要提 id、GALLERY、工具名、执行 agent。
只输出 JSON：{"messages": ["第一条", "第二条"]}`;

// 前台转述：1–3 条短消息（一条说不下才拆开）
async function sayResult(prompt, fallback) {
  try {
    const out = parseJsonLoose(await longcat(COMPLETION_SYSTEM, prompt, 300, { json: true }));
    const parts = (Array.isArray(out?.messages) ? out.messages : [out?.reply ?? out?.text])
      .map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 3);
    if (parts.length) return parts;
  } catch (e) { console.error('[say]', e.message); }
  return [fallback];
}

const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));
// 一条一条发，中间停一下像在打字。first / last：只挂在第一条 / 最后一条上的字段；all：每条都带。
async function sendParts(items, { first = {}, last = {}, all = {} } = {}) {
  for (const [i, it] of items.entries()) {
    if (i) await pause(it.text ? 500 + Math.min(1500, it.text.length * 45) : 400);
    addMessage({ role: 'bot', ...all, ...it, ...(i === 0 ? first : {}), ...(i === items.length - 1 ? last : {}) });
  }
}

const statusLabel = { queued: '排队中', running: '进行中', done: '已完成', failed: '失败', stopped: '已停止' };
const PLATFORM_LABEL = { weibo: '微博', x: 'X', instagram: 'Instagram', weverse: 'Weverse', bilibili: 'B 站', xiaohongshu: '小红书' };
const secsSince = (iso) => Math.round((Date.now() - Date.parse(iso)) / 1000);
const nowText = () => new Date().toLocaleString('zh-CN', { hour12: false, weekday: 'short' });

function dispatcherContext() {
  let profile = '';
  try { profile = fs.readFileSync(path.join(HERMES_HOME, 'memories/USER.md'), 'utf8').split(/\n?§\n?/).map((s) => s.trim()).filter(Boolean).join('；'); } catch {}
  const follows = readJson(path.join(HERMES_HOME, 'official_accounts.json'), [])
    .map((a) => `${a.name}（${PLATFORM_LABEL[a.platform || 'weibo'] || a.platform}${a.idol ? `·${a.idol}` : ''}）`).join('、');
  const logins = (sandboxSessions?.platforms || []).filter((p) => p.canLogin)
    .map((p) => `${p.label}${p.loggedIn ? '已登录' : p.needsLogin ? '未登录' : '未登录（可免登录读）'}`).join('、');
  const tasks = state.tasks.slice(-8).map((t) => {
    const step = t.steps?.at(-1)?.label;
    const when = t.status === 'running' ? `（已 ${secsSince(t.startedAt)} 秒${step ? `，在${step}` : ''}）`
      : t.endedAt ? `（${agoText(Date.now() - Date.parse(t.endedAt))}结束）` : '';
    return `- ${t.id} [${statusLabel[t.status]}${t.kind === 'goal' ? '·目标检查' : ''}${t.round > 1 ? `·第 ${t.round} 轮` : ''}] ${t.title}${when}：${t.brief.replace(/\s+/g, ' ').slice(0, 60)}`;
  }).join('\n');
  const history = state.messages.filter((m) => m.chatId === state.currentChat).slice(-15, -1).map((m) => `${m.role === 'me' ? '用户' : '喵团'}：${m.text || ''}`
    + (m.images?.length ? '（发了图片）' : '') + (m.photos?.length ? `（附图 ${m.photos.length} 张，id：${m.photos.map((p) => p.id).join(',')}）` : '')
    + (m.goalId && m.taskId ? '（来自目标）' : '') + (m.report ? `（发了研究报告：${m.report.title}）` : '')).join('\n');
  const goals = state.goals.map((g) => `- ${g.title}（${scheduleLabel(g.schedule)}${g.enabled ? '' : '，已暂停'}）：${g.status?.text || ''}`).join('\n');
  const s = ledgerSummary();
  const todayEntries = readLedger().filter((e) => e.date === today()).slice(-30)
    .map((e) => `\n- ${e.id}：${e.note || e.category} ${e.type === 'income' ? '+' : '-'}${money(e.amount)}（${e.category}）`).join('');
  return `【现在】${nowText()}\n【用户画像】${profile || '（还不知道）'}\n【用户位置】${locationLine() || '（没共享）'}\n【已关注账号】${follows || '（无）'}`
    + (logins ? `\n【平台登录】微博免登录；${logins}` : '') + `\n【目标】\n${goals || '（无）'}`
    + `\n【记账】本月支出 ${money(s.expense)}，收入 ${money(s.income)}，今天支出 ${money(s.todayExpense)}`
    + `\n【今日账目】${todayEntries || '（无）'}`
    + `\n【网站】${listSites().slice(0, 5).map((x) => `\n- ${x.id}：${x.title}（第 ${x.version} 版）`).join('') || '（无）'}`
    + `\n【后台任务】\n${tasks || '（无）'}\n【最近聊天】\n${history || '（无）'}`;
}

async function dispatch(text, imageCount) {
  await sandbox('/sessions', 1_500).catch(() => {}); // 刷新【平台登录】；沙箱没开就沿用上次的
  const raw = await longcat(DISPATCHER_SYSTEM,
    `${dispatcherContext()}\n\n【用户新消息】${text || '（只发了图）'}${imageCount ? `（附带 ${imageCount} 张图片）` : ''}\n\n只输出 JSON。`, 600, { json: true });
  let out;
  // 解析不了时，至少把 reply 那句话抠出来，别把一串 JSON 发给用户。
  out = parseJsonLoose(raw) || { reply: /"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)?.[1] || '收到～', task: null };
  // steer / stop 只认【后台任务】里真有的任务；改任务时就不再派新任务。
  const steerOf = state.tasks.find((t) => t.id === out.steer?.task_id && t.kind !== 'goal');
  const steer = steerOf && String(out.steer.instruction || '').trim() ? { task: steerOf, instruction: String(out.steer.instruction).trim() } : null;
  const stop = state.tasks.find((t) => t.id === out.stop && ['running', 'queued'].includes(t.status)) || null;
  if (steer || stop) out.task = null;
  if (imageCount && !out.task && !steer) {
    // 调度者看不到图，带图的消息一律交给执行 agent。
    out.task = { title: '看看你发的图', brief: `用户发来 ${imageCount} 张图片，并说：「${text || '（没说话）'}」。看懂图里是谁、什么场合，按用户意思处理（比如找同场更多图）。` };
  }
  return {
    reply: String(out.reply || '收到～'),
    task: out.task?.brief ? out.task : null,
    steer,
    stop,
    goal: out.goal?.brief ? out.goal : null,
    ledger: Array.isArray(out.ledger) ? out.ledger : [],
    ledgerDelete: Array.isArray(out.ledger_delete) ? out.ledger_delete.map(String) : [],
  };
}

// ---------- 执行 agent（Hermes） ----------
function hermesFetch(pathname, body) {
  return fetch(HERMES_URL + pathname, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${HERMES_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body, cleanStrings) : undefined,
  });
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
  if (!t.runId) {
    const r = await hermesFetch('/v1/runs', { model: 'hermes-agent', input, session_id: t.sessionId });
    if (!r.ok) throw new Error(`agent ${r.status}: ${(await r.text()).slice(0, 200)}`);
    updateTask(t, { runId: (await r.json()).run_id, lastSeq: -1 });
    if (t.stopRequested) stopRun(t); // 还没拿到 run id 时用户就点了停止
  }
  const res = await fetch(`${HERMES_URL}/v1/runs/${t.runId}/events`, {
    headers: { Authorization: `Bearer ${HERMES_KEY}`, ...(t.lastSeq >= 0 && { 'Last-Event-ID': String(t.lastSeq) }) },
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
      if (Number.isInteger(ev.seq)) { t.lastSeq = ev.seq; save(); }
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
    const site = siteFromToolOutput(c.result);
    if (site) { sites.set(site.id, site); broadcast({ type: 'site', site }); }
    trackResearchResult(t, { call_id: id, output: c.result });
  }
  const s = t.steps.find((x) => x.id === id);
  if (s) s.status = 'done';
  updateTask(t, {});
}

function stopRun(t) {
  return hermesFetch(`/v1/runs/${t.runId}/stop`, {}).catch((e) => console.error('[stop]', e.message));
}


function updateTask(t, patch) {
  Object.assign(t, patch);
  save();
  broadcast({ type: 'task', task: t });
}

function createTask({ title, brief, kind = 'chat', images = [], goalId, chatId }) {
  const t = { id: newId('t'), title: String(title).slice(0, 20), brief, kind, goalId, chatId, images, status: 'queued', steps: [], createdAt: new Date().toISOString() };
  state.tasks.push(t);
  save();
  broadcast({ type: 'task', task: t });
  setImmediate(pump);
  return t;
}

function pump() {
  let running = state.tasks.filter((t) => t.status === 'running').length;
  for (const t of state.tasks.filter((x) => x.status === 'queued')) {
    if (running >= MAX_RUNNING) break;
    running++;
    runTask(t);
  }
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
const SITE_ID = /^s_[0-9a-f]{8}$/;

function readSite(id) {
  if (!SITE_ID.test(id || '')) return null;
  const meta = readJson(path.join(SITES_DIR, id, 'meta.json'), null);
  return meta && { id, title: meta.title || '未命名网站', description: meta.description || '', version: meta.version || 1, createdAt: meta.createdAt, updatedAt: meta.updatedAt || meta.createdAt };
}

function listSites() {
  let ids = [];
  try { ids = fs.readdirSync(SITES_DIR); } catch {}
  return ids.map(readSite).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function siteFromToolOutput(output) {
  const site = toolOutputJson(output)?.site;
  if (site?.id) return readSite(site.id);
  // 经 tool_call 批量转发时结果可能包了一层：在原文里找 "site": {"id": "s_…"}
  const raw = Array.isArray(output) ? output.map((p) => p?.text || '').join('') : String(output ?? '');
  const id = /"site"\s*:\s*\{\s*"id"\s*:\s*"(s_[0-9a-f]{8})"/.exec(raw)?.[1];
  return id ? readSite(id) : null;
}

// 和 site-builder 插件写的格式一样：index.html + meta.json。
function saveSite({ title, html, description = '' }) {
  const id = `s_${crypto.randomBytes(4).toString('hex')}`;
  fs.mkdirSync(path.join(SITES_DIR, id), { recursive: true });
  fs.writeFileSync(path.join(SITES_DIR, id, 'index.html'), html);
  const at = isoNow();
  fs.writeFileSync(path.join(SITES_DIR, id, 'meta.json'), JSON.stringify({ id, title, description, version: 1, createdAt: at, updatedAt: at }, null, 2));
  const site = readSite(id);
  broadcast({ type: 'site', site });
  return site;
}

// agent 偶尔不调 publish_site，直接把整页 HTML 贴在回复里：替它发布，正文里的代码块换成一句话。
function rescueHtmlSite(result, fallbackTitle) {
  if (result.sites?.length) return result;
  const m = /```html\s*\n([\s\S]*?<\/html>)\s*```/i.exec(result.text || '');
  if (!m) return result;
  const title = (/<title>([^<]{1,60})<\/title>/i.exec(m[1])?.[1] || fallbackTitle).trim();
  const site = saveSite({ title, html: m[1] });
  const text = `${result.text.slice(0, m.index)}（网页已发布：${site.title}）${result.text.slice(m.index + m[0].length)}`.trim();
  return { ...result, text, sites: [site] };
}

const outputRule = (t) => (t.kind === 'research'
  ? '最后按 deep-research 的报告格式输出：先单独一行写 REPORT:，下面是完整报告，末尾必须有 SOURCES: 列表。'
  : '做完后输出：结果要点（不超过 300 字，重要事实写清楚）；如有图片，最后单独一行 GALLERY: id1,id2,...');

function firstPrompt(t) {
  const where = locationLine();
  return `【后台任务：${t.title}】（现在是 ${nowText()}，任务编号：${t.id}）\n${t.brief}`
    // /v1/runs 不收图片：给本地路径，让 agent 自己用 vision_analyze 看
    + (t.images.length ? `\n\n用户发来的图片（本地文件，用 vision_analyze 看，image_url 填路径）：\n${t.images.map((u) => path.join(UPLOAD_DIR, path.basename(u))).join('\n')}` : '')
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
  try {
    r = await runRound(t, t.round > 1 ? revisionPrompt(t) : firstPrompt(t));
  } catch (e) {
    r = { error: e.message };
  }
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
    const result = rescueHtmlSite(r, t.title);
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
      if (t.kind !== 'goal') state.stats.tasksDone++;
      updateTask(t, { status: 'done', endedAt: isoNow(), runId: undefined, result, asks: undefined });
      deliver(t).catch((e) => console.error('[deliver]', e.message));
    }
  }
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
      const r = await hermesFetch(`/v1/runs/${t.runId}/steer`, {
        input: `用户中途补充了要求：${text}\n在已经做的基础上按这个调整，不用从头再来。`,
      }).catch(() => null);
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
  const photos = t.result?.photos || [];
  const sites = t.result?.sites || [];
  const report = t.kind === 'research' && t.status === 'done' ? parseReport(t.result.text) : null;
  const body = report?.body || t.result?.text || '（无文字）';
  // 中途插话或做完后改过要求：告诉转述的模型以修改后的为准（任务标题还是最初那个）
  const asks = (t.revisions || []).filter((v) => v.round === (t.round || 1) && ['delivered', 'round'].includes(v.state)).map((v) => v.text);
  const redo = asks.length ? `（用户${t.round > 1 ? `看了结果后要求修改，这是第 ${t.round} 轮` : '中途改了要求'}：${asks.join('；')}。以修改后的要求为准，标题里的旧说法不算）` : '';
  const parts = await sayResult(t.status === 'done'
    ? `现在是 ${nowText()}\n任务：${t.title}${redo}\n${report?.body ? '研究报告（会单独附上）' : '结果'}：${body.slice(0, 2000)}\n附图：${photos.length} 张`
      + (sites.length ? `\n网站：${sites.map((s) => `「${s.title}」`).join('、')}（已发布，会附上网站卡片）` : '')
    : `任务：${t.title}\n失败了，原因：${t.error}`,
  t.status === 'done' ? (body.split('\n').find((l) => l.trim()) || '弄好了').slice(0, 60) : '这次没弄成，等下再试试？');
  // 研究报告单独一条（只有报告卡片）；没有报告时，图和网站挂在最后一条文字上。任务来源、用时挂在最后一条。
  const attach = { ...(photos.length && { photos }), ...(sites.length && { sites }) };
  const items = parts.map((text) => ({ text }));
  if (report?.body) { items.push({ text: '', report: { title: t.title, ...report }, ...attach }); state.stats.reports++; }
  else Object.assign(items.at(-1), attach);
  await sendParts(items, {
    all: { partOf: t.id, ...(t.chatId && { chatId: t.chatId }) },
    last: { taskId: t.id, round: t.round || 1, took: roundSecs(t) },
  });
}

// ---------- 目标（仿 Muse Goal）：定期检查，有新进展才在聊天里说 ----------
const isoNow = () => new Date().toISOString();
const scheduleLabel = (s) => (s?.at ? `每天 ${s.at}` : s?.every >= 60 ? `每 ${+(s.every / 60).toFixed(1)} 小时` : `每 ${s?.every} 分钟`);

function normalizeSchedule(s) {
  if (typeof s?.at === 'string' && /^\d{1,2}:\d{2}$/.test(s.at)) return { at: s.at.padStart(5, '0') };
  const every = Number(s?.every ?? s?.every_minutes);
  return { every: Number.isFinite(every) && every >= 15 ? Math.round(every) : 360 };
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
  save();
  broadcast({ type: 'goal', goal: g });
}

function createGoal({ title, brief, schedule, kind = 'general', createdBy = 'user', runNow = true }) {
  const sched = normalizeSchedule(schedule);
  const g = {
    id: newId('g'), title: String(title).slice(0, 20), brief, kind, createdBy, schedule: sched, enabled: true,
    createdAt: isoNow(), status: { text: runNow ? '马上开始第一次检查' : `等待第一次检查（${scheduleLabel(sched)}）`, at: isoNow() },
    seen: [], nextRunAt: runNow ? isoNow() : nextRun(sched),
  };
  state.goals.push(g);
  saveGoal(g);
  if (runNow) runGoal(g);
  return g;
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
如果 NEW: yes，接着写要点（不超过 200 字）；有图片就在最后单独一行写 GALLERY: id1,id2,...`;
}

function runGoal(g) {
  if (state.tasks.some((t) => t.goalId === g.id && (t.status === 'queued' || t.status === 'running'))) return null;
  g.nextRunAt = nextRun(g.schedule);
  const task = createTask({ title: `目标：${g.title}`, brief: goalBrief(g), kind: 'goal', goalId: g.id });
  g.lastRunAt = isoNow();
  g.status = { ...g.status, checking: true };
  saveGoal(g);
  return task;
}

setInterval(() => {
  for (const g of state.goals) if (g.enabled && Date.parse(g.nextRunAt) <= Date.now()) runGoal(g);
}, 30_000);

async function deliverGoal(t) {
  const g = state.goals.find((x) => x.id === t.goalId);
  if (!g) return;
  if (t.status !== 'done') {
    g.status = { text: `这次检查没成功：${String(t.error || '').slice(0, 30)}`, at: isoNow(), error: true };
    return saveGoal(g);
  }
  const raw = t.result.text || '';
  const status = /STATUS[:：]\s*(.+)/i.exec(raw)?.[1]?.trim();
  const isNew = /NEW[:：]\s*(yes|是|true)/i.test(raw);
  const body = raw.replace(/^.*STATUS[:：].*$/im, '').replace(/^.*NEW[:：].*$/im, '').trim();
  g.status = { text: (status || body.split('\n')[0] || '已检查，暂无变化').slice(0, 60), at: isoNow() };
  saveGoal(g);
  if (!isNew) return; // 执行 agent 判断没有新进展：只更新状态小字，不打扰用户
  const photos = (t.result.photos || []).filter((p) => !g.seen.includes(p.id));
  g.seen = [...g.seen, ...photos.map((p) => p.id)].slice(-500);
  saveGoal(g);
  const parts = await sayResult(`现在是 ${nowText()}\n这是用户设的持续目标「${g.title}」检查到的新进展，请主动告诉用户（像朋友突然发来消息）。\n最新状态：${g.status.text}\n要点：${body.slice(0, 1500) || '（无）'}\n附图：${photos.length} 张`, g.status.text);
  await sendParts(parts.map((text) => ({ text })), { first: { taskId: t.id, goalId: g.id }, last: { ...(photos.length && { photos }) } });
}


// ---------- 记账：与执行 agent 的 ledger 插件共用 hermes-home/ledger/ ----------
const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD（本地时区）
const money = (n) => `¥${(Math.round(n * 100) / 100).toLocaleString('zh-CN')}`;
const readLedger = () => readJson(LEDGER_FILE, []);

function writeLedger(entries) {
  fs.mkdirSync(LEDGER_DIR, { recursive: true });
  const tmp = `${LEDGER_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, LEDGER_FILE);
}

// 只接受最近 60 天内、不晚于今天的日期，防止模型编日期。
function saneDate(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return today();
  const days = (Date.parse(today()) - Date.parse(d)) / 86_400_000;
  return days >= 0 && days <= 60 ? d : today();
}

function addLedgerEntries(items, source) {
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
  writeLedger([...readLedger(), ...clean]); // 写前重新读，避免覆盖执行 agent 同时写入的条目
  onLedgerChange();
  return clean;
}

function ledgerSummary() {
  const month = today().slice(0, 7);
  const inMonth = readLedger().filter((e) => e.date?.startsWith(month));
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

function ensureLedgerGoal() {
  return state.goals.find((g) => g.kind === 'ledger')
    || createGoal({ title: '记账管家', kind: 'ledger', createdBy: 'ai', schedule: { at: '21:30' }, runNow: false, brief: LEDGER_GOAL_BRIEF });
}

// 每次记账后立刻刷新「记账管家」的状态小字（不用等 AI 检查）。
function onLedgerChange() {
  broadcast({ type: 'ledger' });
  const g = ensureLedgerGoal();
  const s = ledgerSummary();
  g.status = { text: `本月支出 ${money(s.expense)} · 今天 ${money(s.todayExpense)}`, at: isoNow() };
  saveGoal(g);
}

const GOAL_SYSTEM = `把用户想持续关注的事整理成一个「目标」，交给会定期执行检查的后台 agent（它能上网搜索和读网页、读各平台公开账号、搜图、查天气等实用信息、看用户记忆、查账记账）。
只输出 JSON：{"title": "不超过 12 个字", "brief": "每次检查要做什么、关注什么（人、事、价格、地点……）、什么算新进展", "schedule": {"every": 分钟数} 或 {"at": "HH:MM"}}
用户没说频率就 {"every": 360}；说「每天」默认 {"at": "09:00"}。`;

async function goalFromText(text) {
  const raw = await longcat(GOAL_SYSTEM, `【现在】${nowText()}\n【用户画像】${dispatcherContext().split('\n')[1] || ''}\n【用户想要的目标】${text}`, 400, { json: true });
  const out = parseJsonLoose(raw) || {};
  if (!out.brief) throw new Error('没理解这个目标');
  return createGoal({ title: out.title || text.slice(0, 12), brief: out.brief, schedule: out.schedule });
}

// ---------- 上传 / 图片代理 ----------
function saveUpload(dataUrl) {
  const m = /^data:image\/[\w+.-]+;base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  const name = `${newId('u')}.jpg`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), Buffer.from(m[1], 'base64'));
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
const FRAMES_DIR = path.join(DATA_DIR, 'frames');
const MAX_KEYFRAMES = 16;
const setSandboxFrames = (on) => fetch(`${SANDBOX_URL}/live/frames?on=${on ? 1 : 0}`).catch(() => {});

// 清掉已经不在任务列表里的回放帧
try {
  const keep = new Set(state.tasks.map((t) => t.id));
  for (const d of fs.readdirSync(FRAMES_DIR)) if (!keep.has(d)) fs.rmSync(path.join(FRAMES_DIR, d), { recursive: true, force: true });
} catch {}

// 沙箱一次只做一件事。一段操作（start…end）属于哪个任务：插件带了任务编号就用它；
// 没带（Hermes 这条调用链不把任务文本传给插件）就看此刻哪个任务正卡在会用沙箱的工具步骤上。
const SANDBOX_TOOLS = new Set(['official_photos', 'official_account', 'xiaohongshu_search', 'deep_web_search', 'read_webpage', 'check_site']);
let liveOwner = null;
function guessLiveTask() {
  return state.tasks.filter((t) => t.status === 'running' && t.steps?.at(-1)?.status === 'running' && SANDBOX_TOOLS.has(t.steps.at(-1).name))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0] || null;
}

function onLiveEvent(ev) {
  if (ev.type === 'start') liveOwner = (ev.task && state.tasks.find((x) => x.id === ev.task)) || guessLiveTask();
  const t = (ev.task && state.tasks.find((x) => x.id === ev.task)) || liveOwner;
  if (ev.type === 'end') liveOwner = null;
  if (!t) return; // 不是 App 任务派的操作（比如调试）不记
  t.browser ||= { actions: [], frames: [], active: false };
  const b = t.browser;
  const at = new Date(ev.at || Date.now()).toISOString();
  if (ev.type === 'start' || ev.type === 'action') {
    if (ev.type === 'start') b.active = true;
    b.actions = [...b.actions, { at, text: ev.text, platform: ev.platform }].slice(-60);
    save();
    broadcast({ type: 'browser', taskId: t.id, active: b.active, action: b.actions.at(-1) });
  } else if (ev.type === 'end') {
    b.active = false;
    save();
    broadcast({ type: 'browser', taskId: t.id, active: false });
  } else if (ev.type === 'frame' && ev.data) {
    if (ev.key) {
      const dir = path.join(FRAMES_DIR, t.id);
      fs.mkdirSync(dir, { recursive: true });
      const name = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}.jpg`;
      fs.writeFileSync(path.join(dir, name), Buffer.from(ev.data, 'base64'));
      b.frames.push({ at, text: ev.text, url: ev.url, src: `/api/frames/${t.id}/${name}` });
      for (const old of b.frames.splice(0, Math.max(0, b.frames.length - MAX_KEYFRAMES))) {
        fs.rmSync(path.join(dir, path.basename(old.src)), { force: true });
      }
      save();
    }
    if (clients.size) broadcast({ type: 'browser-frame', taskId: t.id, url: ev.url, key: !!ev.key, data: ev.data });
  }
}

async function connectLive() {
  try {
    const res = await fetch(`${SANDBOX_URL}/live`);
    if (!res.ok) throw new Error(`live ${res.status}`);
    setSandboxFrames(clients.size > 0);
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
  if (!['http:', 'https:'].includes(url.protocol)) return sendJson(res, 400, { error: 'bad url' });
  const { address } = await dns.lookup(url.hostname);
  if (isPrivateAddress(address)) return sendJson(res, 403, { error: 'forbidden' });
  const headers = { 'User-Agent': UA, Accept: 'image/*' };
  const referer = refererFor(url.hostname);
  if (referer) headers.Referer = referer;
  const upstream = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
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

function locationLine() {
  const loc = state.location;
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

async function setLocation({ lat, lon, accuracy }) {
  lat = Number(lat); lon = Number(lon); accuracy = Math.max(1, Number(accuracy) || 1000);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) throw new Error('坐标不对');
  const prev = state.location;
  // 300 米内没动就沿用上次的地名，少调一次反查（Nominatim 限速每秒 1 次）。
  const place = prev?.label && distanceKm(prev, { lat, lon }) < 0.3 ? prev : await reverseGeocode(lat, lon);
  state.location = {
    lat, lon, accuracy: Math.round(accuracy), at: isoNow(),
    country: place.country || '', province: place.province || '', city: place.city || '', district: place.district || '', suburb: place.suburb || '',
    label: place.label || '',
  };
  save();
  broadcast({ type: 'location', location: state.location });
  return state.location;
}

// ---------- 技能管理：调 Hermes 的 Python 帮忙读写，避免从 Node 手改 config.yaml ----------
const HERMES_PY = path.resolve(APP_DIR, '../hermes-agent/.venv/bin/python');
const SKILLS_ADMIN = path.resolve(APP_DIR, '../scripts/skills_admin.py');
function skillsAdmin(...args) {
  return new Promise((resolve) => {
    execFile(HERMES_PY, [SKILLS_ADMIN, ...args], { env: { ...process.env, HERMES_HOME }, timeout: 30_000, maxBuffer: 4 << 20 },
      (err, stdout) => {
        try { resolve(JSON.parse(stdout.trim().split('\n').pop())); } catch { resolve({ error: err?.message || '技能管理出错了' }); }
      });
  });
}

// ---------- HTTP ----------
async function readBody(req) {
  let raw = '';
  for await (const c of req) raw += c;
  return raw ? JSON.parse(raw) : {};
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // 别的网页（包括 :3211 上 agent 做的网站）不能替用户调 App 的接口：有 Origin 的写请求必须来自 App 自己。
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
    return sendJson(res, 403, { error: 'forbidden origin' });
  }
  try {
    if (url.pathname === '/api/health') {
      const r = await hermesFetch('/v1/models').catch(() => null);
      return sendJson(res, 200, { agent: !!r?.ok });
    }
    if (url.pathname === '/api/state') {
      return sendJson(res, 200, {
        messages: state.messages.filter((m) => m.chatId === state.currentChat).slice(-200), chats: chatList(), currentChat: state.currentChat,
        tasks: state.tasks.slice(-50), goals: state.goals, location: state.location || null, sites: listSites(), sitesPort: SITES_PORT,
      });
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
      clients.add(res);
      if (clients.size === 1) setSandboxFrames(true); // 有人打开 App 了：让沙箱推连续画面
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
        if (!clients.size) setSandboxFrames(false);
      });
      return;
    }
    if (url.pathname === '/api/message' && req.method === 'POST') {
      const { text = '', images = [] } = await readBody(req);
      const files = images.slice(0, 3).map(saveUpload).filter(Boolean);
      if (!text.trim() && !files.length) return sendJson(res, 400, { error: 'empty' });
      const chatId = state.currentChat; // 调度者回复期间切了聊天，回复和任务也留在发消息的那个聊天
      addMessage({ role: 'me', text: text.trim(), images: files, chatId });
      let d;
      try { d = await dispatch(text.trim(), files.length); } catch (e) {
        console.error('[dispatch]', e.message);
        d = { reply: '我这边网络有点卡，等下再说一次？', task: null, steer: null, stop: null, goal: null, ledger: [], ledgerDelete: [] };
      }
      if (d.ledgerDelete.length) {
        writeLedger(readLedger().filter((e) => !d.ledgerDelete.includes(e.id)));
        onLedgerChange();
      }
      if (d.ledger.length) addLedgerEntries(d.ledger, 'chat');
      const goal = d.goal ? createGoal({ title: d.goal.title || '新目标', brief: d.goal.brief, schedule: d.goal.schedule }) : null;
      const task = d.task ? createTask({ title: d.task.title || '后台任务', brief: d.task.brief, images: files, kind: d.task.research ? 'research' : 'chat', chatId }) : null;
      if (d.stop) stopTask(d.stop);
      const rev = d.steer ? await steerTask(d.steer.task, d.steer.instruction) : null;
      const round = task ? 1 : rev ? rev.round : d.stop ? d.stop.round || 1 : undefined;
      addMessage({ role: 'bot', text: d.reply, taskId: task?.id, goalId: goal?.id, chatId, round,
        ...(d.steer && { steerOf: d.steer.task.id }), ...(d.stop && { stopOf: d.stop.id }) });
      return sendJson(res, 200, { ok: true });
    }
    // ---- 喵团简历上的数字 ----
    if (url.pathname === '/api/profile') {
      return sendJson(res, 200, { ...state.stats, sites: listSites().length, goals: state.goals.length, ledger: readLedger().length, chats: state.chats.length, model: DISPATCH_MODEL });
    }
    // ---- 聊天：新建、切换、删除 ----
    if (url.pathname === '/api/chats' && req.method === 'GET') return sendJson(res, 200, { chats: chatList(url.searchParams.get('q') || ''), currentChat: state.currentChat });
    if (url.pathname === '/api/chats' && req.method === 'POST') {
      // 当前聊天还一句话没说过，就不再开一个空的
      const cur = state.chats.find((c) => c.id === state.currentChat);
      const chat = cur && !state.messages.some((m) => m.chatId === cur.id && m.role === 'me') ? cur : newChat();
      save();
      broadcast({ type: 'chats', currentChat: state.currentChat });
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
          if (state.chats.length) state.currentChat = chatList()[0].id; else newChat();
        }
      } else return sendJson(res, 405, { error: 'method not allowed' });
      save();
      broadcast({ type: 'chats', currentChat: state.currentChat });
      return sendJson(res, 200, { currentChat: state.currentChat });
    }
    // ---- 执行 agent 的工具调用明细（cattuan-bridge 插件推送，用 agent 的 API key 认） ----
    if (url.pathname === '/api/agent/tool' && req.method === 'POST') {
      if (req.headers.authorization !== `Bearer ${HERMES_KEY}`) return sendJson(res, 401, { error: 'unauthorized' });
      onBridgeToolCall(await readBody(req));
      return sendJson(res, 200, { ok: true });
    }
    // ---- 任务：重试（失败/停了的任务点「重试」）、停止、修改 ----
    const taskAction = /^\/api\/tasks\/([\w-]+)\/(retry|stop|steer)$/.exec(url.pathname);
    if (taskAction && req.method === 'POST') {
      const t = state.tasks.find((x) => x.id === taskAction[1]);
      if (!t) return sendJson(res, 404, { error: 'not found' });
      if (taskAction[2] === 'stop') {
        if (!stopTask(t)) return sendJson(res, 409, { error: '这个任务已经结束了' });
        if (t.kind !== 'goal') addMessage({ role: 'bot', text: `好，「${t.title}」先停了～`, stopOf: t.id, round: t.round || 1, ...(t.chatId && { chatId: t.chatId }) });
        return sendJson(res, 200, { ok: true });
      }
      if (taskAction[2] === 'steer') {
        const rev = await steerTask(t, (await readBody(req)).text);
        return rev ? sendJson(res, 200, rev) : sendJson(res, 400, { error: '改不了这个任务' });
      }
      if (t.status !== 'failed' && t.status !== 'stopped') return sendJson(res, 409, { error: '这个任务没失败，不用重试' });
      updateTask(t, { status: 'queued', error: undefined, steps: [], startedAt: undefined, endedAt: undefined, runId: undefined, retried: (t.retried || 0) + 1,
        ...((t.round || 1) === 1 && { result: undefined }) }); // 修改轮重试时保留上一轮结果，修改要求还在 asks 里
      if (t.kind !== 'goal') addMessage({ role: 'bot', text: `重新去办：${t.title}～`, taskId: t.id, round: t.round || 1, ...(t.chatId && { chatId: t.chatId }) });
      pump();
      return sendJson(res, 200, { ok: true });
    }
    // ---- 目标 ----
    if (url.pathname === '/api/goals' && req.method === 'POST') {
      const { text = '' } = await readBody(req);
      if (!text.trim()) return sendJson(res, 400, { error: '说说想让喵团盯着什么' });
      return sendJson(res, 200, await goalFromText(text.trim()));
    }
    const goalMatch = /^\/api\/goals\/([\w-]+)(\/run)?$/.exec(url.pathname);
    if (goalMatch) {
      const g = state.goals.find((x) => x.id === goalMatch[1]);
      if (!g) return sendJson(res, 404, { error: 'not found' });
      if (goalMatch[2] && req.method === 'POST') return sendJson(res, 200, { task: runGoal(g) });
      if (req.method === 'PATCH') {
        const { enabled } = await readBody(req);
        g.enabled = !!enabled;
        if (g.enabled) g.nextRunAt = nextRun(g.schedule);
        saveGoal(g);
        return sendJson(res, 200, g);
      }
      if (req.method === 'DELETE') {
        state.goals = state.goals.filter((x) => x.id !== g.id);
        save();
        broadcast({ type: 'goal-removed', id: g.id });
        return sendJson(res, 200, { ok: true });
      }
    }
    // ---- 记账 ----
    if (url.pathname === '/api/ledger' && req.method === 'GET') {
      const month = today().slice(0, 7);
      let memory = '';
      try { memory = fs.readFileSync(LEDGER_MEMORY, 'utf8'); } catch {}
      const entries = readLedger().filter((e) => e.date?.startsWith(month)).sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));
      return sendJson(res, 200, { summary: ledgerSummary(), entries: entries.slice(0, 100), memory });
    }
    if (url.pathname === '/api/ledger' && req.method === 'POST') {
      const added = addLedgerEntries([await readBody(req)], 'app');
      return added.length ? sendJson(res, 200, added[0]) : sendJson(res, 400, { error: '金额不对' });
    }
    if (url.pathname.startsWith('/api/ledger/') && req.method === 'DELETE') {
      const id = path.basename(url.pathname);
      writeLedger(readLedger().filter((e) => e.id !== id));
      onLedgerChange();
      return sendJson(res, 200, { ok: true });
    }
    // ---- 用户位置 ----
    if (url.pathname === '/api/location' && req.method === 'POST') {
      try { return sendJson(res, 200, await setLocation(await readBody(req))); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (url.pathname === '/api/location' && req.method === 'DELETE') {
      state.location = null;
      save();
      broadcast({ type: 'location', location: null });
      return sendJson(res, 200, { ok: true });
    }
    // ---- 技能（只读展示；装不装由执行 agent 按需决定，见 hermes-home/plugins/skill-store） ----
    if (url.pathname === '/api/skills' && req.method === 'GET') return sendJson(res, 200, await skillsAdmin('list'));
    const skillMatch = /^\/api\/skills\/([\w.-]+)$/.exec(url.pathname);
    if (skillMatch && req.method === 'GET') return sendJson(res, 200, await skillsAdmin('show', skillMatch[1]));
    // ---- 社媒账号备忘录：已关注的账号（执行 agent 的 official_account 维护） ----
    if (url.pathname === '/api/follows') {
      return sendJson(res, 200, readJson(path.join(HERMES_HOME, 'official_accounts.json'), []));
    }
    // ---- 沙箱登录（转发给沙箱的 /sessions、/login、/login/done） ----
    if (url.pathname === '/api/sessions') {
      const r = await sandbox('/sessions').catch(sandboxDown);
      return sendJson(res, r.status, r.body);
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
    if (frameMatch) return serveFile(res, path.join(FRAMES_DIR, frameMatch[1], frameMatch[2]));
    if (url.pathname.startsWith('/api/uploads/')) return serveFile(res, path.join(UPLOAD_DIR, path.basename(url.pathname)));
    if (url.pathname === '/api/img') return await proxyImage(res, url.searchParams.get('u') || '');
    const file = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
    return serveFile(res, file, () => serveFile(res, path.join(PUBLIC_DIR, 'index.html')));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
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
  `img-src 'self' https: data: blob: http://localhost:${PORT} http://127.0.0.1:${PORT}`, // 允许用 App 的图片代理
  "font-src 'self' https: data:",
  "connect-src 'self' https:",
  "media-src 'self' https: data: blob:",
  "frame-src https:",
  "form-action 'self'",
  "base-uri 'self'",
  `frame-ancestors http://localhost:${PORT} http://127.0.0.1:${PORT}`,
].join('; ');

const sitesServer = http.createServer((req, res) => {
  const notFound = () => { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('没有这个网站'); };
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let parts;
  try { parts = decodeURIComponent(new URL(req.url, 'http://x').pathname).split('/').filter(Boolean); } catch { return notFound(); }
  const [id, ...rest] = parts;
  if (!readSite(id)) return notFound();
  if (!rest.length && !req.url.split('?')[0].endsWith('/')) { res.writeHead(301, { Location: `/${id}/` }); return res.end(); }
  const dir = path.join(SITES_DIR, id);
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
sitesServer.listen(SITES_PORT, '127.0.0.1');

server.requestTimeout = 0;
server.listen(PORT, '127.0.0.1', () => {
  const resumed = state.tasks.filter((t) => t.status === 'queued').length;
  console.log(`CatTuan app → http://localhost:${PORT}  (agent ${HERMES_URL}, 网站 :${SITES_PORT}, ${state.goals.length} 个目标${resumed ? `，续跑 ${resumed} 个任务` : ''})`);
  setTimeout(() => {
    for (const t of state.tasks.filter((x) => x.reattach)) { delete t.reattach; runTask(t); }
    pump();
  }, 3_000); // 给 agent 一点启动时间，再接回 / 接着跑重启前没完成的任务
});
