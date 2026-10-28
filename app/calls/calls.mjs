// 外呼（替用户打电话）：phone_call 工具（tools/business.mjs）经 ctx.services.phone 打到这里。
// 这里只管通话记录：要有号码才拨；平台接了这通就马上记一条（中途停了、App 重启了也有据可查），打完补上结果。
// 拨号、等结果由外呼平台做（jupiter-provider.mjs：木星 aicall）。什么时候该打、要约要带齐哪些信息、没接通怎么跟进，写在 phone-call 技能里。
// 通话记录存在每个人数据目录的 calls.json：聊天里的通话组件、侧边栏「喵团档案 → 电话」里的通话记录都从这里来。
import path from 'node:path';
import { readJson, writeText, withFileLock } from '../tools/common.mjs';
import { newId, isoNow } from '../core/util.mjs';
import { createJupiterProvider } from './jupiter-provider.mjs';

export const CALL_LINE = '美团专线'; // 拨出线路：外显号码是平台从号码池里挑的、不固定，界面上不显示号码
const AGENT = '喵团'; // 电话里的自称
const RETRY_HINT = { soon: '可以马上再试一次', later: '这次别再打，过一阵可以再打', rewrite: '把参数补齐、改好再打', no: '别再打这个号码了' };
const RESUME_MS = 30 * 60_000; // 同一个任务半小时内又要打同一个号码、上一通打出去了还没结果：接着等那一通，不再拨

const digits = (s) => String(s || '').replace(/\D/g, '');
const shortName = (name) => String(name).replace(/[（(][^）)]*[）)]/g, '').trim() || String(name);

export function createCalls({ llm, provider = createJupiterProvider({ llm, agent: AGENT }) }) {
  const file = (u) => path.join(u.dir, 'calls.json');
  const list = (u) => readJson(file(u), []) || [];
  // 几个任务可能同时在打：锁内重读，按 id 原地更新或追加
  const save = (u, rec) => withFileLock(file(u), () => {
    const all = list(u);
    const i = all.findIndex((c) => c.id === rec.id);
    if (i >= 0) all[i] = { ...rec }; else all.push({ ...rec });
    writeText(file(u), JSON.stringify(all.slice(-300)));
  });

  /**
   * 打一通电话：拨 → 记通话记录 → 返回给 agent 的结果（attachments 是挂到消息上的通话组件）。
   * task：发起这通电话的后台任务（{ id, round }，可能没有）；progress(details)：通话状态，任务轨迹里实时显示；
   * signal：任务停了就不再等；env：这个人的配置和凭据（ctx.env），外呼平台的配置和鉴权从这里读
   */
  async function place(u, task, req, { progress = () => {}, signal, env = {} } = {}) {
    const mode = req.mode === 'book' ? 'book' : 'ask';
    const to = String(req.to || '').trim();
    const name = String(req.name || '').trim() || '对方';
    if (!digits(to)) return { dialed: false, connected: false, outcome: 'no_number', result: '没有对方的电话号码：先搜到这家的电话再打', retry: 'no' };
    // App 重启、任务停了又接着做时，agent 会再调一次：上一通已经打出去了，接着等它的结果，别给商家再打一个
    const earlier = task?.id && list(u).findLast((c) => c.taskId === task.id && c.ref && ['dialing', 'pending'].includes(c.status)
      && digits(c.phone) === digits(to) && Date.now() - Date.parse(c.at) < RESUME_MS);
    const rec = earlier ? { ...earlier, status: 'dialing' } : { id: newId('c'), taskId: task?.id, round: task?.round || 1, at: isoNow(), who: name,
      short: shortName(name), phone: to, category: req.category || '', mode, agent: AGENT, line: CALL_LINE };
    const live = (stage) => progress({ type: 'call', call: { id: rec.id, shop: rec.who, phone: rec.phone, agent: AGENT, stage, lines: rec.lines || [], at: rec.at } });
    live('queued');
    // 只问不约不报用户任何信息；要约没写能报什么时只报称呼
    const share = mode === 'book' ? String(req.share || `仅可提供：顾客称呼：${u.name}`) : '不提供任何顾客信息';
    let r;
    try {
      r = await provider.dial({ ...req, mode, to, name, share }, {
        onStage: live, signal, env, resume: earlier ? { ref: earlier.ref, at: earlier.at } : null,
        onPlaced: (ref) => { Object.assign(rec, { ref, status: 'dialing', summary: '电话打出去了，还在等结果' }); return save(u, rec); },
      });
    } catch (e) {
      // 已经打出去了（比如任务被停了）：记下来，任务轨迹和通话记录都别一直显示在拨号
      if (rec.ref) {
        await save(u, Object.assign(rec, { status: 'pending', summary: '电话打出去了，没等到结果' })).catch(() => {});
        live('pending');
      }
      throw e;
    }
    Object.assign(rec, r);
    await save(u, rec);
    live(r.status === 'done' ? (r.needUser ? 'waiting' : 'done') : r.status);
    return {
      call_id: rec.id, dialed: r.status !== 'blocked', connected: r.status === 'done', outcome: r.outcome, result: r.label, need_user: r.needUser,
      // 打出去了没等到结果：接没接通都不知道，不能说「别再打这个号码」
      retry: r.retry || (r.status === 'pending' ? null : 'no'),
      retry_hint: RETRY_HINT[r.retry] || (r.status === 'pending' ? '已经打出去了，结果不知道：别自己重拨，问用户要不要过一会儿再打' : ''),
      summary: r.summary, answers: r.answers, booked: r.booked, offer: r.offer,
      transcript: r.lines.map((l) => `${l.who === 'ai' ? AGENT : '店员'}：${l.text}`).join('\n'),
      line: CALL_LINE, duration_seconds: r.seconds,
      attachments: [{ type: 'calls', calls: [{ ...rec }] }],
    };
  }

  return { place, list, line: CALL_LINE };
}
