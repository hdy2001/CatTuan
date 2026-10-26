// Mock 外呼平台：按图灵外呼 / 木星可能返回的所有结果随机挑一个——拨号前被平台拦下、打出去没接通（各种挂断原因）、
// 接通后的各种业务结果；接通的通话转写和问到的信息让模型按挑中的结果现编。以后换真平台，只换这个文件（dial 的入参和返回不变）。
// 调试：CALL_MOCK_OUTCOME=busy 所有电话固定返回某种结果（见 OUTCOMES）；写成 01000000001:no_answer|answered,01000000002:busy
// 只固定这几个号码，| 隔开的是今天第 1 次、第 2 次打这个号码的结果。CALL_SPEED=0.2 是快进倍数（模拟的等待 = 通话时长 × 它）。
import { pause } from '../core/util.mjs';

// phase：blocked 拨号前被平台拦下（没打出去）/ ring 打出去没接通 / talk 接通了。
// modes：只在只问不约（ask）或要约（book）的电话里出现，没写就两种都会有。needUser：没答应，要回来问用户。
// retry：soon 马上可以再试 / later 过一阵再打 / tomorrow 明天再打 / rewrite 换个说法再打 / no 别再打了。weight：随机挑的权重。
// platform / release：图灵外呼的错误码、木星的挂断原因码，以后接真平台时对得上。
const OUTCOMES = [
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

const digits = (s) => String(s || '').replace(/\D/g, '');
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export function createMockProvider({ llm, agent, line, env = process.env }) {
  const speed = Number(env.CALL_SPEED ?? 0.2);
  // { '*': 'busy' } 或 { '01000000001': 'no_answer|answered' }：键是号码里的数字，'*' 是所有号码
  const forced = Object.fromEntries(String(env.CALL_MOCK_OUTCOME || '').split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => (x.includes(':') ? [digits(x.split(':')[0]), x.split(':')[1].trim()] : ['*', x])));
  const wait = (seconds, min, max) => pause(speed > 0 ? clamp(seconds * speed * 1000, min, max) : 0);

  // used：今天已经打过这个号码几次（固定结果写了 a|b 时，第 2 次用 b）
  function pick(mode, to, used) {
    const seq = String(forced[digits(to)] || forced['*'] || '').split('|');
    const fixed = OUTCOMES.find((o) => o.code === seq[Math.min(used, seq.length - 1)] && (!o.modes || o.modes.includes(mode)));
    if (fixed) return fixed;
    const pool = OUTCOMES.filter((o) => !o.modes || o.modes.includes(mode));
    let r = Math.random() * pool.reduce((s, o) => s + o.weight, 0);
    for (const o of pool) if ((r -= o.weight) < 0) return o;
    return pool[0];
  }

  // ---------- 接通后的对话：让模型按挑中的结果编（演示用的假数据），编不出来就用模板 ----------
  const TALK_SYSTEM = `你在给一个演示 App 编一通电话的通话记录（假数据）：AI 助理「${agent}」用${line}替用户给商家打电话。
必须按给定的「这通电话的结果」编，不能改结果。只输出 JSON：
{"lines": [{"who": "ai", "text": "…"}, {"who": "shop", "text": "…"}], "answers": {"要问清的事": "问到的答案"}, "summary": "一句话说清结果（给用户看，带上时间、价格这类关键信息）", "booked": {"日期": "", "时间": "", "人数": "", "价格": "", "保留": ""}, "offer": "店里给的替代方案"}
- lines 4–10 句。AI 开口先说明自己是${agent}智能助理、替一位顾客打电话；店员说话口语化，像真实的店。
- 只问不约（ask）：AI 不报用户信息、不答应任何事，结尾说顾客确认后再联系。
- 要约（book）：只报「可以告诉商家」里的信息；碰到「回来问用户的情况」不答应，跟店里说确认后回电；约上时挂断前复述日期、时间、项目、人数、价格。
- 价格、空位、营业时间这些细节编得合理；要问清的事问到了就写进 answers，没问到写「没问到」。
- 没约上时 booked 填 null；店里没给替代方案时 offer 填 null。`;

  function fallbackTalk(req, o) {
    const shopSays = {
      hung_up: '（对方挂断）', refuse_ai: '我们不接受机器打的电话，让本人打过来吧。', wrong_place: '你打错了，我们不是这家。',
      call_back_later: '现在正忙，你晚点再打吧。', partial: '这个我不太清楚，你晚点再问问店长吧。', full: '不好意思，都约满了，最近都没位置。',
      answered: '可以的，有位置，价格到店再看。', booked: '可以，给您约上了，到店报名字就行。', offer_other_time: '那个时间满了，晚一个小时可以吗？',
      deposit: '要先交 100 定金才能留位。', need_person: '这个得顾客本人打过来确认。',
    }[o.code] || '好的。';
    const lines = [{ who: 'ai', text: `您好，我是${agent}智能助理，替一位顾客打电话。${req.goal}` }, { who: 'shop', text: shopSays }];
    if (o.code !== 'hung_up') lines.push({ who: 'ai', text: o.needUser ? '好的，我先跟顾客确认一下，稍后给您回电。' : '好的，谢谢您，再见。' });
    return { lines, answers: {}, summary: o.label, booked: o.code === 'booked' ? req.details : null, offer: null };
  }

  async function talk(req, o) {
    const prompt = `【打给】${req.name}（${req.to}）\n【品类】${req.category || '没说'}\n【要办的事】${req.goal}`
      + `\n【模式】${req.mode === 'book' ? 'book（可以直接约）' : 'ask（只问不约）'}\n【预约信息】${JSON.stringify(req.details)}`
      + `\n【可以告诉商家】${req.share || '无'}\n【要问清】${(req.questions || []).join('；') || '无'}`
      + `\n【回来问用户的情况】${(req.ask_user_if || []).join('；') || '无'}\n【这通电话的结果】${o.label}`;
    try {
      const out = await llm.complete({ system: TALK_SYSTEM, user: prompt, maxTokens: 1000, json: true });
      const lines = (Array.isArray(out?.lines) ? out.lines : [])
        .map((l) => ({ who: l?.who === 'shop' ? 'shop' : 'ai', text: String(l?.text || '').trim() })).filter((l) => l.text);
      if (lines.length) {
        return { lines, answers: out.answers && typeof out.answers === 'object' ? out.answers : {}, summary: String(out.summary || o.label),
          booked: o.code === 'booked' && out.booked && typeof out.booked === 'object' ? out.booked : null, offer: out.offer ? String(out.offer) : null };
      }
    } catch (e) { console.error('[call] 编通话失败：', e.message); }
    return fallbackTalk(req, o);
  }

  // 拨号 → 响铃 → 通话 → 挂断。onStage(stage) 让调用方更新通话状态
  async function dial(req, { used, onStage }) {
    const o = pick(req.mode, req.to, used);
    const base = { outcome: o.code, label: o.label, needUser: !!o.needUser, retry: o.retry || null, platform: o.platform || null, release: o.release || null };
    if (o.phase === 'blocked') {
      await wait(1, 600, 600);
      return { ...base, status: 'blocked', seconds: 0, lines: [], answers: {}, summary: `没打出去：${o.label}`, booked: null, offer: null };
    }
    onStage('dialing');
    const ring = o.phase === 'ring' ? rand(20, 45) : rand(3, 12);
    await wait(ring, 1500, 8000);
    if (o.phase === 'ring') {
      const label = ['no_answer', 'ring_timeout'].includes(o.code) ? `${o.label}（响了 ${ring} 秒）` : o.label;
      return { ...base, status: 'missed', seconds: ring, lines: [], answers: {}, summary: label, booked: null, offer: null };
    }
    onStage('talking');
    const seconds = o.code === 'hung_up' ? rand(3, 8) : rand(30, 110);
    const [conv] = await Promise.all([talk(req, o), wait(seconds, 2000, 15000)]);
    return { ...base, status: 'done', seconds, ...conv };
  }

  return { dial };
}
