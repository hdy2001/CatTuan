// 老数据迁移（scripts/migrate.mjs 调用，App 运行时不用）：把旧格式转成现在的格式，可以重复跑，已经是新格式的原样保留。
//   state.json：消息上的 photos / report / booking → attachments；任务结果里的 GALLERY / REPORT / SOURCES / STATUS 文本标记 → 结构化字段；
//               深度搜索任务（kind: research）→ 普通任务 + deep-research 技能；没接通自动重拨的 redial 目标 → 普通的到点办一次的目标；
//               目标动态的文字 → { type, text }；去掉已删功能的残留（记账、网站卡片、gateway 的 run id）
//   config.yaml：老的工具开关键名（platform_toolsets.api_server……）→ toolsets / disabled_tools，工具集改名
//   .env：去掉每个账号 gateway 的端口和 key（API_SERVER_*）


import { STATE_VERSION } from './store.mjs';

const GALLERY = /`?GALLERY:[^\n]*`?/gi;
const TOOLSET_RENAME = { idol: 'images', deepsearch: 'web', skillstore: 'skills' };
const list = (v) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
const hhmm = (iso) => new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

// 研究报告：正文 + 末尾的「SOURCES:」列表；正文从「REPORT:」那一行之后开始
function parseReport(text) {
  const raw = String(text || '');
  const i = raw.search(/^\s*SOURCES[:：]\s*$/m);
  let body = (i >= 0 ? raw.slice(0, i) : raw).replace(GALLERY, '');
  const marker = body.search(/^\s*REPORT[:：]\s*$/m);
  if (marker >= 0) body = body.slice(marker).replace(/^\s*REPORT[:：]\s*/, '');
  const sources = i < 0 ? [] : raw.slice(i).split('\n').slice(1).map((line) => {
    const m = /^\s*\[(\d+)\]\s*(.*?)\s*\|\s*(https?:\/\/\S+)/.exec(line);
    return m && { n: Number(m[1]), title: m[2].slice(0, 120), url: m[3] };
  }).filter(Boolean);
  return { body: body.trim(), sources };
}

// 老消息上的附件字段 → attachments
function messageAttachments(m) {
  const out = [];
  if (m.photos?.length) out.push({ type: 'images', items: m.photos });
  if (m.report?.body) out.push({ type: 'document', title: m.report.title || '文档', body: m.report.body, sources: m.report.sources || [] });
  if (m.booking?.type === 'ask') { const { type, ...ask } = m.booking; out.push({ type: 'ask', ...ask }); }
  if (m.booking?.type === 'calls' && m.booking.calls?.length) out.push({ type: 'calls', calls: m.booking.calls });
  return out;
}

function migrateMessage(m) {
  const attachments = [...(m.attachments || []), ...messageAttachments(m)];
  const { photos, report, booking, sites, options, steerOf, stopOf, ...rest } = m;
  if (rest.text) rest.text = rest.text.replace(GALLERY, '').trim();
  return attachments.length ? { ...rest, attachments } : rest;
}

// 老任务：结果里的文本标记拆成结构化字段；calls：这个人的通话记录（按 callIds 找回这个任务打的电话）
function migrateTask(t, calls = []) {
  const { runId, lastSeq, reattach, call, callIds, ...task } = t;
  if (task.kind === 'research') Object.assign(task, { kind: 'chat', skills: task.skills || ['deep-research'] });
  for (const h of task.history || []) for (const s of h.steps || []) if (s.name === 'idol_photo_search') s.name = 'image_search';
  const r = task.result;
  if (r && !r.attachments) {
    const attachments = [];
    let text = String(r.text || '');
    if (r.photos?.length) attachments.push({ type: 'images', items: r.photos });
    if (/^\s*(REPORT|SOURCES)[:：]\s*$/m.test(text)) {
      const { body, sources } = parseReport(text);
      attachments.push({ type: 'document', title: task.title, body, sources });
      text = body.split('\n').map((l) => l.trim()).find((l) => l && !/^[#|]/.test(l)) || '';
    }
    if (task.kind === 'goal' && /^\s*STATUS[:：]/im.test(text)) {
      task.check = { status: /STATUS[:：]\s*(.+)/i.exec(text)[1].trim().slice(0, 60), notify: /NEW[:：]\s*(yes|是|true)/i.test(text), done: /DONE[:：]\s*(yes|是|true)/i.test(text) };
      text = text.replace(/^.*(STATUS|NEW|DONE)[:：].*$/gim, '');
    }
    const own = calls.filter((c) => (callIds || []).includes(c.id));
    if (own.length) attachments.push({ type: 'calls', calls: own });
    task.result = { text: text.replace(GALLERY, '').trim(), attachments };
  }
  return task;
}

// 目标动态：老的是一句话，按开头认出是哪一类
export function logEntry(x) {
  if (x?.type) return x;
  const text = String(x?.text || '');
  const type = /^建好目标/.test(text) ? 'created' : /^(检查|重拨)：/.test(text) ? 'check' : /^这次检查没成功/.test(text) ? 'error'
    : text === '暂停' ? 'paused' : text === '继续检查' ? 'resumed' : /^完成/.test(text) ? 'done' : text === '重新开始盯着' ? 'reopened' : 'note';
  const clean = type === 'check' ? text.replace(/^(检查|重拨)：/, '').replace(/（有新进展，告诉你了）$/, '') : type === 'done' ? text.replace(/^完成：?/, '') : text;
  return { at: x.at, type, text: clean, ...(x.task && { task: x.task }), ...(/（有新进展/.test(text) && { notify: true }) };
}

function migrateGoal(g) {
  const { kind, createdBy, calls, fromTask, ...goal } = g;
  if (kind === 'redial' && calls?.length) { // 自动重拨 → 到点办一次的目标，说明里写清要打的电话
    goal.brief = `到点再打一次之前没打通的电话（这是自动重拨，只打这一次，打完告诉用户结果）：\n${calls.map((c) => `- ${c.who}（${hhmm(c.at)} ${c.missed}）phone_call 参数：${JSON.stringify(c.call)}`).join('\n')}`;
  }
  goal.log = (goal.log || []).map(logEntry);
  goal.seen ||= [];
  return goal;
}

export function migrateState(state, { calls = [], newId = () => `c_${Date.now().toString(36)}` } = {}) {
  if (state.version >= STATE_VERSION) return { state, changed: false };
  const s = { messages: [], tasks: [], goals: [], chats: [], ...state };
  s.goals = s.goals.filter((g) => g.kind !== 'ledger').map(migrateGoal);
  s.tasks = s.tasks.map((t) => migrateTask(t, calls));
  s.messages = s.messages.map(migrateMessage);
  // 加聊天功能之前的消息都归到一个聊天里
  if (!s.chats.length && s.messages.length) {
    const first = s.messages[0].at || new Date().toISOString();
    const ask = s.messages.find((m) => m.role === 'me' && m.text);
    const chat = { id: newId(), title: ask ? ask.text.replace(/\s+/g, ' ').slice(0, 20) : '新聊天', createdAt: first, updatedAt: s.messages.at(-1).at || first };
    s.chats.push(chat);
    for (const m of s.messages) m.chatId = chat.id;
    s.currentChat = chat.id;
  }
  s.stats ||= {
    tasksDone: s.tasks.filter((t) => t.status === 'done' && t.kind !== 'goal').length,
    reports: s.messages.filter((m) => m.attachments?.some((a) => a.type === 'document')).length,
    since: [...s.tasks.map((t) => t.createdAt), ...s.messages.map((m) => m.at)].filter(Boolean).sort()[0] || new Date().toISOString(),
  };
  s.version = STATE_VERSION;
  return { state: s, changed: true };
}

// config.yaml（已解析的对象）→ 新键名；没有老键名的原样返回 changed: false
export function migrateConfig(config) {
  const c = { ...(config || {}) };
  const old = c.platform_toolsets || c.agent || c.tools?.api_server || c.skills?.platform_disabled;
  if (!old) return { config: c, changed: false };
  const rename = (names) => [...new Set(names.map((n) => TOOLSET_RENAME[n] || (n === 'idol_photo_search' ? 'image_search' : n)))];
  if (c.platform_toolsets?.api_server) c.toolsets ??= rename(list(c.platform_toolsets.api_server));
  const off = rename([...list(c.agent?.disabled_toolsets), ...list(c.agent?.disabled_tools), ...list(c.tools?.api_server?.disabled), ...list(c.disabled_tools)]);
  if (off.length || c.disabled_tools) c.disabled_tools = off;
  if (c.skills?.platform_disabled) {
    c.skills = { ...c.skills, disabled: [...new Set([...list(c.skills.disabled), ...list(c.skills.platform_disabled.api_server)])] };
    delete c.skills.platform_disabled;
  }
  delete c.platform_toolsets;
  delete c.agent;
  if (c.tools) { delete c.tools.api_server; if (!Object.keys(c.tools).length) delete c.tools; }
  return { config: c, changed: true };
}

// .env 文本：去掉 gateway 的端口和 key
export function migrateEnv(text) {
  const lines = String(text || '').split('\n');
  const kept = lines.filter((l) => !/^\s*(export\s+)?API_SERVER_[A-Z_]+\s*=/.test(l));
  return { text: kept.join('\n'), changed: kept.length !== lines.length };
}
