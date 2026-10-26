// 后台任务：主 agent 派的子 agent 任务（kind: chat）和目标检查（kind: goal），都由 worker 在任务会话里跑。
// 排队的马上开跑，不限并发（用沙箱浏览器的那几步由沙箱自己排队，用量由每日额度管着）。
// 一个任务可以跑好几轮：做完后用户要改，就在同一个会话里接着跑「第 N 轮」；跑的时候用户要改，就插话进这一轮。
// App 重启时没跑完的任务重新排队，在原会话里接着做。任务结束（完成 / 失败）时调 onFinished(t)，由主 agent 或目标认领。
import { newId, isoNow, clip, nowText } from './util.mjs';

const MAX_STEPS = 60;
const STATUS = { queued: '排队中', running: '进行中', done: '已完成', failed: '失败', stopped: '已停止' };
const isActive = (t) => t.status === 'queued' || t.status === 'running';

// 工具事件 → 任务轨迹里的一步（同一个工具调用只记一步；晚到的 started 不会把做完的一步改回进行中）
export function recordStep(task, ev, now = isoNow) {
  if (!['tool.started', 'tool.updated', 'tool.completed'].includes(ev.event) || !ev.tool_call_id || !ev.tool) return null;
  task.steps ||= [];
  let step = task.steps.find((s) => s.id === ev.tool_call_id);
  if (!step) {
    step = { id: ev.tool_call_id, name: ev.tool, label: ev.label || ev.tool, status: 'running', at: now(), ...(ev.browser && { browser: true }) };
    task.steps.push(step);
    if (task.steps.length > MAX_STEPS) task.steps.splice(0, task.steps.length - MAX_STEPS);
  }
  if (step.status === 'done' && ev.event !== 'tool.completed') return step;
  if (ev.event === 'tool.updated') step.progress = ev.progress;
  else {
    if (ev.title) step.title = ev.title;
    if (ev.detail !== undefined) step.detail = ev.detail;
  }
  if (ev.event === 'tool.completed') Object.assign(step, { status: 'done', ok: ev.ok !== false, endedAt: step.endedAt || now() });
  return step;
}

/**
 * worker：agent/worker.mjs；fork(u, chatId, taskId)：把聊天会话复制成任务会话
 * imagePath(u, src)：上传的图在本地哪（不复制会话的任务把路径写进说明，让 agent 用 vision_analyze 看）
 * onFinished(t)：任务完成或失败（停了不算）
 */
export function createTasks({ store, quota, worker, fork, imagePath, onFinished, log = console.error }) {
  let closing = false;

  function update(t, patch = {}) {
    Object.assign(t, patch);
    const u = store.get(t);
    store.save(u);
    store.broadcast(u, { type: 'task', task: t });
  }

  const find = (u, id) => u.state.tasks.find((t) => t.id === String(id || ''));

  // category：任务列表的图标；query：用户的原话（任务详情里显示）；forkChat：从哪个聊天的会话复制（子 agent 带着那段对话做事）
  // skills：先加载哪些技能再做
  function create(u, { title, brief, kind = 'chat', images = [], goalId, chatId, category, query, forkChat, skills }) {
    const t = { id: newId('t'), uid: u.id, title: String(title).slice(0, 20), brief, kind, goalId, chatId, images,
      ...(category && { category }), ...(query && { query: String(query).slice(0, 300) }), ...(skills?.length && { skills }),
      status: 'queued', round: 1, steps: [], createdAt: isoNow() };
    if (forkChat) {
      try { t.forked = fork(u, forkChat, t.id); } catch (e) { log('[fork]', e.message); }
    }
    u.state.tasks.push(t);
    if (kind !== 'goal') quota.bump(u, 'tasks'); // 目标检查另算（goals.mjs）
    update(t);
    setImmediate(pump);
    return t;
  }

  function pump() {
    if (closing) return;
    for (const u of store.all().filter(store.active)) {
      for (const t of u.state.tasks) if (t.status === 'queued') run(t);
    }
  }

  // ---------- 每一轮交给子 agent 的话：任务说明和修改要求（做事的规矩在 agent-home/WORKER.md） ----------
  function firstPrompt(t) {
    const u = store.get(t);
    const skills = t.skills?.length ? `\n\n先用 skill_view 加载这些技能，按里面的方法做：${t.skills.join('、')}` : '';
    if (t.resumed) return `【后台任务：${t.title}】（现在是 ${nowText()}，任务编号：${t.id}）App 重启打断了上一轮，接着把这件事做完，已经做过的不用重做：\n${t.brief}${skills}`;
    if (t.forked) { // 上面已经是复制来的主 agent 会话（用户发的图的路径也在里面）
      return `【你现在是子 agent】（现在是 ${nowText()}，任务编号：${t.id}）上面是主 agent 和用户到现在的对话。主 agent 把下面这件事交给你在后台做，做完的结果交回主 agent，由它告诉用户。\n要做的事：${t.brief}${skills}`;
    }
    return `【后台任务：${t.title}】（现在是 ${nowText()}，任务编号：${t.id}）\n${t.brief}`
      + (t.images?.length ? `\n\n用户发来的图片（本地文件，用 vision_analyze 看，image_url 填路径）：\n${t.images.map((img) => imagePath(u, img)).join('\n')}` : '')
      + skills;
  }

  // 修改轮：会话里本来就有前面的过程，这里再附上上一轮结果，万一会话丢了也能接上
  function revisionPrompt(t) {
    const prev = t.result?.text ? `\n\n上一轮的结果（节选）：\n${t.result.text.slice(0, 1500)}` : '';
    return `【后台任务：${t.title} · 第 ${t.round} 轮修改】（现在是 ${nowText()}，任务编号：${t.id}）\n原来的任务：${t.brief}${prev}`
      + `\n\n用户对结果提出了修改：\n${(t.asks || []).map((a) => `- ${a}`).join('\n')}`
      + '\n\n在前面工作的基础上改：已经查到的信息、读过的网页不用重查，只补做或重做需要改的部分。';
  }

  // 用户的修改记录：state 是这条要求的去向
  //   merged 并进了还没开始的任务说明 · sent 已发给正在跑的这一轮 · delivered 这一轮已按它调整
  //   pending 没赶上这一轮，等跑完接着改 · round 开了新一轮来改 · dropped 任务停了，没用上
  function setRevisions(t, from, patch) {
    for (const v of t.revisions || []) if (from.includes(v.state)) Object.assign(v, patch);
  }

  // 每一轮的结局（done / failed / stopped / revised）和这一轮的步骤，存进 history（下一轮开始时清空 steps）
  function endRound(t, status, error) {
    const steps = (t.steps || []).map(({ id, ...s }) => s);
    t.history = [...(t.history || []), { round: t.round || 1, status, startedAt: t.startedAt, endedAt: isoNow(), steps,
      ...(error && { error: clip(error, 300) }) }];
  }

  async function run(t) {
    t.round ||= 1;
    update(t, { status: 'running', startedAt: isoNow(), stopRequested: false, check: undefined });
    const input = t.round > 1 ? revisionPrompt(t) : firstPrompt(t);
    const r = await worker.run(store.get(t), t, input, (ev) => { if (recordStep(t, ev)) update(t); });
    if (closing) return; // App 在关：保持「进行中」，重启后接着做
    for (const s of t.steps) if (s.status === 'running') Object.assign(s, { status: 'done', cut: true }); // 这一轮结束时还没做完的步骤
    const result = { text: r.output || '', attachments: r.attachments };
    if (r.status === 'cancelled' || t.stopRequested) {
      endRound(t, 'stopped');
      setRevisions(t, ['sent', 'pending'], { state: 'dropped' });
      update(t, { status: 'stopped', endedAt: isoNow(), resumed: undefined });
    } else if (r.status === 'failed') {
      endRound(t, 'failed', r.error);
      update(t, { status: 'failed', endedAt: isoNow(), error: String(r.error || '执行失败').slice(0, 300), resumed: undefined });
      onFinished(t);
    } else {
      // 插话被接收了、但这一轮在送到之前就结束了（pending_steer），或者压根没赶上：不发结果，直接接着改一轮
      if (!r.pendingSteer) setRevisions(t, ['sent'], { state: 'delivered' });
      const late = (t.revisions || []).filter((v) => v.state === 'pending' || (v.state === 'sent' && r.pendingSteer));
      if (late.length) {
        endRound(t, 'revised');
        const round = t.round + 1;
        late.forEach((v) => Object.assign(v, { state: 'round', round }));
        update(t, { status: 'queued', result, round, asks: late.map((v) => v.text), steps: [], resumed: undefined });
      } else {
        endRound(t, 'done');
        if (t.kind !== 'goal') store.get(t).state.stats.tasksDone++;
        update(t, { status: 'done', endedAt: isoNow(), result, asks: undefined, resumed: undefined });
        onFinished(t);
      }
    }
    pump();
  }

  // 用户要改一个任务（主 agent 的 steer_task，或接口）：按任务所处阶段处理，不另开新任务。目标检查不能改。
  async function steer(t, text) {
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
      rev.state = await worker.steer(t, `用户中途补充了要求：${text}\n在已经做的基础上按这个调整，不用从头再来。`) ? 'sent' : 'pending';
    } else { // 已完成 / 失败 / 已停止：同一个会话里接着改一轮
      const round = (t.round || 1) + 1;
      Object.assign(rev, { state: 'round', round });
      Object.assign(t, { status: 'queued', round, asks: [text], steps: [], error: undefined, endedAt: undefined });
    }
    update(t);
    setImmediate(pump);
    return rev;
  }

  function stop(t) {
    if (!t || !isActive(t)) return null;
    if (t.status === 'queued') {
      endRound(t, 'stopped');
      setRevisions(t, ['merged', 'round', 'pending'], { state: 'dropped' });
      update(t, { status: 'stopped', endedAt: isoNow() });
    } else {
      update(t, { stopRequested: true });
      worker.stop(t);
    }
    return t;
  }

  // 失败 / 停了的任务重来：修改轮重试时保留上一轮结果，修改要求还在 asks 里。超额返回给用户看的一句话
  function retry(t) {
    const u = store.get(t);
    if (t.status !== 'failed' && t.status !== 'stopped') return '这个任务没失败，不用重试';
    const over = t.kind !== 'goal' && quota.over(u, 'tasks');
    if (over) return over;
    if (t.kind !== 'goal') quota.bump(u, 'tasks');
    update(t, { status: 'queued', error: undefined, steps: [], startedAt: undefined, endedAt: undefined, retried: (t.retried || 0) + 1,
      ...((t.round || 1) === 1 && { result: undefined }) });
    setImmediate(pump);
    return '';
  }

  // 任务的完整结果（主 agent 的 read_task_result）：结果全文和附件
  function resultText(t) {
    const atts = t.result?.attachments || [];
    return [`「${t.title}」${STATUS[t.status]}${t.round > 1 ? `（第 ${t.round} 轮）` : ''}`,
      t.status === 'failed' && `失败原因：${t.error}`,
      t.result?.text && t.result.text.slice(0, 12000),
      ...atts.map(describeAttachment),
    ].filter(Boolean).join('\n') || '（还没有结果）';
  }

  // 账号停用：他正在跑、排着队的任务都停下（数据保留，恢复后可以重试）
  store.onDisable((u) => { for (const t of u.state.tasks) if (isActive(t)) stop(t); });

  // App 重启：没跑完的任务（进行中的那一轮随进程停了）重新排队，在原会话里接着做
  store.onLoad((u) => {
    for (const t of u.state.tasks) {
      if (isActive(t)) Object.assign(t, { status: 'queued', steps: [], startedAt: undefined, stopRequested: false, ...(t.status === 'running' && { resumed: true }) });
    }
  });

  return {
    create, find, steer, stop, retry, pump, update, resultText,
    isActive, statusLabel: (t) => STATUS[t.status],
    roundSecs: (t) => (t.startedAt && t.endedAt ? Math.max(0, Math.round((Date.parse(t.endedAt) - Date.parse(t.startedAt)) / 1000)) : null),
    // 主 agent / 目标这一轮最后跟用户说了什么：任务详情 MAIN 轨迹的最后一步、任务列表上的「最新动态」
    noteSaid(t, text, extra = {}) {
      const h = (t.history || []).findLast((x) => x.round === (t.round || 1));
      if (!h || !text) return;
      h.said = { at: isoNow(), text: clip(text, 200), ...extra };
      update(t);
    },
    close() { closing = true; },
  };
}

// 附件写成给 agent 看的一段话
export function describeAttachment(a) {
  if (a.type === 'document') return `【附上的文档】${a.title}\n${a.body}${a.sources?.length ? `\n来源：${a.sources.map((s) => `[${s.n}] ${s.url}`).join(' ')}` : ''}`;
  if (a.type === 'images') return `【附上的图】${a.items.length} 张`;
  if (a.type === 'calls') return `【打的电话】${a.calls.map((c) => `${c.short || c.who}——${c.label}：${c.summary}`).join('；')}`;
  return '';
}
