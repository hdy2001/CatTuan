// 演示脚本：电话预订（Longcat 第一期 PRD）。打开 http://localhost:3210/?mock=booking
// 用假数据把 PRD 的用户故事在喵团里走一遍，给 PRD 截交互图用：不连服务端、不打电话、不写任何数据，刷新就回到 URL 里的那一步。
// 这一期的边界：没接美团搜索，找店只用普通网页搜索（聊天里只有「…」，搜什么在顶栏状态里，回答是纯文字）；
// 不支持结构化预约表单：识别到要打电话后，提醒用户补全预约信息，用提问选项卡（仿 Claude Code）或直接打字回答。
// 聊天参考 Manus 的 Cue：喵团像真人一样发消息，用户打字回；状态变化那条开头带个 emoji（📞 在打 / 没接通，✅ 办成了，⏸️ 要你定）。
// 除了提问选项卡，聊天里只有通话组件：每通电话打完挂在那条消息下面，点开看详情和转写。喵团有自己的电话：侧边栏「喵团档案 → 电话」里是全部通话记录。
// URL 参数：variant=happy|decide|noanswer|query|spa（五种场景）、step=0..N（演到第几步）、clean=1（隐藏控制条和像素小猫）
// 左下角控制条：‹ › 或键盘 ← → 切步骤，H 隐藏 / 显示控制条和小猫。也可以在提问选项卡上选、在输入框里打字往下走。
import { noticeHtml, openCallLog, openCallDetail, closeCallSheet, askOf } from '../ui/cards.js';

const AGENT = '喵团'; // 电话里的自称；PRD 截图要用 Longcat 就改这里
const PHONE_TAIL = '5678'; // 演示账号的手机尾号
const ASK_IF = ['要交定金或有最低消费', '只能约别的时间', '店里要和你本人通话'];

// 演示用的店：名字、电话、地址都是编的。只有普通网页搜索能搜到的东西（店名、地址、电话、营业时间、网上的评价），没有评分 / 距离 / 能否电话预约这类美团数据
const SHOPS = [
  { name: '栗子美甲·日式美睫（和平里店）', short: '栗子美甲', street: '和平里北街', web: '纯色做得细', phone: '010-8xxx-xx21', hours: '10:00–21:00',
    address: '东城区和平里北街 12 号 1 层' },
  { name: '拾光美甲工作室', short: '拾光美甲', street: '和平里中街', web: '离你最近，擅长手绘', phone: '010-6xxx-xx08', hours: '11:00–21:30',
    address: '东城区和平里中街 3 号院' },
  { name: '小满 nail（雍和宫店）', short: '小满 nail', street: '雍和宫大街', web: '款式多，但周末常约满', phone: '010-5xxx-xx66', hours: '10:30–22:00',
    address: '东城区雍和宫大街 88 号 2 层' },
];
const ITEMS = ['纯色', '猫眼', '法式', '卸甲'];
const TIMES = ['13:00', '14:00', '15:00', '16:00'];
// 店里电话里报的价（每位）：用户一般不会主动问，AI 打电话时主动问价格和付款方式（参考千问）
const PRICES = { 纯色: 128, 猫眼: 168, 法式: 158, 卸甲: 40 };

// 五种场景：前四种是约美甲，前三步一样（找店 → 追问 → 说清楚怎么打），之后分岔：要约的等用户回一句再打，只问不约的说完就打；
// 附近 SPA 是另一件事：搜到几家，一家一家打过去问今晚能不能去、有什么项目，问完汇总。title 是聊天标题
const VARIANTS = {
  happy: { label: '顺利：按你要的时间约上', beats: ['find', 'clarify', 'confirm', 'call', 'result', 'cancel'] },
  decide: { label: '时间对不上：回来问你', beats: ['find', 'clarify', 'confirm', 'call', 'decide', 'callback', 'result'] },
  noanswer: { label: '没人接：自动重拨', beats: ['find', 'clarify', 'confirm', 'call', 'redial', 'result'] },
  query: { label: '只问不约：说完就打', beats: ['find', 'clarify', 'confirm', 'asked'] },
  spa: { label: '附近 SPA：连着打几家问问', title: '问问附近 SPA', beats: ['spaFind', 'spa1', 'spa2', 'spa3', 'spaSum'] },
};

// ---------- 时间 ----------
const pad = (n) => String(n).padStart(2, '0');
const addMin = (hm, d) => { const [h, m] = hm.split(':').map(Number); const t = h * 60 + m + d; return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`; };
const NUM = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
const spoken = (hm) => { const [h, m] = hm.split(':').map(Number); return `${h < 12 ? '上午' : h < 18 ? '下午' : '晚上'}${NUM[h > 12 ? h - 12 : h]}点${m === 30 ? '半' : m ? `${m}分` : ''}`; };
const bare = (hm) => spoken(hm).slice(2); // 「三点半」：不带上午 / 下午
const hhmm = (iso) => new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
function tomorrow() {
  const d = new Date(Date.now() + 86_400_000);
  return { label: `${d.getMonth() + 1}月${d.getDate()}日 周${'日一二三四五六'[d.getDay()]}`, spoken: `明天 ${d.getMonth() + 1} 月 ${d.getDate()} 日` };
}

// ---------- 演示状态 ----------
let api; // app.js 给的：S、render()、typing(on)、showView(view)
let variant = 'happy';
let R; // 这一轮：上下文、演到第几步、当前通话任务和它的通话脚本、通话记录
let instant = false; // 跳步时一口气演完：不等、不打字
let busy = false; // 正在一句一句演
let clean = false; // 隐藏控制条和小猫
let seq = 0;
const timers = new Set();

const beats = () => VARIANTS[variant].beats;
const nextId = () => beats()[R.played];
const wait = (ms) => (instant ? Promise.resolve() : new Promise((done) => {
  const t = setTimeout(() => { timers.delete(t); done(); }, ms);
  timers.add(t);
}));
const stamp = () => { R.vt = instant ? R.vt + 25_000 : Math.max(R.vt + 1000, Date.now()); return new Date(R.vt).toISOString(); };

function reset() {
  for (const t of timers) clearTimeout(t);
  timers.clear();
  busy = false;
  api.S.messages.length = 0;
  api.S.tasks.length = 0;
  (api.S.activity ||= []).length = 0;
  api.typing(false);
  hideNotice();
  closeCallSheet();
  api.S.chats[0].title = VARIANTS[variant].title || '约美甲';
  R = { played: 0, vt: Date.now() - 15 * 60_000, calls: [], ctx: { pick: 0, shop: SHOPS[0], item: '纯色', time: '15:00', mode: variant === 'query' ? 'query' : 'execute' } };
}

function derived() {
  const price = PRICES[R.ctx.item] ?? PRICES.纯色; // 一位的价格；默认 1 人，总价同单价
  return { c: R.ctx, day: tomorrow(), price, total: price };
}

// ---------- 消息 ----------
function push(m) { const msg = { id: `mock_${++seq}`, at: stamp(), ...m }; api.S.messages.push(msg); return msg; }
const me = (text) => push({ role: 'me', text });
const bot = (text, extra) => push({ role: 'bot', text, ...extra });
const msgWith = (type) => [...api.S.messages].reverse().find((m) => m.attachments?.some((a) => a.type === type));
const msgOf = (el) => api.S.messages.find((m) => m.id === el.closest('[data-mid]')?.dataset.mid);

// 喵团（主 agent）回一句话：和真的 App 一样 —— 聊天里只显示「…」，做到哪一步在顶栏状态里。
// steps：[文字, 毫秒]，比如 [['想想怎么回', 800], ['上网搜「…」', 1500]]；title 不传就用用户最后说的那句话
async function reply(fn, ms = 800, { steps = [['想想怎么回', ms]], title } = {}) {
  const a = { id: `a_mock_${++seq}`, kind: 'message', replyIn: 'mock', status: 'running', step: '',
    title: title || [...api.S.messages].reverse().find((m) => m.role === 'me')?.text || '回复' };
  api.S.activity.push(a);
  for (const [text, t] of steps) {
    Object.assign(a, { step: text });
    if (!instant) { api.render(); await wait(t); }
  }
  await fn();
  Object.assign(a, { status: 'done', step: '' });
  api.render();
}

// 电话任务做完，喵团转述结果（和真的 App 一样，顶栏显示「写消息…」）
const relay = (t = R.task) => ({ title: `转述「${t.title}」的结果`, steps: [['写消息', 1000]] });

// 一句一句发（像真的 App 那样中间停一下）；前几条带 partOf，只在最后一条下面显示时间
async function botParts(texts, lastExtra = {}) {
  const group = `p_${seq}`;
  for (const [i, text] of texts.entries()) {
    if (i) { api.render(); await wait(500 + Math.min(1500, text.length * 45)); }
    bot(text, i < texts.length - 1 ? { partOf: group } : lastExtra);
  }
}

// 任务说明：后台任务页里看得到 agent 被允许做什么（手机尾号、先回来问的情况只写在这里，聊天里不列）
function briefText() {
  const { c, day } = derived();
  return c.mode === 'query'
    ? `只问不约：问 ${c.shop.name} ${day.label} ${c.time} 能不能做${c.item}（1 人），顺便问价格和付款方式。不留用户信息，不答应任何事。`
    : `打电话预约 ${c.shop.name}（${c.shop.phone}）：${day.label} ${c.time}，${c.item}，1 人（默认）。\n`
      + `可以告诉商家：账号手机尾号 ${PHONE_TAIL}。\n先回来问用户：${ASK_IF.join('；')}。\n`
      + '用户没问也要问清单价、总价和付款方式。\n挂断前复述日期、时间、项目、人数、总价、付款方式和手机尾号。';
}

// ---------- 通话 ----------
const ai = (text) => ({ who: 'ai', text });
const shop = (text) => ({ who: 'shop', text });
const CALLING = '📞 在打了，大概 1–5 分钟，你先忙。'; // 开打时发的那句

// 每种场景的通话：lines 挂断后给的转写，seconds 通话时长
// 用户一般不会主动问价：确认有位后 AI 主动问单价、算总价、问付款方式，挂断前复述时把总价和付款方式一起确认（参考千问）
function callScript(kind) {
  const { c, day, price, total } = derived();
  const t = c.time, alt = addMin(t, 30), alt2 = addMin(t, 60);
  const hello = `您好，我是${AGENT}智能助理，替一位顾客打电话预约。`;
  const ask = `请问明天${spoken(t)}能做${c.item}美甲吗？`;
  const askPrice = [ai(`请问${c.item}多少钱一位？`), shop(`${c.item} ${price} 一位。`),
    ai(`好的，一位一共 ${total} 元。请问是到店付，还是可以微信、支付宝线上付？`), shop('到店付就行，微信、支付宝都可以。')];
  const repeat = (when) => ai(`跟您复述一下：${day.spoken}${spoken(when)}，${c.item}美甲，一位，一共 ${total} 元，到店付，手机尾号 ${PHONE_TAIL}，保留 15 分钟，对吗？`);
  if (kind === 'decide') {
    return { seconds: 52, lines: [ai(hello + ask), shop('明天下午都满了，最早要晚上七点。'),
      ai(`好的。顺便问一下，${c.item}多少钱一位？到店付可以吗？`), shop(`${price} 一位，到店付，微信、支付宝都行。`),
      ai('七点我得先跟顾客确认一下，稍后给您回电，可以吗？'), shop('行，你再打过来。'), ai('好的，谢谢您，再见。')] };
  }
  if (kind === 'callback') {
    return { seconds: 32, booked: '19:00', lines: [ai(`您好，我是刚才打电话的${AGENT}智能助理。顾客确认晚上七点可以，麻烦帮忙约上：${c.item}美甲，一位，手机尾号 ${PHONE_TAIL}。`),
      shop('好的，约上了，七点见，保留 15 分钟。'), repeat('19:00'), shop('对。'), ai('好的，谢谢您，再见。')] };
  }
  if (kind === 'query') {
    return { seconds: 34, free: [alt, alt2], lines: [ai(`您好，我是${AGENT}智能助理，替一位顾客问一下：明天${spoken(t)}能做${c.item}美甲吗？今天先问问，还不预约。`),
      shop(`${bare(t)}满了，${bare(alt)}和${bare(alt2)}还有空。`), ai(`好的。请问${c.item}多少钱一位？是到店付吗？`),
      shop(`${price} 一位，到店付，微信、支付宝也行。`), ai('好的，谢谢您，顾客确认后再联系您。')] };
  }
  return { seconds: 62, booked: t, lines: [ai(hello + ask), shop(`可以，${bare(t)}有位置。`), ...askPrice, ai(`好的，预约人手机尾号 ${PHONE_TAIL}，一位。`),
    shop('好的，给您约上了，到店报手机尾号就行，保留 15 分钟。'), repeat(t), shop('对的。'), ai('好的，谢谢您，再见。')] };
}

// 任务的步骤条（任务页和小电视用）跟着通话阶段走；第一步带上通话状态（和真的 phone_call 工具的 progress 一样），任务页画成通话组件
const STEP = { queued: '排队', dialing: '拨号', talking: '通话中', verifying: '核对结果' };
const ORDER = ['queued', 'dialing', 'talking', 'verifying'];
function syncSteps(t) {
  const s = t.call.stage;
  if (s === 'retry') t.steps = [{ label: '排队', status: 'done' }, { label: '拨号 · 没人接', status: 'done' }, { label: '等待重拨', status: 'running' }];
  else if (s === 'waiting') t.steps = [...ORDER.map((k) => ({ label: STEP[k], status: 'done' })), { label: '等你决定', status: 'running' }];
  else if (s === 'done') t.steps = ORDER.map((k) => ({ label: STEP[k], status: 'done' }));
  else t.steps = ORDER.slice(0, ORDER.indexOf(s) + 1).map((k, i, a) => ({ label: STEP[k], status: i < a.length - 1 ? 'done' : 'running' }));
  t.steps[0].progress = { type: 'call', call: t.call };
}
function setStage(t, stage) { t.call.stage = stage; syncSteps(t); api.render(); }

// 派一通电话：script 是挂断后给的转写和通话时长；to 是打给哪家（默认约美甲选的那家），brief 是任务说明
function newCall(title, script, { to = R.ctx.shop, brief = briefText() } = {}) {
  const at = stamp();
  const t = {
    id: `t_mock_${++seq}`, title, kind: 'chat', status: 'running', createdAt: at, startedAt: at, steps: [], brief,
    // 外呼平台：每个号码每天最多拨 2 次（没人接就 30 分钟后重拨 1 次）；通话加整理结果大约 1–5 分钟
    call: { shop: to.name, short: to.short, phone: to.phone, agent: AGENT, stage: 'queued', lines: [], attempt: 1, maxAttempts: 2, eta: '1–5 分钟内', retryIn: '30 分钟', dialedAt: at },
  };
  R.task = t;
  R.script = script;
  api.S.tasks.push(t);
  syncSteps(t);
  return t;
}

// 拨号、通话：外呼平台挂断后才给转写，通话中只有阶段和计时；通话时长按 8 倍速快进
async function talk(t) {
  setStage(t, 'dialing');
  await wait(1400);
  setStage(t, 'talking');
  await wait(R.script.seconds * 125);
}

// 记一条通话记录（每通电话一条，重拨也算新的一条）：挂到转述那条消息下面成为通话组件，也进「电话」里的通话记录
function logCall(t, summary, { status = 'done', seconds = R.script.seconds } = {}) {
  const rec = { id: `c_mock_${++seq}`, who: t.call.shop, short: t.call.short, phone: t.call.phone, agent: AGENT, at: t.call.dialedAt,
    seconds, status, summary, lines: status === 'done' ? R.script.lines : [] };
  R.calls.push(rec);
  return rec;
}
const callCards = (...recs) => ({ attachments: [{ type: 'calls', calls: recs }] }); // 消息下面挂的通话组件
const NO_ANSWER = { status: 'noanswer', seconds: 40 }; // 没人接：响了 40 秒

// 挂断：补齐转写、任务结束（或停下来等用户决定）
function hangUp(t, { status = 'done', stage = 'done' } = {}) {
  t.call.lines = [...R.script.lines];
  t.call.stage = stage;
  t.status = status;
  t.endedAt = new Date(Date.parse(t.call.dialedAt) + R.script.seconds * 1000).toISOString();
  R.vt = Math.max(R.vt, Date.parse(t.endedAt));
  syncSteps(t);
}

// 通话演完：核对一下，自动进下一步（结果 / 需要你决定）；跳步截图时停在「通话中」
async function finishTalk(t) {
  await talk(t);
  if (instant) return;
  setStage(t, 'verifying');
  await wait(1200);
  return play();
}

// ---------- 附近 SPA：搜到三家，一家一家打过去问今晚能不能去、有什么项目（只问不约，不留用户信息） ----------
// 用户说了「帮我问问」，又是只问不约、不报手机号，所以搜到就直接打，不再问「现在打吗」；要约、要报手机尾号的电话才先问一句。
// 每家一个电话任务：问到的结果各发一条（下面挂这通电话的通话组件），问完再汇总一条。
const SPA_HELLO = `您好，我是${AGENT}智能助理，替一位顾客问一下：今天晚上还能去做 SPA 吗？都有哪些项目？今天先问问，还不预约。`;
const SPAS = [
  { name: '静享 SPA（和平里店）', short: '静享 SPA', street: '和平里北街', phone: '010-6xxx-xx31',
    reply: '今晚能去，营业到 11 点，9 点半前到店都行。全身精油 90 分钟 298，肩颈 45 分钟 158，足疗 60 分钟 138。',
    gist: '9 点半前到店都行，精油 90 分钟 298',
    script: { seconds: 46, lines: [ai(SPA_HELLO), shop('今晚可以，我们营业到十一点，九点半之前到店就行。'), ai('好的。都有哪些项目，大概多少钱？'),
      shop('全身精油九十分钟 298，肩颈四十五分钟 158，足疗六十分钟 138。'), ai('好的，今晚过去要提前预约吗？'),
      shop('今晚人不多，来之前打个电话就行。'), ai('好的，谢谢您，顾客确认后再联系您。')] } },
  { name: '汤泉·足道养生（安贞店）', short: '汤泉足道', street: '安贞桥', phone: '010-8xxx-xx52', script: { seconds: 0, lines: [] } }, // 没人接
  { name: '悦榕轩 SPA（雍和宫店）', short: '悦榕轩', street: '雍和宫大街', phone: '010-5xxx-xx77',
    reply: '今晚 8 点半以后才有位，最好提前 1 小时打电话。泰式 90 分钟 368，精油 60 分钟 268，热石 90 分钟 428。',
    gist: '要 8 点半以后，贵一些',
    script: { seconds: 52, lines: [ai(SPA_HELLO), shop('今晚八点半以前都约满了，八点半以后可以。'), ai('好的。都有哪些项目，大概多少钱？'),
      shop('泰式九十分钟 368，精油六十分钟 268，热石九十分钟 428。'), ai('好的，八点半以后过去要提前预约吗？'),
      shop('最好提前一个小时打个电话。'), ai('好的，谢谢您，顾客确认后再联系您。')] } },
];
const spaCall = (s) => newCall(`电话问问 · ${s.short}`, s.script, {
  to: s, brief: `只问不约：问 ${s.name}（${s.phone}）今晚还能不能去、都有什么项目和价格、要不要提前预约。不留用户信息，不答应任何事。` });

// 打这一通：接通的演完通话再进下一步；没人接的拨一阵子再进下一步。跳步截图停在「通话中」/「拨号」
async function spaRing(t) {
  if (R.script.lines.length) return finishTalk(t);
  setStage(t, 'dialing');
  if (instant) return;
  await wait(2600);
  return play();
}

// 挂断这一家，转述它问到的
async function spaReport() {
  const t = R.task;
  const s = SPAS.find((x) => x.name === t.call.shop);
  if (t.status === 'running') hangUp(t);
  t.result = { text: `问到了：${s.reply}只问不约，没有留用户信息。` };
  const rec = logCall(t, s.reply);
  await reply(() => bot(`✅ ${s.short}：${s.reply}`, callCards(rec)), 800, relay());
}

// ---------- 每一步 ----------
const BEATS = {
  find: {
    label: 'US-01 普通搜索找店',
    user: () => '帮我预定一个美甲店',
    // 这一期没接美团搜索：和真的 App 一样走普通网页搜索，聊天里只有「…」，回答是纯文字，没有店铺卡片
    async run() {
      const [a, b, c] = SHOPS;
      await reply(() => botParts([
        `和平里附近评价不错的有${a.short}（${a.street}）、${b.short}（${b.street}）、${c.short}（${c.street}）。`,
        `网上说${a.short}${a.web}，${b.short}${b.web}，${c.short}${c.web}。`,
        '想约哪家？我可以帮你打电话问。',
      ]), 800, { steps: [['想想怎么回', 900], ['上网搜「和平里 美甲店 推荐」', 1600], ['看搜索结果', 1100], ['组织回答', 1300], ['发消息', 0]] });
    },
  },
  clarify: {
    label: 'US-02 识别要打电话 → 提醒补全预约信息',
    user: () => (R.ctx.pick === 0 ? '第一个吧，帮我问问明天可不可以？' : `就${R.ctx.shop.short}吧，帮我问问明天可不可以？`),
    // 用户自己打字选店：按店名或「第几个」认
    parse(text) {
      const i = SHOPS.findIndex((s, k) => text.includes(s.short.slice(0, 2)) || text.includes(`第${'一二三'[k]}`)); // 「拾光」「小满」「第二个」
      if (i >= 0) { R.ctx.pick = i; R.ctx.shop = SHOPS[i]; }
    },
    // 电话也是普通搜索查到的；缺的预约信息不弹表单，提醒用户补全，给一张提问选项卡（也可以直接打字回答）
    async run() {
      const { c } = derived();
      await reply(() => botParts([
        `${c.shop.short}电话 ${c.shop.phone}，营业到 ${c.shop.hours.split('–')[1]}，可以帮你打过去问。`,
        '打之前还差几个信息：做什么项目、明天几点，问到有空要不要直接帮你约？选一下，或者直接回我就行：',
      ], { attachments: [{
        type: 'ask', cur: 0, answers: {},
        questions: [
          { key: 'item', tab: '项目', label: '做什么项目？', options: ITEMS.map((x) => ({ label: x, value: x })) },
          { key: 'time', tab: '时间', label: '明天几点？', options: TIMES.map((x) => ({ label: spoken(x), value: x })) },
          { key: 'mode', tab: '要不要直接约', label: '问到有空，要直接帮你约吗？', options: [
            { label: '有空就直接约', value: 'execute', hint: '时间对不上会先回来问你' },
            { label: '只问问，先别约', value: 'query', hint: '问完回来告诉你，不留你的信息' },
          ] },
        ],
      }] }), 800, { steps: [['想想怎么回', 900], [`上网搜「${c.shop.short} 电话 营业时间」`, 1400], ['组织回答', 1100], ['发消息', 0]] });
    },
  },
  confirm: {
    label: 'US-03 打之前说清楚',
    user: () => `${R.ctx.item}，${spoken(R.ctx.time)}。${R.ctx.mode === 'query' ? '先只问问，别约' : '有空就直接帮我约'}`,
    // 用户自己打字回答（比如「猫眼，下午三点半，先问问」）：认出项目、时间、只问还是直接约，没说的用默认
    parse(text) {
      R.ctx.item = ITEMS.find((x) => text.includes(x)) || R.ctx.item;
      const m = /(\d{1,2})\s*(?:[:：点]\s*(半|\d{1,2})?)/.exec(text.replace(/[一两二三四五六七八九十]+(?=点)/, (w) => String(NUM.indexOf(w.replace('二', '两')))));
      if (m) {
        let h = Number(m[1]);
        if (h < 12 && (/下午|晚上/.test(text) || h <= 8)) h += 12;
        R.ctx.time = `${pad(h)}:${m[2] === '半' ? '30' : pad(Number(m[2] || 0))}`;
      }
      setMode(/只问|先问|别约|不约/.test(text) ? 'query' : /直接约|就约|帮我约/.test(text) ? 'execute' : R.ctx.mode);
    },
    // 不出确认卡片：像真人一样一句话说清打给谁、办什么、碰到什么先回来问。
    // 要约的（会报手机尾号、会替用户答应）问一句「现在打吗」，等用户回了再打；只问不约的（不留信息、不答应任何事）说完就直接打，和附近 SPA 一样
    async run() {
      const q = msgWith('ask');
      if (q) Object.assign(askOf(q), { answers: { item: R.ctx.item, time: R.ctx.time, mode: R.ctx.mode }, answered: true });
      const { c } = derived();
      if (c.mode === 'query') {
        let t;
        await reply(async () => {
          t = newCall(`电话问问 · ${c.shop.short}`, callScript('query'));
          await botParts([`好，我打给${c.shop.short}问问明天${spoken(c.time)}能不能做${c.item}，顺便问问价格。只问不约，不留你的信息。`, CALLING]);
        }, 800, { steps: [['想想怎么回', 900]] });
        return finishTalk(t);
      }
      await reply(() => bot(`好，我打给${c.shop.short}，约明天${spoken(c.time)}，${c.item} 1 位，价格顺便问清楚。${bare(c.time)}没位置的话我先回来问你。现在打吗？`), 800,
        { steps: [['想想怎么回', 900]] });
    },
  },
  call: {
    label: 'US-04 打电话',
    user: () => '打吧',
    accepts: (text) => !/不|别/.test(text) && /打|好|行|可以|嗯|ok/i.test(text),
    async run() {
      const { c } = derived();
      const t = newCall(`电话预约 · ${c.shop.short}`, callScript(variant === 'decide' ? 'decide' : 'booked'));
      bot(CALLING);
      api.render();
      if (variant !== 'noanswer') return finishTalk(t);
      setStage(t, 'dialing');
      await wait(2600);
      t.call.stage = 'retry';
      syncSteps(t);
      const rec = logCall(t, '响了 40 秒没人接，30 分钟后再打一次。', NO_ANSWER);
      await reply(() => bot('📞 店里没人接，我 30 分钟后再打一次（每家店一天最多打 2 次），有结果告诉你。', callCards(rec)), 800, relay());
    },
  },
  redial: {
    label: 'US-04 30 分钟后自动重拨 1 次',
    async run() {
      const t = R.task;
      R.vt += 30 * 60_000; // 过了 30 分钟
      R.script = callScript('booked');
      Object.assign(t.call, { attempt: 2, lines: [], dialedAt: stamp() });
      t.startedAt = t.call.dialedAt; // 通话计时从这次拨号算，不把中间等的 30 分钟算进去
      return finishTalk(t);
    },
  },
  decide: {
    label: 'US-06 时间对不上，回来问你',
    async run() {
      const t = R.task;
      const { c, price } = derived();
      if (t.status === 'running') hangUp(t, { status: 'waiting', stage: 'waiting' });
      t.result = { text: `店里明天下午都满了，最早 19:00，和用户要的 ${c.time} 对不上，没答应，回来问用户。${c.item} ${price} 元一位，到店付。` };
      const text = `⏸️ 店里说明天下午都满了，最早晚上七点，跟你要的${bare(c.time)}对不上，我没答应。${c.item} ${price} 一位，到店付。要约七点吗？`;
      const rec = logCall(t, `明天下午都满了，最早晚上七点，跟要的${bare(c.time)}对不上，没答应，说好确认后回电。${c.item} ${price} 一位，到店付。`);
      await reply(() => bot(text, callCards(rec)), 800, relay());
      showNotice(text);
    },
  },
  callback: {
    label: '你确认后回拨',
    user: () => '那就约晚上七点吧',
    accepts: (text) => /19|七点|7 ?点/.test(text),
    async run() {
      const prev = R.task;
      Object.assign(prev, { status: 'done' });
      prev.call.stage = 'done';
      syncSteps(prev);
      const t = newCall(`回拨确认 · ${R.ctx.shop.short}`, callScript('callback'));
      await reply(() => bot('📞 好，我再打过去跟店里定晚上七点。'), 500);
      return finishTalk(t);
    },
  },
  result: {
    label: 'US-08/09 告诉结果 + App 外通知',
    async run() {
      const t = R.task, s = R.script;
      const { c, day, total } = derived();
      if (t.status === 'running') hangUp(t);
      const booked = s.booked;
      t.result = { text: `已约好：${day.label} ${booked}，${c.shop.name}，${c.item}，1 人，一共 ${total} 元（到店付），手机尾号 ${PHONE_TAIL}，保留 15 分钟。` };
      const parts = [`✅ ${variant === 'noanswer' ? '第二次打通了，' : ''}约好了！明天${spoken(booked)}，${c.shop.short}，${c.item} 1 位，一共 ${total} 元，到店付。`,
        `到店报手机尾号 ${PHONE_TAIL}，保留 15 分钟。`];
      const rec = logCall(t, `约好了：明天${spoken(booked)}，${c.item} 1 位，一共 ${total} 元，到店付；到店报手机尾号 ${PHONE_TAIL}，保留 15 分钟。`);
      await reply(() => botParts(parts, callCards(rec)), 800, relay());
      showNotice(parts.join(''));
    },
  },
  asked: {
    label: 'US-01 只问不约的结果',
    async run() {
      const t = R.task, s = R.script;
      const { c, price } = derived();
      if (t.status === 'running') hangUp(t);
      const [a, b] = s.free;
      t.result = { text: `问到了：明天 ${c.time} 满了，${a}、${b} 有空；${c.item} ${price} 元一位，到店付。只问不约，没有留用户信息。` };
      const text = `✅ 问到了：明天${bare(c.time)}满了，${bare(a)}和${bare(b)}有空，${c.item} ${price} 一位，到店付。我只问了，没帮你约，要约哪个？`;
      const rec = logCall(t, `明天${bare(c.time)}满了，${bare(a)}和${bare(b)}有空，${c.item} ${price} 一位，到店付。只问了，没约。`);
      await reply(() => bot(text, callCards(rec)), 800, relay());
      showNotice(text);
    },
  },
  cancel: {
    label: 'US-10 按任务的真实状态回答',
    user: () => '帮我取消这个预约',
    async run() {
      const { c } = derived();
      await reply(() => bot(`这个预约店里 ${hhmm(R.task.endedAt)} 电话确认过了，取消要再给${c.shop.short}打个电话说一声，大概 1 分钟。要我现在打吗？`));
    },
  },
  spaFind: {
    label: '附近 SPA：搜到三家，挨个打',
    user: () => '你帮我问问我附近的SPA店今天晚上能不能去，问问有什么服务',
    // 搜附近的店和电话，回一句打算怎么问，就开始打第一家
    async run() {
      const [a, b, c] = SPAS;
      let t;
      await reply(async () => {
        t = spaCall(a);
        await botParts([
          `你附近（和平里）评价不错的 SPA 有三家：${a.short}（${a.street}）、${b.short}（${b.street}）、${c.short}（${c.street}）。`,
          '我挨个打过去问问今晚还能不能去、都有什么项目和价格。只问不约，不留你的信息。',
          `📞 先打给${a.short}，三家大概 10 分钟问完，你先忙。`,
        ]);
      }, 800, { steps: [['想想怎么回', 900], ['上网搜「和平里 SPA 按摩」', 1600], ['看搜索结果', 1100], ['查这三家的电话', 1200], ['发消息', 0]] });
      return spaRing(t);
    },
  },
  spa1: {
    label: '第 1 家问到了，接着打第 2 家',
    async run() {
      await spaReport();
      return spaRing(spaCall(SPAS[1]));
    },
  },
  spa2: {
    label: '第 2 家没人接，先打第 3 家',
    async run() {
      const t = R.task; // 第 2 家：转成「等待重拨」，30 分钟后再打 1 次
      if (t.call.stage !== 'retry') { t.call.stage = 'retry'; syncSteps(t); }
      const [, b, c] = SPAS;
      const rec = logCall(t, '响了 40 秒没人接，30 分钟后再打一次。', NO_ANSWER);
      let next;
      await reply(() => {
        next = spaCall(c);
        bot(`📞 ${b.short}没人接，先打${c.short}，30 分钟后再给${b.short}打一次。`, callCards(rec));
      }, 800, relay(t));
      return spaRing(next);
    },
  },
  spa3: {
    label: '第 3 家问到了',
    async run() {
      await spaReport();
      if (instant) return;
      await wait(1200);
      return play();
    },
  },
  spaSum: {
    label: '问完了，汇总一下',
    async run() {
      const [a, b, c] = SPAS;
      const parts = [`问完了。想早点去就选${a.short}，${a.gist}；${c.short}${c.gist}；${b.short}还没打通，30 分钟后我再试一次。`,
        `想约的话我再打给${a.short}，几点、几个人告诉我就行。`];
      await reply(() => botParts(parts), 800, { title: '汇总三家 SPA 问到的情况', steps: [['看三通电话的结果', 900], ['写消息', 1000]] });
      showNotice(parts[0]);
    },
  },
};

// 演下一步：userText 是用户自己打的字（不传就用脚本里的那句）
const PLACEHOLDER = document.querySelector('#input')?.placeholder || '';

async function play(userText) {
  const id = nextId();
  if (!id) return;
  document.querySelector('#input').placeholder = PLACEHOLDER; // 「其他」改过的提示换回来
  const beat = BEATS[id];
  R.played++;
  syncBar();
  hideNotice();
  closeCallSheet();
  const said = userText ?? beat.user?.();
  if (said) { me(said); api.render(); }
  busy = !instant;
  await beat.run();
  busy = false;
  syncBar();
  api.render();
}

// 跳到第 step 步：从头一口气演完，不等、不打字。
// 先空演一遍量出这几步占了多长时间，再从「现在减去这段时间」开始正式演，让最后一条消息落在现在（通话计时也对得上）。
async function jump(step) {
  const n = Math.max(0, Math.min(step, beats().length));
  instant = true;
  reset();
  const t0 = R.vt;
  for (let i = 0; i < n; i++) await play();
  const span = R.vt - t0;
  reset();
  R.vt = Date.now() - span - 5_000;
  for (let i = 0; i < n; i++) await play();
  instant = false;
  syncBar();
  api.render();
  requestAnimationFrame(() => { const box = document.querySelector('#messages'); box.scrollTop = box.scrollHeight; });
}

function stepForward() {
  if (busy) return jump(R.played + 1); // 正在演：直接跳到下一步演完的样子
  if (nextId()) play();
}

// 输入框发消息：下一步是用户说话触发的就往下演，否则提示怎么继续
function send(text) {
  if (busy) return;
  const beat = BEATS[nextId()];
  if (beat?.user && (!beat.accepts || beat.accepts(text))) { beat.parse?.(text); return play(text); }
  me(text);
  reply(() => bot(beat?.user ? `（演示：这个分支没做，回「${beat.user()}」继续）`
    : beat ? '（演示：按左下角 › 继续）' : '（演示到这里结束。左下角控制条可以重来，或者换一个场景）'));
}

// 只问还是直接约：选了只问不约就切到「只问不约」场景，反过来切回「顺利」
function setMode(mode) {
  if (mode === 'query' && variant !== 'query') variant = 'query';
  if (mode === 'execute' && variant === 'query') variant = 'happy';
  R.ctx.mode = mode;
}

// 提问选项卡：选了就跳到下一个没答的问题；都答完了，按选的往下走（替用户把这句话发出去）
function chooseAsk(m, value) {
  const b = askOf(m);
  if (!b || b.answered || busy || nextId() !== 'confirm') return;
  b.answers = { ...b.answers, [b.questions[b.cur].key]: value };
  const next = b.questions.findIndex((q) => !b.answers[q.key]);
  if (next >= 0) { b.cur = next; api.render(); return; }
  R.ctx.item = b.answers.item;
  R.ctx.time = b.answers.time;
  setMode(b.answers.mode);
  play();
}

// 「其他」：不在选项里的，直接在输入框里说
function askOther() {
  const input = document.querySelector('#input');
  input.placeholder = '比如：猫眼，下午三点半，先问问';
  input.focus();
}

function onClick(e) {
  const call = e.target.closest('[data-call]');
  if (call) return openCall(call.dataset.call);
  if (e.target.closest('[data-open-calls]')) return openCalls();
  const opt = e.target.closest('[data-ask-opt]');
  if (opt) return chooseAsk(msgOf(opt), opt.dataset.askOpt);
  const tab = e.target.closest('[data-ask-tab]');
  if (tab) {
    const m = msgOf(tab);
    if (askOf(m) && !askOf(m).answered) { askOf(m).cur = Number(tab.dataset.askTab); api.render(); }
    return;
  }
  if (e.target.closest('[data-ask-other]')) askOther();
}

// ---------- 喵团的电话（仿 Cue 的个人资料）：侧边栏「喵团档案 → 电话」点开是这一轮演示的通话记录，再点一通看详情和转写 ----------
function openCalls() {
  document.getElementById('drawer').hidden = true; // 从侧边栏点进来的：先收起侧边栏
  openCallLog(R.calls);
}
function openCall(id) {
  const c = R.calls.find((x) => x.id === id);
  if (c) openCallDetail(c);
}

// ---------- App 外通知：像聊天软件的消息通知，标题是这个聊天，内容就是那条消息 ----------
let noticeEl = null;
function showNotice(text) {
  hideNotice();
  noticeEl = document.createElement('button');
  noticeEl.type = 'button';
  noticeEl.className = 'bk-notice';
  noticeEl.innerHTML = noticeHtml({ title: api.S.chats[0].title, body: text });
  noticeEl.addEventListener('click', () => {
    hideNotice();
    api.showView('chat');
    const box = document.querySelector('#messages');
    box.scrollTop = box.scrollHeight;
  });
  document.body.append(noticeEl);
}
function hideNotice() { noticeEl?.remove(); noticeEl = null; }

// ---------- 控制条 ----------
let bar;
function buildBar() {
  bar = document.createElement('div');
  bar.className = 'mockbar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', '演示控制');
  bar.innerHTML = `<b>演示 · 电话预订</b>
    <select aria-label="场景">${Object.entries(VARIANTS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select>
    <button type="button" data-mock="prev" aria-label="上一步" title="上一步（←）">‹</button>
    <span class="mockstep"></span>
    <button type="button" data-mock="next" aria-label="下一步">›</button>
    <button type="button" data-mock="restart">重来</button>
    <button type="button" data-mock="hide" title="隐藏控制条和小猫，方便截图（H 键切换）">隐藏</button>`;
  bar.addEventListener('click', (e) => {
    const act = e.target.closest('[data-mock]')?.dataset.mock;
    if (act === 'prev') jump(R.played - 1);
    else if (act === 'next') stepForward();
    else if (act === 'restart') jump(0);
    else if (act === 'hide') setClean(true);
  });
  bar.querySelector('select').addEventListener('change', (e) => { variant = e.target.value; jump(Math.min(R.played, beats().length)); });
  document.body.append(bar);
}

function syncBar() {
  const list = beats(), cur = BEATS[list[R.played - 1]], nxt = BEATS[list[R.played]];
  bar.querySelector('select').value = variant;
  bar.querySelector('.mockstep').textContent = `${R.played}/${list.length} · ${cur ? cur.label : '开始'}`;
  bar.querySelector('[data-mock="next"]').title = nxt ? `下一步：${nxt.label}（→）` : '已经是最后一步';
  bar.querySelector('[data-mock="prev"]').disabled = R.played === 0;
  bar.querySelector('[data-mock="next"]').disabled = !nxt && !busy;
  history.replaceState(null, '', `?mock=booking&variant=${variant}&step=${R.played}${clean ? '&clean=1' : ''}`);
}

function setClean(on) {
  clean = on;
  document.body.classList.toggle('mock-clean', on);
  syncBar();
}

export function start(a) {
  api = a;
  const p = new URLSearchParams(location.search);
  variant = VARIANTS[p.get('variant')] ? p.get('variant') : 'happy';
  clean = p.get('clean') === '1';
  document.body.classList.toggle('mock-clean', clean);
  buildBar();
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    const ask = /^[1-9]$/.test(e.key) && nextId() === 'confirm' && msgWith('ask');
    if (ask && !askOf(ask).answered) { // 提问选项卡：按数字选（仿 Claude Code）
      const q = askOf(ask).questions[askOf(ask).cur];
      const n = Number(e.key);
      if (n <= q.options.length) chooseAsk(ask, q.options[n - 1].value);
      else if (n === q.options.length + 1) { e.preventDefault(); askOther(); }
      return;
    }
    if (e.key === 'ArrowRight') stepForward();
    else if (e.key === 'ArrowLeft' && R.played > 0) jump(R.played - 1);
    else if (e.key === 'h' || e.key === 'H') setClean(!clean);
  });
  jump(Number(p.get('step')) || 0);
  return { send };
}
