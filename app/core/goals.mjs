// 目标（仿 Muse Goal）：定期派子 agent 检查（每 N 分钟 / 每天几点 / 到点一次），检查的那一轮多一个 goal_update 工具报告结果；
// 有新进展（notify）才交给主 agent 在聊天里说，没有就只更新目标下面那行小字。事情彻底办完（done）目标自动完成。
// 目标的动态（log）是结构化的：{ at, type, text, task? }，type：created 建好 · check 检查 · error 检查失败 · paused / resumed · done / reopened
import { newId, isoNow, hhmm, nowText, clip } from './util.mjs';
import { taskIdOf } from '../agent/agents.mjs';

const TICK_MS = 30_000;
const SOURCE = { chat: '在聊天里建的', page: '在目标页建的' };

export const scheduleLabel = (s) => (s?.once ? `${hhmm(s.once)} 一次` : s?.at ? `每天 ${s.at}` : s?.every >= 60 ? `每 ${+(s.every / 60).toFixed(1)} 小时` : `每 ${s?.every} 分钟`);

// minEvery：最短几分钟查一次，比它还勤的按它算。{ once } 是到点跑一次（ISO 时间，或今天 / 明天的 "HH:MM"）
export function normalizeSchedule(s, minEvery = 15, from = Date.now()) {
  if (s?.once) {
    const hm = /^(\d{1,2}):(\d{2})$/.exec(String(s.once));
    let at = hm ? new Date(from).setHours(Number(hm[1]), Number(hm[2]), 0, 0) : Date.parse(s.once);
    if (hm && at <= from) at += 86_400_000;
    if (Number.isFinite(at)) return { once: new Date(at).toISOString() };
  }
  if (typeof s?.at === 'string' && /^\d{1,2}:\d{2}$/.test(s.at)) return { at: s.at.padStart(5, '0') };
  const every = Number(s?.every ?? s?.every_minutes);
  return { every: Number.isFinite(every) && every > 0 ? Math.max(minEvery, Math.round(every)) : 360 };
}

export function nextRun(schedule, from = Date.now()) {
  if (schedule.once) return new Date(Math.max(Date.parse(schedule.once), from)).toISOString(); // 过了点（比如暂停后又打开）就马上跑
  if (schedule.at) {
    const [h, m] = schedule.at.split(':').map(Number);
    const d = new Date(from);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= from) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  return new Date(from + schedule.every * 60_000).toISOString();
}

// 检查这一轮专用的工具：报告检查结论
const goalUpdateTool = (t, report) => ({
  name: 'goal_update', label: '报告检查结果',
  describe: (a) => ({ act: `检查结论：${clip(a.status, 30)}` }),
  description: '目标检查做完时调用一次，报告这次的结论。notify 和 done 要严格：和上次状态比没有变化就是 notify=false；只有目标说明里的事已经彻底办完、以后不用再检查（比如一次性的提醒这次已经发出、要等的事已经发生）才 done=true，每天的天气、每年的生日这类周期性目标永远 false。值得告诉用户的要点写在最后的回复里，图片用 attach 附上。',
  parameters: { type: 'object', properties: {
    status: { type: 'string', description: '一句话（不超过 30 字）写目标当前的最新状态' },
    notify: { type: 'boolean', description: '有没有值得主动告诉用户的新信息' },
    done: { type: 'boolean', description: '目标是否已经彻底办完' },
  }, required: ['status', 'notify', 'done'] },
  async execute(_id, args) {
    report(t, { status: clip(args?.status, 60), notify: args?.notify === true, done: args?.done === true });
    return { content: [{ type: 'text', text: '已记下' }], details: {} };
  },
});

/**
 * tasks：core/tasks.mjs；agents：给目标检查加 goal_update 工具；deliver(u, chatId, delivery)：交给主 agent 说
 * llm：目标页一句话建目标时抽取标题、说明和频率；goalSchema：create_goal 工具的参数（同一份定义）
 */
export function createGoals({ store, quota, tasks, agents, deliver, llm, goalSchema }) {
  function save(g) {
    const u = store.get(g);
    store.save(u);
    store.broadcast(u, { type: 'goal', goal: g });
  }
  const log = (g, type, text, extra = {}) => {
    g.log = [...(g.log || []), { at: isoNow(), type, text: String(text || '').replace(/\s+/g, ' ').slice(0, 90), ...extra }].slice(-30);
  };
  const find = (u, id) => u.state.goals.find((g) => g.id === String(id || ''));

  // 完成（仿 Muse 目标的勾选框）：不再检查，挪到「已完成」；取消完成就接着按原来的频率盯
  function setDone(g, done, why = '') {
    if (!!g.done === done) return;
    Object.assign(g, { done, enabled: !done });
    if (done) g.doneAt = isoNow();
    else { delete g.doneAt; g.nextRunAt = nextRun(g.schedule); }
    log(g, done ? 'done' : 'reopened', done ? why : '重新开始盯着');
    save(g);
  }

  function setEnabled(g, enabled) {
    if (g.done || g.enabled === enabled) return;
    g.enabled = enabled;
    if (enabled) g.nextRunAt = nextRun(g.schedule);
    log(g, enabled ? 'resumed' : 'paused', enabled ? '继续检查' : '暂停');
    save(g);
  }

  // chatId：在哪个聊天里建的，有新进展回到那个聊天说
  function create(u, { title, brief, schedule, chatId, source = 'chat' }) {
    const sched = normalizeSchedule(schedule, quota.minEvery(u));
    const runNow = !sched.once;
    const g = {
      id: newId('g'), uid: u.id, title: String(title).slice(0, 20), brief, schedule: sched, enabled: true, ...(chatId && { chatId }),
      createdAt: isoNow(), status: { text: runNow ? '马上开始第一次检查' : `等待检查（${scheduleLabel(sched)}）`, at: isoNow() },
      seen: [], nextRunAt: runNow ? isoNow() : nextRun(sched),
    };
    log(g, 'created', `建好目标 · ${scheduleLabel(sched)} · ${SOURCE[source] || ''}`);
    u.state.goals.push(g);
    save(g);
    if (runNow) run(g);
    return g;
  }

  // 每次检查交给子 agent 的说明
  function checkBrief(g) {
    const last = g.status?.at ? new Date(g.status.at).toLocaleString('zh-CN', { hour12: false }) : '无';
    return `这是持续目标「${g.title}」的例行检查（现在是 ${nowText()}）。
目标说明：${g.brief}
上次状态（${last}）：${g.lastRunAt ? g.status?.text : '（首次检查）'}
之前已经发给用户的图片 id（不要再附）：${g.seen.slice(-200).join(',') || '（无）'}
按目标说明检查有没有新进展，做完调用 goal_update 报告结论。`;
  }

  function run(g) {
    const u = store.get(g);
    if (g.done || !store.active(u)) return null;
    if (u.state.tasks.some((t) => t.goalId === g.id && tasks.isActive(t))) return null;
    g.nextRunAt = g.schedule.once ? null : nextRun(g.schedule); // 一次性的跑这一次就不再排
    const over = quota.over(u, 'goalChecks');
    if (over) { // 今天的检查次数用完了：这次跳过，到点再查
      g.status = { ...g.status, text: '今天的检查次数用完了，明天接着盯', at: isoNow() };
      save(g);
      return null;
    }
    quota.bump(u, 'goalChecks');
    const task = tasks.create(u, { title: `目标：${g.title}`, brief: checkBrief(g), kind: 'goal', goalId: g.id, chatId: g.chatId });
    g.lastRunAt = isoNow();
    g.status = { ...g.status, checking: true };
    save(g);
    return task;
  }

  // 检查跑完：没调 goal_update 的按「已检查、没有新进展」算
  function finished(t) {
    const u = store.get(t);
    const g = find(u, t.goalId);
    if (!g) return;
    if (t.status !== 'done') {
      g.status = { text: `这次检查没成功：${String(t.error || '').slice(0, 30)}`, at: isoNow(), error: true };
      log(g, 'error', g.status.text, { task: t.id });
      tasks.noteSaid(t, g.status.text, { quiet: true });
      return save(g);
    }
    const check = t.check || { status: clip(t.result?.text?.split('\n').find(Boolean) || '已检查，暂无变化', 60), notify: false, done: false };
    g.status = { text: check.status, at: isoNow() };
    log(g, 'check', check.status, { task: t.id, ...(check.notify && { notify: true }) });
    save(g);
    if (check.done) setDone(g, true, '目标达成，不用再盯了');
    if (!check.notify) return tasks.noteSaid(t, `没有新进展：${check.status}`, { quiet: true });
    // 已经发过的图不再发
    const attachments = (t.result?.attachments || []).map((a) => (a.type === 'images' ? { ...a, items: a.items.filter((p) => !g.seen.includes(p.id)) } : a))
      .filter((a) => a.type !== 'images' || a.items.length);
    g.seen = [...g.seen, ...attachments.flatMap((a) => (a.type === 'images' ? a.items.map((p) => p.id) : []))].slice(-500);
    save(g);
    const chatId = u.state.chats.some((c) => c.id === g.chatId) ? g.chatId : u.state.currentChat;
    const body = String(t.result?.text || '').slice(0, 3000);
    return deliver(u, chatId, {
      task: t, title: `目标「${g.title}」有新进展`, attachments,
      input: `【目标进展】你帮用户盯着的目标「${g.title}」（${g.id}）检查到了新进展，主动告诉用户（像朋友突然发来消息）。\n最新状态：${check.status}\n要点：\n${body || '（无）'}`,
      fallback: check.status, last: { taskId: t.id, goalId: g.id },
    });
  }

  // 目标页一句话建目标：按 create_goal 工具的参数抽取
  async function fromText(u, text) {
    const out = await llm.complete({
      system: `把用户想持续关注的事整理成一个目标（${goalSchema.description}）。现在是 ${nowText()}。只输出 JSON，字段：${JSON.stringify(goalSchema.parameters.properties)}`,
      user: text, maxTokens: 400, json: true,
    });
    if (!out?.brief) throw new Error('没理解这个目标');
    return create(u, { title: out.title || text.slice(0, 12), brief: String(out.brief).slice(0, 2000), schedule: out.schedule, source: 'page' });
  }

  function remove(u, g) {
    u.state.goals = u.state.goals.filter((x) => x.id !== g.id);
    store.save(u);
    store.broadcast(u, { type: 'goal-removed', id: g.id });
  }

  // 目标检查那一轮多一个 goal_update 工具
  agents.extend('worker', (u, ctx) => {
    const t = u.state.tasks.find((x) => x.id === taskIdOf(ctx.sessionId));
    return t?.kind === 'goal' ? [goalUpdateTool(t, (task, check) => { task.check = check; })] : [];
  });

  let timer;
  return {
    create, run, finished, setDone, setEnabled, remove, find, fromText, scheduleLabel,
    // 每 30 秒：同步一下账号（新建的、被停用的），再看谁的目标到点了
    start() {
      timer = setInterval(() => {
        store.refresh();
        for (const u of store.all()) {
          if (store.active(u)) for (const g of u.state.goals) if (g.enabled && g.nextRunAt && Date.parse(g.nextRunAt) <= Date.now()) run(g);
        }
      }, TICK_MS);
      timer.unref();
    },
    stop() { clearInterval(timer); },
  };
}
