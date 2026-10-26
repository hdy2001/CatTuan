// 喵团前端入口：聊天（主 agent 短回复 + 任务 / 目标结果）、目标（持续目标 + 最新状态）、任务（子 agent 在做什么）。
// 所有数据在服务端，/api/state 拉全量，/api/events（SSE）推增量；各块界面在 ui/ 下。
// 演示模式（?mock=booking 等）：用 mock/ 下的脚本和假数据演示流程（给 PRD 截交互图），不连服务端、不写任何数据。
import { $, store } from './ui/util.js';
import { S, MOCK, setState, setWaiting } from './ui/state.js';
import { renderChat, send, useMock } from './ui/chat.js';
import { openDoc, openCallLog, openCallDetail, askOf } from './ui/cards.js';
import { openTask, closeTask, openTaskId, renderTasks } from './ui/tasks.js';
import { openGoalSheet, closeGoalSheet, toggleGoalMenu, openGoalId } from './ui/goals.js';
import { renderTV } from './ui/live.js';
import { showView, closeDrawer, drawerOpen, renderChatBar } from './ui/sidebar.js';
import { askInInput } from './ui/composer.js';
import { setOnline } from './ui/status.js';
import { connect } from './ui/sync.js';

// 登录过期、账号被停用：任何接口返回 401 就回登录页（演示模式不连服务端，不用管）
if (!MOCK) {
  const rawFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const r = await rawFetch(...args);
    if (r.status === 401 && String(args[0]).startsWith('/api/')) location.replace('/login');
    return r;
  };
}

// ---------- 打电话：提问选项卡、通话组件、侧边栏「喵团档案 → 电话」（演示里由演示脚本接管） ----------
let callLog = []; // 「电话」里的通话记录（/api/calls），新的在后
async function loadCalls() {
  try { callLog = (await (await fetch('/api/calls')).json()).calls || []; } catch {}
  return callLog;
}
const findCall = (id) => [...callLog, ...S.messages.flatMap((m) => (m.attachments || []).filter((a) => a.type === 'calls').flatMap((a) => a.calls))].find((c) => c.id === id);

// 提问选项卡：点选项记下答案、跳到下一题；都答完了替用户把答案拼成一句话发出去（带上是哪张卡、选了什么），服务端把卡片收起来。
// 「其他」：不在选项里的，直接在输入框里说（服务端收到下一句话时也会把卡片收起来）。
function cardClick(e) {
  const opt = e.target.closest('[data-ask-opt]');
  const tab = e.target.closest('[data-ask-tab]');
  const other = e.target.closest('[data-ask-other]');
  const m = (opt || tab || other) && S.messages.find((x) => x.id === e.target.closest('[data-mid]')?.dataset.mid);
  const b = askOf(m);
  if (b && !b.answered) {
    if (tab) b.cur = Number(tab.dataset.askTab);
    if (opt) {
      b.answers = { ...b.answers, [b.questions[b.cur].key]: opt.dataset.askOpt };
      const next = b.questions.findIndex((q) => !b.answers[q.key]);
      if (next >= 0) b.cur = next;
      else {
        b.answered = true;
        send(b.questions.map((q) => `${q.tab}：${b.answers[q.key]}`).join('；'), [], { id: m.id, answers: b.answers });
      }
    }
    if (other) askInInput();
    renderChat();
    return true;
  }
  const call = e.target.closest('[data-call]');
  if (call) { const c = findCall(call.dataset.call); if (c) openCallDetail(c); return true; }
  if (e.target.closest('[data-open-calls]')) { closeDrawer(); loadCalls().then(openCallLog); return true; }
  return false;
}

document.addEventListener('click', (e) => {
  if (!MOCK && cardClick(e)) return;
  const doc = e.target.closest('[data-open-doc]');
  if (doc) { openDoc(doc.dataset.openDoc); return; }
  const goto = e.target.closest('[data-goto-task]');
  if (goto) { openTask(goto.dataset.gotoTask); return; } // 聊天里「来自后台任务 ›」、小电视：在当前页面上弹出任务详情
  const gotoGoal = e.target.closest('[data-goto-goal]');
  if (gotoGoal) { openGoalSheet(gotoGoal.dataset.gotoGoal); return; } // 聊天里「来自目标」「新目标」：在当前页面上弹出目标详情
  const img = e.target.closest('.gallery img');
  if (img) {
    // 先放缩略图，原图加载好了再换上；取不到就一直用缩略图。
    const big = $('#lightboxImg');
    big.src = img.src;
    const full = new Image();
    full.onload = () => { if (big.src === img.src) big.src = full.src; };
    full.src = img.dataset.full;
    $('#lightboxSave').href = img.dataset.full;
    $('#lightboxSource').href = img.dataset.page || img.dataset.full;
    $('#lightboxSource').textContent = `来源：${img.dataset.site.replace(/^www\./, '')}`;
    $('#lightbox').hidden = false;
  } else if (e.target.closest('#lightbox') && !e.target.closest('a')) {
    $('#lightbox').hidden = true;
  }
});
document.addEventListener('error', (e) => {
  if (e.target.matches?.('.gallery img')) e.target.closest('figure').remove(); // 缩略图失效就隐藏这一格
}, true);

// Esc 一层一层关：上面的报告、大图先关；目标详情上面可能还叠着任务详情
document.addEventListener('keydown', (e) => {
  const nothingAbove = $('#reportReader').hidden && $('#lightbox').hidden;
  if (e.key === 'Escape' && openGoalId && !openTaskId && nothingAbove) { if ($('#goalMenu').hidden) closeGoalSheet(); else toggleGoalMenu(false); }
  if (e.key === 'Escape' && openTaskId && nothingAbove) closeTask();
  if (e.key === 'Escape' && !$('#goalNewSheet').hidden) $('#goalNewSheet').hidden = true;
  if (e.key === 'Escape' && !$('#reportReader').hidden) $('#reportReader').hidden = true;
  if (e.key === 'Escape' && drawerOpen()) closeDrawer();
  if (e.key === 'Escape') { $('#idViewer').hidden = true; $('#resumeViewer').hidden = true; }
  const card = (e.key === 'Enter' || e.key === ' ') && e.target.closest?.('[data-open-doc]');
  if (card) { e.preventDefault(); openDoc(card.dataset.openDoc); }
});

// ---------- 演示模式：mock/<名字>.js 接管聊天里的数据和发送，给它画界面需要的几个函数 ----------
async function startMock() {
  setOnline(true);
  setState({ messages: [], tasks: [], goals: [], activity: [], chats: [{ id: 'mock', title: '演示', updatedAt: new Date().toISOString() }], currentChat: 'mock' });
  const script = await import(`./mock/${encodeURIComponent(MOCK)}.js`).catch(() => null);
  if (!script) {
    S.messages.push({ id: 'mock_missing', role: 'bot', text: `没有找到演示脚本 mock/${MOCK}.js`, at: new Date().toISOString() });
    return renderChat();
  }
  useMock(script.start({
    S,
    showView,
    render: () => { renderChat(); renderTasks(); renderTV(); renderChatBar(); },
    typing: (on) => { setWaiting(on ? 1 : 0); renderChat(); },
  }));
}

if (MOCK) {
  // 输入框上面的演示入口在演示里变成「返回喵团」
  $('#demoBanner').href = '/';
  $('#demoBanner').classList.add('in-demo');
  $('#demoBanner .dbtext').innerHTML = `<b>演示中${MOCK === 'booking' ? ' · 电话预约' : ''}</b><small>假数据，刷新回到当前这一步</small>`;
  $('#demoBanner em').textContent = '返回喵团 ›';
  showView('chat');
  startMock();
} else {
  showView(store.get('cattuan.view', 'chat'));
  connect();
}

