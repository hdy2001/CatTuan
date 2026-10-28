// 木星外呼平台（mt-jupiter-cli call aicall）：拨出去拿到 contactId → 隔一会儿查一次话单（call-record query），
// 话单里没带通话文字就按录音的 deviceId 查一次转写（record-text query）→ 整理成 calls.mjs 要的结果。
// CLI 的 -o json 输出以装好的 CLI 为准（和学城文档的示例不一样）：aicall 是 {"contactId": …}，查询类命令直接是接口的 data，
// 出错是 {"error": {type, message, exitCode}}。电话由服务端的 AI 外呼 Agent 打，这通电话的要求按它写死的格式放进 --media-txt（MEDIA_KEYS），
// 格式不对就不拨，直接告诉 agent 哪一项不对。配置都从 env 读（见 agent-home/.env.example「木星外呼」），鉴权见 cli-auth.mjs。
import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { cliEnv, AuthError } from './cli-auth.mjs';

// 服务端 Agent 要的参数：键和顺序都是写死的，值全是字符串
export const MEDIA_KEYS = ['电话号码', 'merchantName', 'purpose', 'category', 'mode', 'customerNeed', 'rejectedTerms', 'allowedInfo', 'toConfirm', 'pauseCases'];
const REQUIRED = { 电话号码: '电话号码（to）', merchantName: '打给谁（name）', purpose: '要办的事（goal）', category: '品类（category）' };

// 接通以后的结果：模型按转写从这里挑一个。retry 没写就是不用再打；needUser 是店里提了用户没授权的条件，回来问用户
const TALK = {
  answered: { label: '问到了' },
  booked: { label: '约上了' },
  offer_other_time: { label: '要的时间没位，店里给了别的时间，没答应，回来问用户', needUser: true },
  deposit: { label: '要先交定金（或有最低消费），没答应，回来问用户', needUser: true },
  need_person: { label: '店里要和本人通话，回来问用户', needUser: true },
  full: { label: '约满了，也没有别的时间', retry: 'no' },
  call_back_later: { label: '店里正忙，让晚点再打', retry: 'later' },
  partial: { label: '接通了，但只问到一部分', retry: 'later' },
  refuse_ai: { label: '店里不接受 AI 打来的电话', retry: 'no' },
  wrong_place: { label: '打错了，对方不是这家店或者没有这项服务', retry: 'no' },
  hung_up: { label: '接通就挂了', retry: 'no' },
};
const RETRYABLE = /\b(1006|1009|1012)\b|繁忙|没有可用的外显号码|重复/; // 平台忙、暂时没有外显号码、判成重复：马上再试可能就好

const digits = (s) => String(s || '').replace(/\D/g, '');
// 被叫号码：只留数字，去掉国家码（+86 / 0086），CLI 要的是国内号码
const callee = (s) => digits(String(s || '').trim().replace(/^(\+|00)86/, ''));
const items = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x ?? '').trim()).filter(Boolean);
const clock = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }); // YYYY-MM-DD HH:mm:ss，北京时间
const hms = (s) => (/^\d+(:\d+){1,2}$/.test(String(s || '')) ? String(s).split(':').reduce((t, x) => t * 60 + Number(x), 0) : Number(s) || 0);
const num = (v, fallback) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? fallback : Math.max(0, Number(v)));

/** phone_call 的参数 → { media：--media-txt 的对象, missing：缺的必填项 }。没写的可选项填「暂无」 */
export function mediaTxt(req) {
  const details = req.details && typeof req.details === 'object'
    ? Object.entries(req.details).filter(([, v]) => String(v ?? '').trim()).map(([k, v]) => `${k}：${String(v).trim()}`).join('；')
    : String(req.details || '').trim();
  const fields = {
    电话号码: callee(req.to), merchantName: String(req.name || '').trim(), purpose: String(req.goal || '').trim(),
    category: String(req.category || '').trim(), mode: req.mode, customerNeed: details,
    rejectedTerms: items(req.rejected_terms).join('；'), allowedInfo: String(req.share || '').trim(),
    toConfirm: items(req.questions).map((q, i) => `${i + 1}.${q}`).join('；'), pauseCases: items(req.ask_user_if).join('；'),
  };
  const missing = Object.entries(REQUIRED).filter(([k]) => !fields[k]).map(([, v]) => v);
  if (!['ask', 'book'].includes(fields.mode)) missing.push('mode（ask / book）');
  return { media: Object.fromEntries(MEDIA_KEYS.map((k) => [k, fields[k] || '暂无'])), missing };
}

function settings(env) {
  return {
    bin: env.JUPITER_CLI || 'mt-jupiter-cli', target: env.JUPITER_ENV || '',
    tenant: env.JUPITER_TENANT_ID || '', route: env.JUPITER_ROUTE_POINT || '',
    displayNum: env.JUPITER_DISPLAY_NUM || '', numberPool: env.JUPITER_NUMBER_POOL || '',
    pollMs: num(env.JUPITER_POLL_SECONDS, 10) * 1000, waitMs: num(env.JUPITER_RESULT_MINUTES, 10) * 60_000,
  };
}

// 跑一次 CLI（-o json）→ { exit, json, text }。exit：0 成功 / 1 业务错 / 2 参数错 / 3 鉴权失败 / 4 网络错；
// 'missing' 是没装 CLI，'timeout' 是 CLI 自己没在时限内结束。取消时抛出取消原因（CLI 进程被杀掉）
function runCli(s, args, env, signal) {
  const argv = ['-o', 'json', ...(s.target ? ['--env', s.target] : []), ...args];
  return new Promise((ok, fail) => {
    execFile(s.bin, argv, { env, signal, timeout: 30000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error?.name === 'AbortError') return fail(signal?.reason ?? error);
      const exit = !error ? 0 : typeof error.code === 'number' ? error.code : error.code === 'ENOENT' ? 'missing' : 'timeout';
      let json = null;
      try { json = JSON.parse(String(stdout).trim()); } catch {}
      ok({ exit, json, text: String(stderr || stdout || error?.message || '').trim().slice(0, 300) });
    });
  });
}

const blocked = (outcome, label, retry = null) => ({ status: 'blocked', seconds: 0, lines: [], answers: {}, summary: `没打出去：${label}`,
  booked: null, offer: null, outcome, label, needUser: false, retry });

// CLI 没跑成 → 没打出去的结果
function failed(out, what) {
  const message = out.json?.error?.message || out.text || '没有返回';
  if (out.exit === 'missing') return blocked('no_cli', '外呼平台的命令行工具没装（JUPITER_CLI）');
  if (out.exit === 3 || /SSO|认证失败/.test(message)) { // token 过期、无效时服务端回的是业务错（exit 1）
    console.error(`[call] 木星外呼鉴权失败（${what}）：${message}`);
    return blocked('auth_failed', '外呼平台鉴权失败，要管理员处理');
  }
  if (out.exit === 4 || out.exit === 'timeout') return blocked('network', '外呼平台连不上', 'soon');
  if (out.exit === 2) return blocked('bad_params', `外呼参数不对：${message}`, 'rewrite');
  return blocked('platform_error', `外呼平台没接这通：${message}`, RETRYABLE.test(message) ? 'soon' : 'no');
}

// ---------- 话单 ----------
// 字段以文档为准（callResult / ringTimeLen / talkingTimeLen / hangupReasonName / recordText / recordUrlData）；JSON 示例里还有 duration / endCause，都认。
// 接口的 data 是数组还是分页对象没见过真的：都认
const rowsOf = (data) => (Array.isArray(data) ? data : !data || typeof data !== 'object' ? []
  : data.contactId ? [data] : rowsOf(data.list ?? data.records ?? data.rows ?? data.data));
const finished = (r) => !!(r && (r.callResult || r.endCause));
const talkSeconds = (r) => hms(r.talkingTimeLen) || (r.callResult ? 0 : Number(r.duration) || 0);
const connected = (r) => r.callResult === '已接通' || talkSeconds(r) > 0;

// recordText / record-text 的结果 → [{ who: 'ai' | 'shop', text }]：格式还没见过真的，按常见写法宽松地认
export function transcript(recordText) {
  let list = recordText;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = list.split('\n'); } }
  if (list && typeof list === 'object' && !Array.isArray(list)) list = Object.values(list).find(Array.isArray) || [];
  return (Array.isArray(list) ? list : []).map((x) => {
    if (typeof x === 'string') {
      const m = /^\s*([^：:]{1,12})[：:]\s*(.*)$/.exec(x);
      return m ? { who: /机器人|AI|ai|robot|坐席|喵团/.test(m[1]) ? 'ai' : 'shop', text: m[2].trim() } : { who: 'shop', text: x.trim() };
    }
    const role = String(x?.role ?? x?.speaker ?? x?.type ?? x?.channel ?? '');
    return { who: /robot|ai|bot|ivr|agent|机器人|坐席/i.test(role) ? 'ai' : 'shop', text: String(x?.text ?? x?.content ?? x?.sentence ?? x?.asrText ?? '').trim() };
  }).filter((l) => l.text);
}

export function createJupiterProvider({ llm, agent }) {
  const EXTRACT_SYSTEM = `你在整理一通电话：AI 助理「${agent}」替用户打给商家。根据这通电话的要求和通话转写判断结果、整理问到的信息。只输出 JSON：
{"outcome": "…", "summary": "一句话说清结果（给用户看，带上时间、价格这类关键信息）", "answers": {"要问清的事": "问到的答案"}, "booked": {"日期": "", "时间": "", "人数": "", "价格": "", "保留": ""}, "offer": "店里给的替代方案"}
- outcome 只能是：${Object.entries(TALK).map(([k, v]) => `${k}（${v.label}）`).join('、')}。
- 只按转写里真说了的写，不编；要问清的事没问到写「没问到」。没约上 booked 填 null，店里没给替代方案 offer 填 null。`;

  // 接通了：有转写让模型整理，模型出错就只交转写；没转写只能说接通了多久
  async function talked(req, lines, seconds) {
    if (!lines.length) {
      const label = `接通了 ${seconds} 秒，平台没给通话文字`;
      return { outcome: 'no_text', label, summary: label, answers: {}, booked: null, offer: null, needUser: false, retry: null };
    }
    try {
      const out = await llm.complete({ system: EXTRACT_SYSTEM, maxTokens: 800, json: true,
        user: `【这通电话的要求】${JSON.stringify(mediaTxt(req).media)}\n【通话转写】\n${lines.map((l) => `${l.who === 'ai' ? agent : '店员'}：${l.text}`).join('\n')}` });
      const o = Object.hasOwn(TALK, out?.outcome) ? TALK[out.outcome] : null;
      if (o) {
        return { outcome: out.outcome, label: o.label, summary: String(out.summary || o.label), needUser: !!o.needUser, retry: o.retry || null,
          answers: out.answers && typeof out.answers === 'object' ? out.answers : {},
          booked: out.outcome === 'booked' && out.booked && typeof out.booked === 'object' ? out.booked : null, offer: out.offer ? String(out.offer) : null };
      }
    } catch (e) { console.error('[call] 整理通话结果失败：', e.message); }
    return { outcome: 'talked', label: '接通了，结果看转写', summary: '接通了，结果看转写', answers: {}, booked: null, offer: null, needUser: false, retry: null };
  }

  // 通话文字：话单里带了就用；没带就按录音的 deviceId 查一次转写
  async function linesOf(s, rec, env, signal) {
    const lines = transcript(rec.recordText);
    const deviceId = (rec.recordUrlData || []).find((x) => x?.deviceId)?.deviceId;
    if (lines.length || !deviceId) return lines;
    const out = await runCli(s, ['record-text', 'query', '--tenant-id', s.tenant, '--device-id', deviceId], env, signal);
    if (out.exit !== 0) console.error(`[call] 查通话转写失败（${rec.contactId}）：${out.json?.error?.message || out.text}`);
    return out.exit === 0 ? transcript(out.json) : [];
  }

  // 隔 pollMs 查一次话单，直到有结果；接通了但转写还没出来，再多等一分钟。等到 waitMs 还没有就交回最后看到的（rec 可能是 null）
  async function waitRecord(s, contactId, placedAt, env, signal) {
    let last = { rec: null, lines: [] };
    let textBy = 0;
    for (;;) {
      await sleep(s.pollMs, undefined, { signal });
      const out = await runCli(s, ['call-record', 'query', '--contact-id', contactId, '--tenant-id', s.tenant,
        '--start-time', clock(placedAt - 120_000), '--end-time', clock(Date.now() + 60_000)], env, signal);
      if (out.exit !== 0) console.error(`[call] 查话单失败（${contactId}）：${out.json?.error?.message || out.text}`);
      const rec = rowsOf(out.json).find((r) => r?.contactId === contactId) || null;
      if (finished(rec)) {
        last = { rec, lines: connected(rec) ? await linesOf(s, rec, env, signal) : [] };
        if (!connected(rec) || last.lines.length) return last;
        textBy ||= Date.now() + 60_000;
        if (Date.now() >= textBy) return last;
      }
      if (Date.now() - placedAt >= s.waitMs) return last;
    }
  }

  /**
   * 拨号 → 等话单 → 结果。onStage(stage)：通话状态；onPlaced(contactId)：平台接了这通（调用方马上记下来）。
   * env：这个人的配置和凭据（ctx.env）；signal 取消时 CLI 进程被杀掉、不再等结果（已经接通的电话挂不断）；
   * resume：{ ref, at } 是之前已经打出去、还没等到结果的那一通：不再拨，接着查它的话单
   */
  async function dial(req, { onStage = () => {}, onPlaced = async () => {}, signal, env = {}, resume = null } = {}) {
    const s = settings(env);
    if (!s.tenant || !s.route) return blocked('not_configured', '外呼平台没配置（JUPITER_TENANT_ID / JUPITER_ROUTE_POINT）');
    const { media, missing } = mediaTxt(req);
    if (missing.length) return blocked('bad_params', `参数不全：缺${missing.join('、')}`, 'rewrite');
    let childEnv;
    try { childEnv = await cliEnv(env, signal); } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      console.error('[call] 木星外呼鉴权失败：', e.message);
      return blocked('auth_failed', '外呼平台鉴权失败，要管理员处理');
    }
    const placedAt = resume ? Date.parse(resume.at) : Date.now();
    let contactId = resume?.ref;
    if (!contactId) {
      const out = await runCli(s, ['call', 'aicall', '--tenant-id', s.tenant, '--callee', media.电话号码, '--route-point', s.route,
        ...(s.displayNum ? ['--display-num', s.displayNum] : s.numberPool ? ['--number-pool', s.numberPool] : []),
        '--media-txt', JSON.stringify(media)], childEnv, signal);
      contactId = out.json?.contactId;
      if (out.exit !== 0 || !contactId) return failed(out.exit === 0 ? { ...out, exit: 1 } : out, 'aicall');
      await onPlaced(contactId);
    }
    onStage('dialing');

    const { rec, lines } = await waitRecord(s, contactId, placedAt, childEnv, signal);
    if (!rec) {
      const label = '电话打出去了，平台还没给结果';
      return { status: 'pending', seconds: 0, lines: [], answers: {}, summary: label, booked: null, offer: null, outcome: 'result_pending', label, needUser: false, retry: null };
    }
    const seconds = talkSeconds(rec);
    if (!connected(rec)) {
      const label = [rec.callResult || '没接通', rec.hangupReasonName].filter(Boolean).join('：');
      const dead = /空号|停机|不存在|销号/.test(label);
      return { status: 'missed', seconds: hms(rec.ringTimeLen), lines: [], answers: {}, summary: label, booked: null, offer: null,
        outcome: dead ? 'invalid_number' : 'no_answer', label, needUser: false, retry: dead ? 'no' : 'later' };
    }
    return { status: 'done', seconds, lines, ...(await talked(req, lines, seconds)) };
  }

  return { dial };
}
