// 外呼（替用户打电话）：phone_call 工具（tools/business.mjs）经 ctx.services.phone 打到这里。
// 这里只管平台级的规则和通话记录：要有号码、同一个号码每人每天最多打 2 次（平台规则，第 3 次直接拦下）。
// 什么时候该打、要约要带齐哪些信息、没接通怎么跟进，写在 phone-call 技能里，由 agent 决定。
// 通话记录存在每个人数据目录的 calls.json：聊天里的通话组件、侧边栏「喵团档案 → 电话」里的通话记录都从这里来。
import path from 'node:path';
import { readJson, writeText } from '../tools/common.mjs';
import { newId, isoNow } from '../core/util.mjs';
import { createMockProvider } from './mock-provider.mjs';

export const CALL_LINE = '美团专线'; // 拨出线路：外显号码是平台从号码池里挑的、不固定，界面上不显示号码
const AGENT = '喵团'; // 电话里的自称
const MAX_PER_NUMBER = 2;
const RETRY_HINT = {
  soon: '可以马上再试一次', later: '这次别再打，过一阵可以再打', tomorrow: '今天不能再打这个号码了，明天 8 点后再打，或者换一家',
  rewrite: '换个说法再打', no: '别再打这个号码了',
};

const digits = (s) => String(s || '').replace(/\D/g, '');
const localDay = (iso) => new Date(iso).toLocaleDateString('sv-SE'); // YYYY-MM-DD（本地时区）
const shortName = (name) => String(name).replace(/[（(][^）)]*[）)]/g, '').trim() || String(name);

export function createCalls({ llm, provider = createMockProvider({ llm, agent: AGENT, line: CALL_LINE }) }) {
  const file = (u) => path.join(u.dir, 'calls.json');
  const list = (u) => readJson(file(u), []) || [];
  const save = (u, rec) => writeText(file(u), JSON.stringify([...list(u), rec].slice(-300)));
  const dialedToday = (u, phone) => list(u).filter((c) => c.status !== 'blocked' && digits(c.phone) === digits(phone) && localDay(c.at) === localDay(Date.now())).length;

  /**
   * 打一通电话：按规则检查 → 拨 → 记一条通话记录 → 返回给 agent 的结果（attachments 是挂到消息上的通话组件）。
   * task：发起这通电话的后台任务（{ id, round }，可能没有）；progress(details)：通话状态，任务轨迹里实时显示
   */
  async function place(u, task, req, progress = () => {}) {
    const mode = req.mode === 'book' ? 'book' : 'ask';
    const to = String(req.to || '').trim();
    const name = String(req.name || '').trim() || '对方';
    if (!digits(to)) return { dialed: false, connected: false, outcome: 'no_number', result: '没有对方的电话号码：先搜到这家的电话再打', retry: 'no' };
    const used = dialedToday(u, to);
    const rec = { id: newId('c'), taskId: task?.id, round: task?.round || 1, at: isoNow(), who: name, short: shortName(name), phone: to,
      category: req.category || '', mode, agent: AGENT, line: CALL_LINE };
    const live = (stage) => progress({ type: 'call', call: { id: rec.id, shop: rec.who, phone: rec.phone, agent: AGENT, stage, lines: rec.lines || [], at: rec.at } });
    live('queued');
    const r = used >= MAX_PER_NUMBER
      ? { status: 'blocked', seconds: 0, lines: [], answers: {}, summary: `没打出去：这个号码今天已经打了 ${MAX_PER_NUMBER} 次`, booked: null, offer: null,
        outcome: 'freq_limit', label: `这个号码今天已经打了 ${MAX_PER_NUMBER} 次`, needUser: false, retry: 'tomorrow', platform: 100001, release: null }
      : await provider.dial({ ...req, mode, to, name, share: mode === 'book' ? String(req.share || `预约人：${u.name}`) : '' }, { used, onStage: live });
    Object.assign(rec, r);
    save(u, rec);
    live(r.status === 'done' ? (r.needUser ? 'waiting' : 'done') : r.status);
    const dialed = r.status !== 'blocked';
    const left = Math.max(0, MAX_PER_NUMBER - used - (dialed ? 1 : 0));
    // 本来可以再打（soon / later），但这个号码今天打满了：改成明天
    const retry = ['soon', 'later'].includes(r.retry) && left < 1 ? 'tomorrow' : r.retry || 'no';
    return {
      call_id: rec.id, dialed, connected: r.status === 'done', outcome: r.outcome, result: r.label, need_user: r.needUser,
      retry, retry_hint: !r.retry ? '' : ['soon', 'later'].includes(retry) ? `${RETRY_HINT[retry]}（这个号码今天还能打 ${left} 次）` : RETRY_HINT[retry],
      calls_left_today: left, summary: r.summary, answers: r.answers, booked: r.booked, offer: r.offer,
      transcript: r.lines.map((l) => `${l.who === 'ai' ? AGENT : '店员'}：${l.text}`).join('\n'),
      line: CALL_LINE, duration_seconds: r.seconds,
      attachments: [{ type: 'calls', calls: [rec] }],
    };
  }

  return { place, list, line: CALL_LINE };
}
