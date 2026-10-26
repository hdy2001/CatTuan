// 目标（仿 Muse Goals）：「正在盯」每行是勾选框（= 完成）、标题和一句最新状态；点一行从底部弹出详情。
// 暂停、现在检查、删除都在详情右上角的 ··· 里，列表上只留这三样；已完成的收起来；最下面是「新建目标」。
import { $, esc, store, clock, dayClock, dayLabel, patchList, CHEVRON } from './util.js';
import { S, MOCK, taskById, isActive } from './state.js';
import { openTask, stepTitle, currentStep, STEP_ICON, sheetDrag } from './tasks.js';

// 正在检查这个目标的任务（排队或在跑）
const goalChecking = (g) => !g.done && S.tasks.find((t) => t.goalId === g.id && isActive(t));

// 列表上那一句状态：在查的说查到哪一步，暂停的前面标「已暂停」
function goalLine(g) {
  const checking = goalChecking(g);
  if (checking) return { text: checking.steps?.length ? `正在检查 · ${stepTitle(currentStep(checking))}` : '正在检查…', busy: true };
  if (g.done) return { text: g.status?.text || '已完成' };
  return { text: `${g.enabled ? '' : '已暂停 · '}${g.status?.text || '等第一次检查'}`, err: !!g.status?.error };
}

function goalRow(g) {
  const s = goalLine(g);
  const tip = g.done ? '取消完成，接着盯' : '完成了，不用再盯';
  return `<div class="grow${g.done ? ' done' : ''}${g.done || g.enabled ? '' : ' off'}">
    <button type="button" class="gbox${g.done ? ' on' : ''}" data-goal-done="${g.id}" aria-label="${tip}" title="${tip}"></button>
    <button type="button" class="gopen" data-goal-open="${g.id}"><b>${esc(g.title)}</b><span class="gline${s.busy ? ' busy' : ''}${s.err ? ' err' : ''}">${s.busy ? '<i class="spin"></i>' : ''}${esc(s.text)}</span></button>
  </div>`;
}

// 新建目标按这几类给例子（仿 Muse 的 Create a goal）
const GOAL_KINDS = [
  { id: 'health', name: '健康', svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19.5s-7-4.3-7-9.8A4 4 0 0 1 12 7a4 4 0 0 1 7 2.7c0 5.5-7 9.8-7 9.8z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
    ideas: ['每天上午 10 点和下午 3 点提醒我喝水', '每晚 23:00 提醒我放下手机准备睡觉', '每天下午 6 点提醒我起来走走、拉伸一下'] },
  { id: 'people', name: '人际', svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8.5" r="3.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="16.6" cy="9" r="2.6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M16 14.1c2.4.1 4.2 1.8 4.6 4.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    ideas: ['每年 5 月 20 日提醒我给妈妈准备生日礼物', '每周五下午提醒我约朋友周末聚一聚', '每周六上午提醒我给爸妈打个电话'] },
  { id: 'money', name: '理财', svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5l5 7 5-7M12 11.5V20M8 12.5h8M8 16h8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    ideas: ['每月 1 号提醒我还信用卡', '北京飞上海的机票降到 800 以下提醒我', '金价跌破每克 900 元时告诉我'] },
  { id: 'career', name: '事业', svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="7.5" width="17" height="12" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M9 7.5V6a1.6 1.6 0 0 1 1.6-1.6h2.8A1.6 1.6 0 0 1 15 6v1.5M3.5 12.5h17" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
    ideas: ['每天早上 9 点汇总 AI 行业的重要新闻', '每周一早上 9 点提醒我写这周计划', 'OpenAI 发布新模型时第一时间告诉我'] },
];

const GOAL_DONE_KEY = 'cattuan.goalsDoneOpen'; // 「已完成」展开没有
export function renderGoals() {
  const active = S.goals.filter((g) => !g.done);
  const done = S.goals.filter((g) => g.done);
  const showDone = store.get(GOAL_DONE_KEY, false);
  $('#goalCount').textContent = active.length || '';
  const items = [{ key: 'h:active', html: '<h3 class="ghead"><i class="gdot"></i>正在盯</h3>' }];
  if (active.length) active.forEach((g) => items.push({ key: g.id, html: goalRow(g) }));
  else items.push({ key: 'empty', html: '<p class="gempty">还没有在盯的事。喵团可以一直替你盯着一件事，有新进展再告诉你；也可以直接在聊天里说「以后每天早上告诉我天气」。</p>' });
  if (done.length) {
    items.push({ key: 'h:done', html: `<button type="button" class="ghead gfold${showDone ? ' open' : ''}" data-goal-fold aria-expanded="${showDone}"><i class="gdot off"></i>已完成<small>${done.length}</small>${CHEVRON}</button>` });
    if (showDone) done.forEach((g) => items.push({ key: g.id, html: goalRow(g) }));
  }
  items.push({ key: 'new', html: `<section class="gnew"><h3>新建目标</h3>${GOAL_KINDS.map((k) => `<button type="button" class="gkind" data-goal-new="${k.id}">${k.svg}<span>${k.name}</span>${CHEVRON}</button>`).join('')}</section>` });
  patchList($('#goals'), items);
  if (openGoalId) renderGoalSheet();
}

// ---------- 目标详情（仿 Muse）：说明、ACTIVE（多久查一次、下次什么时候）、动态（按天分组；检查的结论点开是那次检查的轨迹） ----------
export let openGoalId = null;
const ALARM = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="7" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 9.6V13l2.3 1.6M4.8 5.6l2.6-2.1M19.2 5.6l-2.6-2.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ACTIVE 里那一条（仿 Muse 的定时自动化）：在查的点开看这次检查的轨迹
function goalAuto(g) {
  const s = g.schedule || {};
  const name = s.once ? `${dayClock(s.once)} 办一次` : s.at ? `每天 ${s.at} 检查`
    : `每 ${s.every >= 60 ? `${+(s.every / 60).toFixed(1)} 小时` : `${s.every} 分钟`}检查一次`;
  const checking = goalChecking(g);
  const sub = checking ? '正在检查 · 点开看过程' : g.done ? '已完成，不再检查' : !g.enabled ? '已暂停'
    : g.nextRunAt ? `定时检查 · 下次 ${dayClock(g.nextRunAt)}` : '定时检查';
  const inner = `<span class="galarm">${checking ? '<i class="tsspin"></i>' : ALARM}</span><span class="gautotext"><b>${esc(name)}</b><small>${sub}</small></span>`;
  return checking ? `<button type="button" class="gautorow" data-goal-task="${checking.id}">${inner}${CHEVRON}</button>` : `<div class="gautorow">${inner}</div>`;
}

// 动态的一条：服务端记的是 { type, text }，按类型写标题和说明；检查的结论本身就是标题
const LOG = {
  created: (x) => ({ title: '建好目标', desc: x.text.replace(/^建好目标 · /, '').replace(/\s*·\s*$/, '') }),
  check: (x) => ({ title: x.text || '检查了一次', desc: x.notify ? '有新进展，在聊天里告诉了你' : '例行检查，没打扰你' }),
  error: (x) => ({ title: '这次检查没成功', desc: x.text.replace(/^这次检查没成功：?/, ''), state: 'warn' }),
  paused: () => ({ title: '暂停了检查', state: 'cut' }),
  resumed: () => ({ title: '继续检查' }),
  done: (x) => ({ title: '完成了', desc: x.text }),
  reopened: () => ({ title: '重新开始盯着' }),
};
const goalEntry = (x) => LOG[x.type]?.(x) || { title: x.text };

function goalActivity(g) {
  const log = [...(g.log || [])].reverse();
  if (!log.length) return `<p class="gempty">还没有动态。最新状态：${esc(g.status?.text || '—')}</p>`;
  return log.map((x, i) => {
    const e = goalEntry(x);
    const day = dayLabel(x.at);
    const head = i === 0 || dayLabel(log[i - 1].at) !== day ? `<div class="gday">${day}</div>` : '';
    const last = i === log.length - 1 || dayLabel(log[i + 1].at) !== day;
    const task = x.task && taskById(x.task); // 任务列表只留最近的，早的点不开
    const body = `<span><b>${esc(e.title)}</b><span class="tsdetail">${esc([e.desc, clock(x.at)].filter(Boolean).join(' · '))}</span></span>`;
    return `${head}<div class="tstep ${e.state || 'done'}${last ? ' last' : ''}"><span class="tsicon">${STEP_ICON[e.state || 'done']}</span><div class="tsmain">${task
      ? `<button type="button" class="tshit" data-goal-task="${task.id}">${body}${CHEVRON}</button>` : `<div class="tshit">${body}</div>`}</div></div>`;
  }).join('');
}

export function renderGoalSheet() {
  const g = openGoalId && S.goals.find((x) => x.id === openGoalId);
  if (!g) return closeGoalSheet();
  const html = `<header class="tshead gshead"><h2 id="gsTitle">${esc(g.title)}</h2>${g.brief ? `<p class="gsbrief">${esc(g.brief)}</p>` : ''}</header>
    <section class="gauto"><div class="gautohead">${g.done ? 'DONE' : g.enabled ? 'ACTIVE' : 'PAUSED'}</div>${goalAuto(g)}</section>
    <h3 class="gacthead">动态</h3>${goalActivity(g)}`;
  const box = $('#goalDetail');
  if (box._html !== html) { box.innerHTML = html; box._html = html; }
  if (!$('#goalMenu').hidden) renderGoalMenu(g);
}

function renderGoalMenu(g) {
  const checking = goalChecking(g);
  $('#goalMenu').innerHTML = [
    !g.done && `<button type="button" role="menuitem" data-goal-act="run" ${checking || !g.enabled ? 'disabled' : ''}>现在检查一次</button>`,
    !g.done && `<button type="button" role="menuitem" data-goal-act="${g.enabled ? 'pause' : 'resume'}">${g.enabled ? '暂停检查' : '继续检查'}</button>`,
    `<button type="button" role="menuitem" data-goal-act="${g.done ? 'undone' : 'done'}">${g.done ? '重新开始盯' : '标记完成'}</button>`,
    '<button type="button" role="menuitem" class="danger" data-goal-act="delete">删除目标</button>',
  ].filter(Boolean).join('');
}

export function toggleGoalMenu(open = $('#goalMenu').hidden) {
  const g = S.goals.find((x) => x.id === openGoalId);
  if (open && g) renderGoalMenu(g);
  $('#goalMenu').hidden = !(open && g);
  $('[data-goal-menu]').setAttribute('aria-expanded', String(!!(open && g)));
}

export function openGoalSheet(id) {
  if (!S.goals.some((g) => g.id === id)) return;
  openGoalId = id;
  toggleGoalMenu(false);
  $('#goalSheet').hidden = false;
  renderGoalSheet();
  $('#goalDetail').scrollTop = 0;
  $('#goalSheet .tsbody').focus({ preventScroll: true });
}

export function closeGoalSheet() {
  openGoalId = null;
  $('#goalMenu').hidden = true;
  $('#goalSheet').hidden = true;
}
sheetDrag('#goalSheet', '#goalDetail', () => closeGoalSheet());

// ---------- 目标操作：列表上的勾选框、详情 ··· 菜单、新建目标 ----------
const patchGoal = (id, body) => fetch(`/api/goals/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function goalAction(g, act) {
  if (MOCK) return; // 演示里没有真目标
  if (act === 'run') await fetch(`/api/goals/${g.id}/run`, { method: 'POST' });
  else if (act === 'pause' || act === 'resume') await patchGoal(g.id, { enabled: act === 'resume' });
  else if (act === 'done' || act === 'undone') await patchGoal(g.id, { done: act === 'done' });
  else if (act === 'delete' && confirm(`删掉目标「${g.title}」？`)) await fetch(`/api/goals/${g.id}`, { method: 'DELETE' });
}

$('#goals').addEventListener('click', (e) => {
  const done = e.target.closest('[data-goal-done]')?.dataset.goalDone;
  if (done) {
    const g = S.goals.find((x) => x.id === done);
    if (g) goalAction(g, g.done ? 'undone' : 'done');
    return;
  }
  const open = e.target.closest('[data-goal-open]')?.dataset.goalOpen;
  if (open) { openGoalSheet(open); return; }
  if (e.target.closest('[data-goal-fold]')) { store.set(GOAL_DONE_KEY, !store.get(GOAL_DONE_KEY, false)); renderGoals(); return; }
  const kind = e.target.closest('[data-goal-new]')?.dataset.goalNew;
  if (kind) openGoalNew(kind);
});

$('#goalSheet').addEventListener('click', (e) => {
  if (e.target === $('#goalSheet') || e.target.closest('[data-close-goal]')) { closeGoalSheet(); return; }
  if (e.target.closest('[data-goal-menu]')) { toggleGoalMenu(); return; }
  const act = e.target.closest('[data-goal-act]')?.dataset.goalAct;
  const g = S.goals.find((x) => x.id === openGoalId);
  if (act && g) { toggleGoalMenu(false); goalAction(g, act); return; }
  if (!e.target.closest('#goalMenu')) toggleGoalMenu(false); // 点别处收起菜单
  const task = e.target.closest('[data-goal-task]')?.dataset.goalTask;
  if (task) openTask(task); // 任务详情叠在目标详情上面，关掉回到目标
});

// 新建目标：一句话说想盯什么；从哪一类点进来就给那一类的例子
function openGoalNew(kind) {
  const k = GOAL_KINDS.find((x) => x.id === kind);
  $('#gnTitle').textContent = k ? `新建目标 · ${k.name}` : '新建目标';
  $('#goalNewIdeas').innerHTML = (k ? k.ideas : GOAL_KINDS.map((x) => x.ideas[0]))
    .map((x) => `<button type="button" class="gnidea" data-idea="${esc(x)}">${esc(x)}</button>`).join('');
  $('#goalNewSheet').hidden = false;
  setTimeout(() => $('#goalNewInput').focus(), 50);
}

$('#goalNewSheet').addEventListener('click', (e) => {
  if (e.target === $('#goalNewSheet') || e.target.closest('[data-close-sheet]')) { $('#goalNewSheet').hidden = true; return; }
  const idea = e.target.closest('[data-idea]')?.dataset.idea;
  if (idea) { $('#goalNewInput').value = idea; $('#goalNewInput').focus(); }
});
$('#goalNewInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#goalNewForm').requestSubmit(); // ⌘/Ctrl + 回车直接建
});
$('#goalNewForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#goalNewInput').value.trim();
  if (!text) { $('#goalNewInput').focus(); return; }
  if (MOCK) return;
  const btn = $('#goalNewForm .gnsubmit');
  btn.disabled = true; btn.textContent = '理解中…';
  try {
    const r = await fetch('/api/goals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    const g = await r.json();
    if (!r.ok) throw new Error(g.error || r.status);
    $('#goalNewInput').value = '';
    $('#goalNewSheet').hidden = true;
    if (!S.goals.some((x) => x.id === g.id)) S.goals.push(g);
    renderGoals();
    openGoalSheet(g.id); // 建好就打开详情：第一次检查已经开始了
  } catch (err) {
    alert(`没建成：${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = '开始盯';
  }
});

