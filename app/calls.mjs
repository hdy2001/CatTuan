// 外呼（替用户打电话）：执行 agent 的 phone_call 工具（app/tools/business.mjs）经 App 的 /api/agent/call 打到这里。
// 现在接的是 Mock 外呼平台：按图灵外呼 / 木星可能返回的所有结果随机挑一个——拨号前被平台拦下、打出去没接通（各种挂断原因）、
// 接通后的各种业务结果；接通的通话转写和问到的信息让 LongCat 按挑中的结果现编。以后换真平台，只换 dial() 这一段。
// 规则在代码里兜底，不靠模型自觉：
//   - 要约的电话（mode=book：会报预约人、会替用户答应）只能在用户点过头的任务里打（task.callMode === 'book'）
//   - 要约的电话必须带齐预约信息：日期、时间、人数，再加品类必填项（美甲要项目……），缺了不拨，告诉 agent 缺什么
//   - 同一个号码每人每天最多打 2 次（平台规则，第 3 次直接拦下）
// 通话记录存在每个人数据目录的 calls.json：聊天里的通话组件、侧边栏「喵团档案 → 电话」里的通话记录都从这里来。
// 调试：CALL_MOCK_OUTCOME=busy 所有电话固定返回某种结果（代码见 OUTCOMES）；写成 01000000001:no_answer|answered,01000000002:busy
// 只固定这几个号码（不影响别的号码），| 隔开的是今天第 1 次、第 2 次打这个号码的结果（测重拨用）。CALL_SPEED=0.2 是快进倍数（模拟的等待 = 通话时长 × 它）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CALL_LINE = '美团专线'; // 拨出线路：外显号码是木星从号码池里挑的、不固定，界面上不显示号码
const AGENT = '喵团'; // 电话里的自称
const MAX_PER_NUMBER = 2;
const SPEED = Number(process.env.CALL_SPEED || 0.2);
// { '*': 'busy' } 或 { '01000000001': 'no_answer|answered' }：键是号码里的数字，'*' 是所有号码
const FORCED = Object.fromEntries(String(process.env.CALL_MOCK_OUTCOME || '').split(',').map((x) => x.trim()).filter(Boolean)
  .map((x) => (x.includes(':') ? [x.split(':')[0].replace(/\D/g, ''), x.split(':')[1].trim()] : ['*', x])));

// 外呼可能返回的所有结果。phase：blocked 拨号前被平台拦下（没打出去）/ ring 打出去没接通 / talk 接通了。
// modes：只在只问不约（ask）或要约（book）的电话里出现，没写就两种都会有。needUser：没答应，要回来问用户。
// retry：soon 马上可以再试 / later 过一阵再打 / tomorrow 明天再打 / rewrite 换个说法再打 / no 别再打了。weight：随机挑的权重。
// platform / release：图灵外呼的错误码、木星的挂断原因码，以后接真平台时对得上。
export const OUTCOMES = [
  { code: 'off_hours', phase: 'blocked', label: '不在外呼时间（8:00–20:00）', platform: 101000, retry: 'later', weight: 2 },
  { code: 'sensitive', phase: 'blocked', label: '话术里有敏感词，被平台拦了', platform: 1014, retry: 'rewrite', weight: 1 },
  { code: 'complaint_risk', phase: 'blocked', label: '对方是易投诉号码，平台不让打', platform: 3004, retry: 'no', weight: 1 },
  { code: 'blacklist', phase: 'blocked', label: '对方号码在黑名单里', platform: 1008, retry: 'no', weight: 1 },
  { code: 'qps', phase: 'blocked', label: '外呼平台繁忙', platform: 1006, retry: 'soon', weight: 1 },
  { code: 'no_line', phase: 'blocked', label: '暂时没有可用的外呼线路', platform: 1009, retry: 'soon', weight: 1 },
  { code: 'duplicate', phase: 'blocked', label: '刚给这个号码发起过，平台判成重复', platform: 1012, retry: 'soon', weight: 1 },
  { code: 'no_answer', phase: 'ring', label: '没人接', release: 7, retry: 'later', weight: 8 },
  { code: 'ring_timeout', phase: 'ring', label: '一直响没人接', release: 14, retry: 'later', weight: 3 },
  { code: 'busy', phase: 'ring', label: '占线', release: 9, retry: 'later', weight: 5 },
  { code: 'power_off', phase: 'ring', label: '对方关机', release: 10, retry: 'later', weight: 2 },
  { code: 'out_of_service', phase: 'ring', label: '对方不在服务区', release: 11, retry: 'later', weight: 2 },
  { code: 'empty_number', phase: 'ring', label: '空号', release: 12, retry: 'no', weight: 2 },
  { code: 'suspended', phase: 'ring', label: '停机', release: 13, retry: 'no', weight: 1 },
  { code: 'voicemail', phase: 'ring', label: '转到了语音信箱', release: 17, retry: 'later', weight: 2 },
  { code: 'line_failure', phase: 'ring', label: '线路故障', release: 16, retry: 'soon', weight: 2 },
  { code: 'hung_up', phase: 'talk', label: '接通就挂了', release: 2, retry: 'no', weight: 3 },
  { code: 'refuse_ai', phase: 'talk', label: '店里不接受 AI 打来的电话', retry: 'no', weight: 3 },
  { code: 'wrong_place', phase: 'talk', label: '打错了，对方不是这家店或者没有这项服务', retry: 'no', weight: 2 },
  { code: 'call_back_later', phase: 'talk', label: '店里正忙，让晚点再打', retry: 'later', weight: 3 },
  { code: 'partial', phase: 'talk', label: '接通了，但只问到一部分，店员说不清', retry: 'later', weight: 3 },
  { code: 'full', phase: 'talk', label: '约满了，也没有别的时间', retry: 'no', weight: 5 },
  { code: 'answered', phase: 'talk', modes: ['ask'], label: '问到了', weight: 30 },
  { code: 'booked', phase: 'talk', modes: ['book'], label: '约上了', weight: 30 },
  { code: 'offer_other_time', phase: 'talk', modes: ['book'], needUser: true, label: '要的时间没位，店里给了别的时间，没答应，回来问用户', weight: 10 },
  { code: 'deposit', phase: 'talk', modes: ['book'], needUser: true, label: '要先交定金（或有最低消费），没答应，回来问用户', weight: 4 },
  { code: 'need_person', phase: 'talk', modes: ['book'], needUser: true, label: '店里要和本人通话，回来问用户', weight: 3 },
];
const FREQ_LIMIT = { code: 'freq_limit', phase: 'blocked', label: `这个号码今天已经打了 ${MAX_PER_NUMBER} 次`, platform: 100001, retry: 'tomorrow' };
const RETRY_HINT = {
  soon: '可以马上再试一次', later: '这次别再打，过一阵可以再打', tomorrow: '今天不能再打这个号码了，明天 8 点后再打，或者换一家',
  rewrite: '换个说法再打', no: '别再打这个号码了',
};

// 要约的电话必须带齐的预约信息：通用的三项 + 品类自己的（details 的键用中文；常见英文键也认）
const NEED_ALWAYS = ['日期', '时间', '人数'];
const NEED_BY_CATEGORY = [
  [/美甲|美睫|美容|理发|美发|按摩|spa|足疗|推拿|养生/i, ['项目']],
  [/网球|羽毛球|篮球|乒乓|球场|场馆/, ['时长', '场地']],
];
const ALIAS = { date: '日期', day: '日期', time: '时间', people: '人数', party_size: '人数', guests: '人数', item: '项目', service: '项目', duration: '时长', court: '场地' };

const digits = (s) => String(s || '').replace(/\D/g, '');
const localDay = (iso) => new Date(iso).toLocaleDateString('sv-SE'); // YYYY-MM-DD（本地时区）
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const shortName = (name) => String(name).replace(/[（(][^）)]*[）)]/g, '').trim() || String(name);

function normalizeDetails(details) {
  const out = {};
  for (const [k, v] of Object.entries(details && typeof details === 'object' ? details : {})) out[ALIAS[k.toLowerCase?.()] || k] = v;
  return out;
}
function missingDetails(category, details) {
  const need = [...NEED_ALWAYS, ...(NEED_BY_CATEGORY.find(([re]) => re.test(category || ''))?.[1] || [])];
  return need.filter((k) => !String(details[k] ?? '').trim());
}

// ---------- 通话记录：每人一个 calls.json（最多留 300 条） ----------
const callsFile = (u) => path.join(u.dir, 'calls.json');
export function listCalls(u) {
  try { return JSON.parse(fs.readFileSync(callsFile(u), 'utf8')); } catch { return []; }
}
function saveCall(u, rec) {
  const list = [...listCalls(u), rec].slice(-300);
  const file = callsFile(u);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(list));
  fs.renameSync(`${file}.tmp`, file);
}
const dialedToday = (u, phone) => listCalls(u).filter((c) => c.status !== 'blocked' && digits(c.phone) === digits(phone) && localDay(c.at) === localDay(Date.now())).length;

// used：今天已经打过这个号码几次（固定结果写了 a|b 时，第 2 次用 b）
function pick(mode, to, used) {
  const seq = String(FORCED[digits(to)] || FORCED['*'] || '').split('|');
  const forced = OUTCOMES.find((o) => o.code === seq[Math.min(used, seq.length - 1)] && (!o.modes || o.modes.includes(mode)));
  if (forced) return forced;
  const pool = OUTCOMES.filter((o) => !o.modes || o.modes.includes(mode));
  let r = Math.random() * pool.reduce((s, o) => s + o.weight, 0);
  for (const o of pool) if ((r -= o.weight) < 0) return o;
  return pool[0];
}

// ---------- 接通后的对话：让 LongCat 按挑中的结果编（演示用的假数据），编不出来就用模板 ----------
const TALK_SYSTEM = `你在给一个演示 App 编一通电话的通话记录（假数据）：AI 助理「${AGENT}」用${CALL_LINE}替用户给商家打电话。
必须按给定的「这通电话的结果」编，不能改结果。只输出 JSON：
{"lines": [{"who": "ai", "text": "…"}, {"who": "shop", "text": "…"}], "answers": {"要问清的事": "问到的答案"}, "summary": "一句话说清结果（给用户看，带上时间、价格这类关键信息）", "booked": {"日期": "", "时间": "", "人数": "", "价格": "", "保留": ""}, "offer": "店里给的替代方案"}
- lines 4–10 句。AI 开口先说明自己是${AGENT}智能助理、替一位顾客打电话；店员说话口语化，像真实的店。
- 只问不约（ask）：AI 不报用户信息、不答应任何事，结尾说顾客确认后再联系。
- 要约（book）：只报「可以告诉商家」里的信息；碰到「回来问用户的情况」不答应，跟店里说确认后回电；约上时挂断前复述日期、时间、项目、人数、价格。
- 价格、空位、营业时间这些细节编得合理；要问清的事问到了就写进 answers，没问到写「没问到」。
- 没约上时 booked 填 null；店里没给替代方案时 offer 填 null。`;

function fallbackTalk(req, o) {
  const hello = `您好，我是${AGENT}智能助理，替一位顾客打电话。${req.goal}`;
  const shopSays = {
    hung_up: '（对方挂断）', refuse_ai: '我们不接受机器打的电话，让本人打过来吧。', wrong_place: '你打错了，我们不是这家。',
    call_back_later: '现在正忙，你晚点再打吧。', partial: '这个我不太清楚，你晚点再问问店长吧。', full: '不好意思，都约满了，最近都没位置。',
    answered: '可以的，有位置，价格到店再看。', booked: '可以，给您约上了，到店报名字就行。', offer_other_time: '那个时间满了，晚一个小时可以吗？',
    deposit: '要先交 100 定金才能留位。', need_person: '这个得顾客本人打过来确认。',
  }[o.code] || '好的。';
  const lines = [{ who: 'ai', text: hello }, { who: 'shop', text: shopSays }];
  if (o.code !== 'hung_up') lines.push({ who: 'ai', text: o.needUser ? '好的，我先跟顾客确认一下，稍后给您回电。' : '好的，谢谢您，再见。' });
  return { lines, answers: {}, summary: o.label, booked: o.code === 'booked' ? normalizeDetails(req.details) : null, offer: null };
}

async function talk(deps, req, o) {
  const prompt = `【打给】${req.name}（${req.to}）\n【品类】${req.category || '没说'}\n【要办的事】${req.goal}`
    + `\n【模式】${req.mode === 'book' ? 'book（可以直接约）' : 'ask（只问不约）'}\n【预约信息】${JSON.stringify(req.details)}`
    + `\n【可以告诉商家】${req.share || '无'}\n【要问清】${(req.questions || []).join('；') || '无'}`
    + `\n【回来问用户的情况】${(req.ask_user_if || []).join('；') || '无'}\n【这通电话的结果】${o.label}`;
  try {
    const out = deps.parseJson(await deps.longcat(TALK_SYSTEM, prompt, 1000, { json: true }));
    const lines = (Array.isArray(out?.lines) ? out.lines : [])
      .map((l) => ({ who: l?.who === 'shop' ? 'shop' : 'ai', text: String(l?.text || '').trim() })).filter((l) => l.text);
    if (lines.length) {
      return { lines, answers: out.answers && typeof out.answers === 'object' ? out.answers : {}, summary: String(out.summary || o.label),
        booked: o.code === 'booked' && out.booked && typeof out.booked === 'object' ? out.booked : null, offer: out.offer ? String(out.offer) : null };
    }
  } catch (e) { console.error('[call] 编通话失败：', e.message); }
  return fallbackTalk(req, o);
}

// ---------- Mock 外呼平台：拨号 → 响铃 → 通话 → 挂断。onStage(stage) 让 App 更新任务上的通话状态 ----------
async function dial(deps, req, o, onStage) {
  if (o.phase === 'blocked') {
    await pause(600);
    return { status: 'blocked', seconds: 0, lines: [], answers: {}, summary: `没打出去：${o.label}`, booked: null, offer: null };
  }
  onStage('dialing');
  const ring = o.phase === 'ring' ? rand(20, 45) : rand(3, 12);
  await pause(clamp(ring * SPEED * 1000, 1500, 8000));
  if (o.phase === 'ring') {
    const label = ['no_answer', 'ring_timeout'].includes(o.code) ? `${o.label}（响了 ${ring} 秒）` : o.label;
    return { status: 'missed', seconds: ring, lines: [], answers: {}, summary: label, booked: null, offer: null };
  }
  onStage('talking');
  const seconds = o.code === 'hung_up' ? rand(3, 8) : rand(30, 110);
  const [conv] = await Promise.all([talk(deps, req, o), pause(clamp(seconds * SPEED * 1000, 2000, 15000))]);
  return { status: 'done', seconds, ...conv };
}

// 不拨的情况（规则拦下，不记通话记录）：告诉 agent 为什么、下一步怎么做
const refuse = (outcome, why, extra = {}) => ({ dialed: false, connected: false, outcome, result: why, need_user: true, retry: 'no', ...extra });

// 打一通电话：按规则检查 → 拨（Mock）→ 记一条通话记录 → 返回给 agent 的结果。
// deps：{ longcat, parseJson }；task：发起这通电话的后台任务（可能没有）；onStage(stage, rec?)：任务上的通话状态跟着变
export async function placeCall(deps, u, task, req, onStage = () => {}) {
  const mode = req.mode === 'book' ? 'book' : 'ask';
  const to = String(req.to || '').trim();
  const name = String(req.name || '').trim() || '对方';
  if (!digits(to)) return refuse('no_number', '没有对方的电话号码：先搜到这家的电话再打');
  if (mode === 'book' && task?.callMode !== 'book') {
    return refuse('need_user_ok', '要约的电话（会报预约人、会替用户答应）得用户先点头。这次别拨：回来把打给谁、约什么说给用户，等他确认');
  }
  const details = normalizeDetails(req.details);
  const missing = mode === 'book' ? missingDetails(req.category, details) : [];
  if (missing.length) return refuse('missing_info', `还缺：${missing.join('、')}。别拨，回来问用户`, { missing });
  const used = dialedToday(u, to);
  const o = used >= MAX_PER_NUMBER ? FREQ_LIMIT : pick(mode, to, used);
  const share = mode === 'book' ? String(req.share || `预约人：${u.name}`) : '';
  const call = { ...req, mode, to, name, details, share };
  const at = new Date().toISOString();
  const rec = { id: `c_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`, taskId: task?.id, round: task?.round || 1,
    at, who: name, short: shortName(name), phone: to, category: req.category || '', mode, agent: AGENT, line: CALL_LINE };
  onStage('queued', rec);
  const r = await dial(deps, call, o, (stage) => onStage(stage, rec));
  Object.assign(rec, r, { outcome: o.code, label: o.label, needUser: !!o.needUser, retry: o.retry || null,
    platform: o.platform || null, release: o.release || null });
  saveCall(u, rec);
  onStage('ended', rec);
  const dialed = r.status !== 'blocked';
  const left = Math.max(0, MAX_PER_NUMBER - used - (dialed ? 1 : 0));
  // 本来可以再打（soon / later），但这个号码今天打满了：改成明天
  const retry = ['soon', 'later'].includes(o.retry) && left < 1 ? 'tomorrow' : o.retry || 'no';
  return {
    call_id: rec.id, dialed, connected: r.status === 'done', outcome: o.code, result: o.label, need_user: !!o.needUser,
    retry, retry_hint: !o.retry ? '' : ['soon', 'later'].includes(retry) ? `${RETRY_HINT[retry]}（这个号码今天还能打 ${left} 次）` : RETRY_HINT[retry],
    calls_left_today: left, summary: r.summary, answers: r.answers, booked: r.booked, offer: r.offer,
    transcript: r.lines.map((l) => `${l.who === 'ai' ? AGENT : '店员'}：${l.text}`).join('\n'),
    line: CALL_LINE, duration_seconds: r.seconds,
  };
}
