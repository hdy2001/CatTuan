// 后台任务（仿 Muse）：每行是类别图标、标题、一句最新动态和时间，按今天 / 昨天分组；点一行从底部弹出详情。
// 详情是这个任务的轨迹：MAIN 是喵团（主 agent）替你做的事，SUBAGENT 是子 agent 每一轮调的工具（每一步的标题、说明由工具自己写好），
// 用浏览器的那一步里有实时画面和回放，打电话的那一步里有通话状态。
import { $, esc, clock, dayClock, fmtSecs, elapsed, chatGroup, scheduleLabel, renderText, mdHtml, patchList, oneSentence, firstLine, CHEVRON } from './util.js';
import { S, MOCK, taskById, isActive } from './state.js';
import { attachmentsHtml, hasAttachment, callOfStep, callLiveHtml } from './cards.js';
import { liveView, paintLive } from './live.js';
import { chatAction, showView } from './sidebar.js';
import { setStatusText, tickElapsed } from './status.js';

const STATUS = { queued: '排队中', running: '进行中', done: '已完成', failed: '失败', stopped: '已停止', waiting: '待你决定' };

// 类别：主 agent 派任务时按用户的话分好（task.category），没分的算生活
const TASK_CATS = {
  life: { name: '生活', svg: '<svg viewBox="0 0 24 24"><path d="M5 9.6h11.2v4A5.4 5.4 0 0 1 10.8 19h-.4A5.4 5.4 0 0 1 5 13.6z" fill="currentColor"/><path d="M16.2 11.2h1.2a2.3 2.3 0 0 1 0 4.6h-1.9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M8.6 4.4c-.9 1 .9 1.7 0 2.8M12.4 4.4c-.9 1 .9 1.7 0 2.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity=".6"/></svg>' },
  work: { name: '工作', svg: '<svg viewBox="0 0 24 24"><path d="M9 7V5.8C9 4.8 9.8 4 10.8 4h2.4c1 0 1.8.8 1.8 1.8V7" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="3.5" y="7" width="17" height="12.5" rx="2.6" fill="currentColor"/><path d="M3.8 12.2h16.4" stroke="#fff" stroke-opacity=".5" stroke-width="1.3"/><rect x="10.3" y="10.8" width="3.4" height="2.8" rx=".9" fill="#fff" fill-opacity=".92"/></svg>' },
  coding: { name: '编程', svg: '<svg viewBox="0 0 24 24"><path d="M8.6 7.4L4 12l4.6 4.6M15.4 7.4L20 12l-4.6 4.6M13.5 5.4l-3 13.2" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>' },
  social: { name: '社交', svg: '<svg viewBox="0 0 24 24"><path d="M18.8 9.6c1 .5 1.7 1.5 1.7 2.7v3.3c0 1.3-.9 2.3-2.1 2.6V20l-2.9-2h-3c-1 0-1.9-.5-2.4-1.3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" opacity=".6"/><path d="M3.5 6.9C3.5 5.3 4.8 4 6.4 4h7.7c1.6 0 2.9 1.3 2.9 2.9v4.5c0 1.6-1.3 2.9-2.9 2.9H9.5l-3.4 2.5v-2.6A2.9 2.9 0 0 1 3.5 11.4z" fill="currentColor"/><circle cx="7.4" cy="9.2" r="1" fill="#fff"/><circle cx="10.3" cy="9.2" r="1" fill="#fff"/><circle cx="13.2" cy="9.2" r="1" fill="#fff"/></svg>' },
};
const taskCat = (t) => (Object.hasOwn(TASK_CATS, t.category || '') ? t.category : 'life');

// 图标右下角的小徽标（仿 Muse 的放大镜 / 闹钟）：按任务做了什么来定——目标检查、打了电话、交回了报告
const BADGES = {
  search: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="5.4" fill="none" stroke="currentColor" stroke-width="2.8"/><path d="M14.8 14.8l4.4 4.4" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
  goal: '<svg viewBox="0 0 24 24"><path d="M12 6.4V12l3.6 2.4" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  call: '<svg viewBox="0 0 24 24"><path d="M7.4 4h2.4l1.3 3.6-1.7 1.2a10 10 0 0 0 5.8 5.8l1.2-1.7 3.6 1.3v2.4a1.8 1.8 0 0 1-2 1.8A15 15 0 0 1 5.6 6a1.8 1.8 0 0 1 1.8-2z" fill="currentColor"/></svg>',
};
const allSteps = (t) => [...(t.history || []).flatMap((h) => h.steps || []), ...(t.steps || [])];
const taskKind = (t) => (t.kind === 'goal' ? 'goal' : allSteps(t).some(callOfStep) ? 'call' : hasAttachment(t.result, 'document') ? 'search' : 'chat');
const KIND_NAME = { call: '打电话', goal: '目标检查', search: '调研报告', chat: '对话任务' };

function taskIcon(t, mini = false) {
  const cat = taskCat(t);
  const badge = !mini && BADGES[taskKind(t)] && taskKind(t);
  const busy = mini ? '' : t.status === 'running' ? ' busy' : t.status === 'queued' ? ' wait' : '';
  return `<span class="ticon c-${cat}${mini ? ' mini' : ''}${busy}" aria-hidden="true">${TASK_CATS[cat].svg}${badge ? `<i class="tbadge b-${badge}">${BADGES[badge]}</i>` : ''}</span>`;
}

// 这一步的标题：工具自己写好的一句人话（按参数和结果）；只有名字的（演示里的步骤）用名字
export const stepTitle = (s) => (s ? s.title || (s.status === 'running' ? `正在${s.label}` : s.label) || '' : '');
// 正在做的那一步：工具可能并行，取最后一个还在跑的；都跑完了取最后一步
export const currentStep = (t) => [...(t.steps || [])].reverse().find((s) => s.status === 'running') || t.steps?.at(-1);

// 「最新动态」：只有一句话。在跑的说正在做哪一步（用浏览器时说浏览器里在干什么），做完的是喵团最后跟你说的那句
function latestLine(t) {
  if (t.status === 'queued') return (t.round || 1) > 1 ? `排队中，马上按你的修改做第 ${t.round} 轮` : t.resumed ? '排队中，App 重启过，马上接着做' : '排队中，马上开始';
  if (t.status === 'running') {
    if (t.stopRequested) return '正在停下…';
    return (t.browser?.active && t.browser.actions?.at(-1)?.text) || stepTitle(currentStep(t)) || '在想怎么做';
  }
  const said = oneSentence(t.history?.at(-1)?.said?.text);
  if (t.status === 'done') return said || t.check?.status || oneSentence(firstLine(t.result?.text)) || '做完了';
  if (t.status === 'failed') return said || `没做成：${t.error || '出错了'}`;
  if (t.status === 'stopped') return '已停止';
  if (t.status === 'waiting') return '等你决定';
  return '';
}

// 列表上的时间：在跑的写跑了多久（每秒刷新），其余写什么时候做完的（今天、昨天只写几点）
function rowTime(t) {
  if (t.status === 'running') return `进行中 · <span data-elapsed="${t.id}"></span>`;
  if (t.status === 'queued') return `${clock(t.createdAt)} 派出 · 排队中`;
  const at = t.endedAt || t.createdAt;
  return ['今天', '昨天'].includes(chatGroup(at)) ? clock(at) : dayClock(at);
}
// 排序和分组用的时间：在跑的算现在（排最前），其余按做完的时间，新的在前
const taskTime = (t) => (isActive(t) ? Date.now() : Date.parse(t.endedAt || t.createdAt) || 0);

function taskRow(t) {
  return `<button type="button" class="trow ${t.status}" data-task-open="${t.id}">
    ${taskIcon(t)}
    <span class="tmain"><b>${esc(t.title)}</b><span class="tlatest">${esc(latestLine(t))}</span><time>${rowTime(t)}</time></span>
  </button>`;
}

export function renderTasks() {
  const list = [...S.tasks].sort((a, b) => taskTime(b) - taskTime(a) || String(b.createdAt).localeCompare(String(a.createdAt)));
  const items = [];
  let group = '';
  for (const t of list) {
    const g = chatGroup(new Date(taskTime(t)).toISOString());
    if (g !== group) items.push({ key: `g:${(group = g)}`, html: `<h3 class="tgroup">${g}</h3>` });
    items.push({ key: t.id, html: taskRow(t) });
  }
  if (!items.length) items.push({ key: 'empty', html: '<div class="empty">还没有后台任务。让喵团查资料、找图、打电话时，它会派子 agent 去干活。</div>' });
  patchList($('#tasks'), items);
  const active = S.tasks.filter(isActive).length;
  $('#taskBadge').hidden = !active;
  $('#taskBadge').textContent = `${active} 进行中`;
  setStatusText();
  if (openTaskId) renderTaskSheet();
  tickElapsed();
}

$('#tasks').addEventListener('click', (e) => {
  const id = e.target.closest('[data-task-open]')?.dataset.taskOpen;
  if (id) openTask(id);
});

// ---------- 任务详情（仿 Muse）：状态、标题、最新动态，下面是 MAIN / SUBAGENT 两段轨迹，每一步点开看细节 ----------
export let openTaskId = null;
const openSteps = new Set(); // 展开了的步骤
let openResult = false; // 结果全文展开了没有

export const STEP_ICON = {
  done: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6.3 10.3l2.4 2.4 5-5.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 5.8v5.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="14.1" r="1.1" fill="currentColor"/></svg>',
  fail: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M7.2 7.2l5.6 5.6M12.8 7.2l-5.6 5.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  cut: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.6 2.4"/><path d="M6.6 10h6.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  wait: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.6 2.4"/></svg>',
  running: '<i class="tsspin"></i>',
};

// 用户中途 / 做完后提的修改，每条的去向
const REV_STATE = {
  merged: '已并进任务说明', sent: '已发给正在跑的任务', delivered: '已按这条调整', pending: '这一轮跑完接着改',
  round: '第 {n} 轮按这条改', dropped: '任务停了，没用上',
};

// MAIN：喵团（主 agent）替你做的事——收到消息、派子 agent、转达修改、把结果告诉你
function mainSteps(t) {
  const goal = t.goalId && S.goals.find((g) => g.id === t.goalId);
  const list = [];
  if (t.kind === 'goal') list.push({ title: `检查目标「${goal?.title || t.title.replace(/^目标：/, '')}」`, detail: goal ? `${scheduleLabel(goal.schedule)} · ${goal.brief}` : '', at: t.createdAt });
  else if (t.query) list.push({ title: '收到你的消息', detail: `「${t.query}」`, at: t.createdAt });
  list.push({
    title: t.kind === 'goal' ? '派子 agent 去检查' : `派子 agent 去办：${t.title}`,
    detail: t.brief, brief: true, at: t.createdAt,
  });
  for (const v of t.revisions || []) {
    list.push({ title: '把你的修改转给子 agent', detail: `「${v.text}」\n${(REV_STATE[v.state] || v.state).replace('{n}', v.round)}`, at: v.at, state: v.state === 'dropped' ? 'cut' : 'done' });
  }
  for (const h of t.history || []) if (h.said) list.push({ title: saidTitle(t, h), detail: h.said.text, at: h.said.at, state: h.status === 'failed' ? 'warn' : 'done' });
  if (t.status === 'stopped') list.push({ title: '按你的要求停下了任务', at: t.endedAt || t.createdAt, state: 'cut' });
  list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  // 结果还没说：在跑的等子 agent，刚做完的在整理（做完超过两分钟就不显示了）
  if (isActive(t)) list.push({ title: t.status === 'queued' ? '排好队了，等子 agent 开始' : '等子 agent 做完，再把结果告诉你', state: 'wait' });
  else if (['done', 'failed'].includes(t.status) && t.history?.length && !t.history.at(-1).said && Date.now() - Date.parse(t.endedAt) < 120_000) list.push({ title: '整理结果，马上告诉你', state: 'running' });
  return list.map((x) => ({ state: 'done', ...x }));
}

function saidTitle(t, h) {
  const routine = t.kind === 'goal';
  if (h.status === 'failed') return routine ? '这次检查没成功' : '告诉你没做成';
  if (routine) return h.said.quiet ? '没有新进展，没打扰你' : '有新进展，发消息告诉了你';
  return (t.history || []).filter((x) => x.said).length > 1 ? `把第 ${h.round} 轮的结果告诉你` : '把结果告诉你';
}

// SUBAGENT：子 agent 的每一轮（第一次做、重试、按修改再做）各一段；这一轮的步骤服务端在一轮结束时存进 history
function taskRounds(t) {
  const rounds = (t.history || []).map((h) => ({ ...h, steps: h.steps || [] }));
  if (isActive(t)) rounds.push({ round: t.round || 1, status: t.status, startedAt: t.startedAt, steps: t.steps || [], current: true });
  else if (!rounds.length && t.steps?.length) rounds.push({ round: t.round || 1, status: t.status, startedAt: t.startedAt, endedAt: t.endedAt, steps: t.steps });
  return rounds;
}

const ROUND_END = { done: '完成', failed: '失败', stopped: '已停止', revised: '按新要求接着改' };
function roundLabel(t, r, i, all) {
  const parts = ['子 agent'];
  if (all.length > 1 || (r.round || 1) > 1) parts.push(`第 ${r.round || 1} 轮`);
  if (all.slice(0, i).some((x) => x.round === r.round)) parts.push('重试');
  else if ((r.round || 1) > 1) parts.push('按你的修改');
  if (r.current) parts.push(r.status === 'queued' ? '排队中' : `进行中 <span data-elapsed="${t.id}"></span>`);
  else {
    parts.push(ROUND_END[r.status] || '');
    if (r.startedAt && r.endedAt) parts.push(`用时 ${fmtSecs(Math.max(0, Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000)))}`);
  }
  return parts.filter(Boolean).join(' · ');
}

const stepItem = (s) => ({ title: stepTitle(s), detail: s.detail || '', browser: s.browser, call: callOfStep(s), at: s.at, end: s.endedAt,
  state: s.status === 'running' ? 'running' : s.cut ? 'cut' : s.ok === false ? 'warn' : 'done' });

// 一轮一段：子 agent 调的每个工具一步，用浏览器的那步挂上浏览器画面
function roundSections(t, r, i, rounds) {
  const items = r.steps.map(stepItem);
  attachBrowser(t, items, r);
  const live = r.current && t.status === 'running' && t.browser?.active;
  if (live && !items.some((x) => x.live)) items.push({ title: t.browser.actions?.at(-1)?.text || '在用浏览器', state: 'running', live: true });
  if (r.current && t.status === 'queued') items.push({ title: '排队中，等着开始', state: 'wait' });
  // 两次调工具之间是模型在想：不然看上去步骤全打了勾、却还在跑
  else if (r.current && !items.some((x) => x.state === 'running')) items.push({ title: items.length ? '在想下一步' : '在想怎么做', state: 'running' });
  if (!r.current) items.push(roundEnd(t, r, i === rounds.length - 1));
  return sectionBlocks(t, `sub${i}`, `SUBAGENT ${String(i + 1).padStart(2, '0')}`, roundLabel(t, r, i, rounds), items);
}

function roundEnd(t, r, last) {
  if (r.status === 'failed') return { title: '出错了，没做完', detail: r.error || (last ? t.error : '') || '', state: 'fail' };
  if (r.status === 'stopped') return { title: '按你的要求停下了', state: 'cut' };
  if (r.status === 'revised') return { title: '这一轮做完了，按你的新要求接着改', state: 'done' };
  return { title: '做完了，把结果交给喵团', detail: last ? t.check?.status || firstLine(t.result?.text) : '', state: 'done' };
}

// 用沙箱浏览器的步骤（工具标了 browser）：按时间把浏览器里的每个动作和关键帧（回放）挂到那一步下面；正在跑的那一步放实时画面
function attachBrowser(t, items, r) {
  const b = t.browser;
  if (!b) return;
  const used = new Set();
  const marks = items.filter((x) => x.at && x.browser).sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  let live = r.current && t.status === 'running' && b.active;
  marks.forEach((x, i) => {
    const from = Date.parse(x.at) - 300;
    const to = x.end ? Date.parse(x.end) + 300 : x.state === 'running' ? Infinity
      : marks[i + 1] ? Date.parse(marks[i + 1].at) : r.endedAt ? Date.parse(r.endedAt) : Infinity;
    const pick = (list) => list.filter((e) => {
      const at = Date.parse(e.at);
      if (used.has(e) || at < from || at > to) return false;
      used.add(e);
      return true;
    });
    x.actions = pick(b.actions || []);
    x.frames = pick(b.frames || []);
    if (live && x.state === 'running') { x.live = true; live = false; }
  });
}

// 展开后多看到的：完整说明（任务说明按原样排版）、浏览器里做了什么、回放截图、什么时候做的
function stepMore(t, s) {
  const dur = s.at && s.end ? Math.max(0, Math.round((Date.parse(s.end) - Date.parse(s.at)) / 1000)) : null;
  return [
    s.brief ? `<div class="brief">${renderText(t.brief)}</div>` : s.detail ? `<p class="tsfull">${renderText(s.detail)}</p>` : '',
    s.actions?.length ? `<ol class="tsacts">${s.actions.map((a) => `<li><time>${clock(a.at)}</time>${esc(a.text)}</li>`).join('')}</ol>` : '',
    !s.live && s.frames?.length ? `<div class="breplay">${s.frames.map((f, i) => `<img src="${esc(f.src)}" data-frame="${esc(f.src)}" data-frame-text="${esc(f.text || '')}" title="${esc(f.text || '')}" alt="第 ${i + 1} 张" loading="lazy">`).join('')}</div>` : '',
    s.at ? `<small class="tswhen">${dayClock(s.at)}${dur != null ? ` · 用了 ${fmtSecs(dur)}` : ''}</small>` : '',
  ].join('');
}

function stepHtml(t, s, key, last) {
  const open = openSteps.has(key);
  const more = s.brief || s.actions?.length || (s.frames?.length && !s.live) || s.at || /\n/.test(s.detail || '') || (s.detail || '').length > 46;
  const head = `<b>${esc(s.title)}</b>${s.detail && !open ? `<span class="tsdetail">${esc(s.detail)}</span>` : ''}`;
  return `<div class="tstep ${s.state}${last ? ' last' : ''}${open ? ' open' : ''}">
    <span class="tsicon">${STEP_ICON[s.state] || STEP_ICON.done}</span>
    <div class="tsmain">
      ${more ? `<button type="button" class="tshit" data-step-toggle="${key}" aria-expanded="${open}"><span>${head}</span>${CHEVRON}</button>` : `<div class="tshit"><span>${head}</span></div>`}
      ${open ? `<div class="tsmore">${stepMore(t, s)}</div>` : ''}
      ${s.call ? `<div class="tscall">${callLiveHtml(s.call, t)}</div>` : ''}
      ${s.live ? liveView(t) : ''}
    </div>
  </div>`;
}

// 一段轨迹：小标题（MAIN / SUBAGENT 01）+ 每一步各是一块（单独更新，实时画面那一步变了不会连带别的步骤重画）
function sectionBlocks(t, key, label, sub, steps) {
  return [{ key, html: `<div class="tssec"><b>${label}</b><span>${sub}</span></div>` }, ...steps.map((s, i) => ({ key: `${key}:${i}`, html: stepHtml(t, s, `${key}:${i}`, i === steps.length - 1) }))];
}

function sheetHead(t) {
  const cat = taskCat(t);
  const time = t.status === 'running' ? `${dayClock(t.startedAt || t.createdAt)} 开始 · 已经 <span data-elapsed="${t.id}"></span>`
    : t.status === 'queued' ? `${dayClock(t.createdAt)} 派出`
      : `${dayClock(t.createdAt)} 派出${t.startedAt ? ` · 用时 ${elapsed(t)}` : ''}`;
  return `<header class="tshead">
    <div class="tstags"><span class="tspill ${t.status}">${STATUS[t.status] || t.status}</span><span class="tscat">${taskIcon(t, true)}${TASK_CATS[cat].name} · ${KIND_NAME[taskKind(t)]}</span></div>
    <h2 id="tsTitle">${esc(t.title)}</h2>
    <p class="tslatest${t.status === 'failed' ? ' bad' : ''}">${esc(latestLine(t))}</p>
    <time>${time}${(t.round || 1) > 1 ? ` · 第 ${t.round} 轮` : ''}</time>
  </header>`;
}

// 结果：子 agent 交回的文字（可以展开全文），后面跟它附上的文档、图、通话
function resultBlock(t) {
  if (t.status !== 'done' || !t.result) return '';
  const text = String(t.result.text || '').trim();
  const body = text ? `<div class="tsrtext${openResult || text.length <= 240 ? ' open' : ''}">${mdHtml(text)}</div>${text.length > 240 ? `<button type="button" class="tsmorebtn" data-result-more>${openResult ? '收起' : '展开全文'}</button>` : ''}` : '';
  const atts = attachmentsHtml(t.result.attachments, `t:${t.id}`);
  if (!body && !atts) return '';
  return `<section class="tsresult"><div class="tssec"><b>RESULT</b><span>子 agent 交回的结果</span></div>${body}${atts}</section>`;
}

function sheetFoot(t) {
  const btns = [];
  if (t.status === 'running' || (t.status === 'queued' && t.kind !== 'goal')) {
    btns.push(`<button type="button" class="tsbtn danger" data-task-stop="${t.id}" ${t.stopRequested ? 'disabled' : ''}>${t.stopRequested ? '正在停止…' : '停止任务'}</button>`);
  }
  if (t.status === 'failed' || t.status === 'stopped') btns.push(`<button type="button" class="tsbtn primary" data-task-retry="${t.id}">${t.status === 'failed' ? '重试' : '重新开始'}</button>`);
  if (t.chatId && t.kind !== 'goal' && !isActive(t) && !MOCK) btns.push(`<button type="button" class="tsbtn" data-task-chat="${t.id}">回到聊天</button>`);
  return btns.join('');
}

export function renderTaskSheet() {
  const t = openTaskId && taskById(openTaskId);
  if (!t) return closeTask();
  const items = [{ key: 'head', html: sheetHead(t) }];
  items.push(...sectionBlocks(t, 'main', 'MAIN', '喵团 · 主 agent', mainSteps(t)));
  const rounds = taskRounds(t);
  rounds.forEach((r, i) => items.push(...roundSections(t, r, i, rounds)));
  const result = resultBlock(t);
  if (result) items.push({ key: 'result', html: result });
  patchList($('#taskDetail'), items);
  const foot = sheetFoot(t);
  if ($('#taskFoot')._html !== foot) { $('#taskFoot').innerHTML = foot; $('#taskFoot')._html = foot; }
  $('#taskFoot').hidden = !foot;
  paintLive(t.id);
  tickElapsed();
}

export function openTask(id) {
  if (!taskById(id)) return;
  openTaskId = id;
  openSteps.clear();
  openResult = false;
  $('#taskDetail').replaceChildren();
  $('#taskSheet').hidden = false;
  renderTaskSheet();
  $('#taskDetail').scrollTop = 0;
  $('#taskSheet .tsbody').focus({ preventScroll: true }); // 焦点进弹窗（Esc、Tab 从这里开始）
  // 正在用浏览器：直接滚到实时画面那一步
  requestAnimationFrame(() => $('#taskDetail .bview.live')?.scrollIntoView({ block: 'center' }));
}

export function closeTask() {
  const id = openTaskId;
  openTaskId = null;
  $('#taskSheet').hidden = true;
  document.querySelector(`[data-task-open="${id}"]`)?.focus({ preventScroll: true });
}

// 回到派这个任务的那个聊天，滚到结果那条消息
async function gotoTaskChat(t) {
  closeTask();
  if (t.chatId !== S.currentChat && !(await chatAction(`/api/chats/${t.chatId}/open`, 'POST'))) return;
  showView('chat');
  const m = S.messages.findLast((x) => x.taskId === t.id);
  if (m) document.querySelector(`[data-mid="${m.id}"]`)?.scrollIntoView({ block: 'center' });
}

$('#taskSheet').addEventListener('click', async (e) => {
  if (e.target === $('#taskSheet') || e.target.closest('[data-close-task]')) return closeTask();
  const frame = e.target.closest('[data-frame]');
  if (frame) {
    $('#lightboxImg').src = frame.dataset.frame;
    $('#lightboxSave').href = frame.dataset.frame;
    $('#lightboxSource').href = frame.dataset.frame;
    $('#lightboxSource').textContent = frame.dataset.frameText || '浏览回放';
    $('#lightbox').hidden = false;
    return;
  }
  const key = e.target.closest('[data-step-toggle]')?.dataset.stepToggle;
  if (key) {
    if (!openSteps.delete(key)) openSteps.add(key);
    renderTaskSheet();
    return;
  }
  if (e.target.closest('[data-result-more]')) { openResult = !openResult; renderTaskSheet(); return; }
  const chat = e.target.closest('[data-task-chat]')?.dataset.taskChat;
  if (chat) { gotoTaskChat(taskById(chat)); return; }
  if (MOCK) return; // 演示里的任务是假的，不去调服务端
  const stop = e.target.closest('[data-task-stop]');
  if (stop) {
    stop.disabled = true;
    const r = await fetch(`/api/tasks/${stop.dataset.taskStop}/stop`, { method: 'POST' });
    if (!r.ok) { alert((await r.json()).error || '没停下来'); stop.disabled = false; }
    return;
  }
  const retry = e.target.closest('[data-task-retry]');
  if (!retry) return;
  retry.disabled = true;
  const r = await fetch(`/api/tasks/${retry.dataset.taskRetry}/retry`, { method: 'POST' });
  if (!r.ok) { alert((await r.json()).error || '重试失败'); retry.disabled = false; }
});

// 往下拖关掉：按住顶上的小横条或标题那块往下拖（内容已经滚到最上面时）。任务详情和目标详情共用
export function sheetDrag(sheet, scroller, close) {
  const body = $(`${sheet} .tsbody`);
  let y0 = null;
  let dy = 0;
  body.addEventListener('pointerdown', (e) => {
    if (e.button || !e.target.closest('.tsgrab, .tshead') || $(scroller).scrollTop > 0) return;
    y0 = e.clientY;
    dy = 0;
    body.setPointerCapture(e.pointerId);
    body.classList.add('dragging');
  });
  body.addEventListener('pointermove', (e) => {
    if (y0 == null) return;
    dy = e.clientY - y0;
    body.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
    if (dy < 0) $(scroller).scrollTop = -dy; // 往上拖还是滚动内容
  });
  const end = () => {
    if (y0 == null) return;
    y0 = null;
    body.classList.remove('dragging');
    body.style.transform = '';
    if (dy > 110) close();
  };
  body.addEventListener('pointerup', end);
  body.addEventListener('pointercancel', end);
}
sheetDrag('#taskSheet', '#taskDetail', () => closeTask());
