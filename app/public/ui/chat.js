// 聊天：消息列表（按消息 id 增量更新）和发消息。消息下面挂的东西都在 attachments 里，由 cards.js 按类型画。
import { $, esc, clock, renderText, scheduleLabel } from './util.js';
import { S, MOCK, waitingReply, setWaiting, taskById } from './state.js';
import { attachmentsHtml, hasAttachment } from './cards.js';

let mock = null; // 演示脚本：{ send(text, images) }
export function useMock(script) { mock = script; }

// 任务结果消息：同一 taskId 的后一条（目标推送也算）
const isResultMsg = (m) => m.role === 'bot' && m.taskId && ((m.goalId && m.taskId) || S.messages.some((x) => x.taskId === m.taskId && x.at < m.at));

function msgHtml(m) {
  // 任务结果消息在时间后面跟一行小字链到任务，像真人聊天一样不另外占一个框；目标带来的新进展标目标名。
  // 进行中的任务不在聊天里挂状态条，看右下角的小电视。
  const goal = m.goalId && S.goals.find((g) => g.id === m.goalId);
  const fromGoal = m.role === 'bot' && m.goalId && m.taskId;
  const resultOf = isResultMsg(m) && !fromGoal ? taskById(m.taskId) : null;
  let html = '';
  if (fromGoal) html += `<button type="button" class="pushtag" data-goto-goal="${m.goalId}">🎯 来自目标：${esc(goal?.title || '已删除的目标')}</button>`;
  if (m.images?.length) html += `<div class="thumbs">${m.images.map((u) => `<img src="${esc(u)}" alt="">`).join('')}</div>`;
  const images = attachmentsHtml(m.attachments?.filter((a) => a.type === 'images'), `m:${m.id}`);
  if (m.text || images) html += `<div class="bubble">${renderText(m.text)}${images}</div>`;
  html += attachmentsHtml(m.attachments, `m:${m.id}`, { skip: ['images'] });
  if (m.goalId && !m.taskId && goal) html += `<button type="button" class="taskchip done" data-goto-goal="${goal.id}"><b>🎯</b>新目标：${esc(goal.title)} · ${esc(scheduleLabel(goal.schedule))}</button>`;
  const part = m.partOf && !m.taskId; // 拆开发的前几条
  // 挂了通话组件的（打电话的结果）不再显示来源：点通话组件就能看这通电话的详情（仿 Cue）
  const meta = resultOf && !hasAttachment(m, 'calls')
    ? `<div class="msgmeta"><time>${clock(m.at)}</time><button type="button" class="fromtask" data-goto-task="${resultOf.id}">来自后台任务 ›</button></div>`
    : `<time>${clock(m.at)}</time>`;
  return `<div class="msg ${m.role}${fromGoal ? ' push' : ''}${part ? ' part' : ''}" data-mid="${m.id}">${html}${part ? '' : meta}</div>`;
}

// 喵团在干活、做完会在这个聊天里回话时显示「…」（仿 Muse：执行过程聊天里只有省略号，做到哪一步看顶栏状态）
const agentTyping = () => waitingReply > 0
  || (S.activity || []).some((a) => a.status === 'running' && a.replyIn && a.replyIn === S.currentChat);
const visibleMsg = (m) => m.role !== 'bot' || m.text || m.attachments?.length;

// 按消息 id 增量更新，只重画内容变了的消息：整块重画会让图片每来一条消息就重新加载一遍。
export function renderChat() {
  const box = $('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const old = new Map([...box.children].map((el) => [el.dataset.mid, el]));
  let prev = null;
  for (const m of S.messages.filter(visibleMsg)) {
    const html = msgHtml(m);
    let el = old.get(m.id);
    old.delete(m.id);
    if (!el || el._html !== html) {
      const tpl = document.createElement('template');
      tpl.innerHTML = html;
      const node = tpl.content.firstElementChild;
      node._html = html;
      if (el) el.replaceWith(node);
      el = node;
    }
    if ((prev ? prev.nextElementSibling : box.firstElementChild) !== el) prev ? prev.after(el) : box.prepend(el);
    prev = el;
  }
  old.forEach((el) => el.remove());
  if (agentTyping()) box.insertAdjacentHTML('beforeend', '<div class="msg bot" data-mid="_typing"><div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div></div>');
  if (nearBottom || waitingReply) box.scrollTop = box.scrollHeight;
}

// ask：在提问选项卡上选完时带上 { id: 那条消息, answers }，服务端据此把选项卡收起来
export async function send(text, images = [], ask) {
  if (!text.trim() && !images.length) return;
  if (MOCK) return mock?.send(text, images);
  // 喵团在想上一条时也能接着发（仿 Muse）：每条各自回，顶栏状态显示它在做哪一步
  setWaiting(waitingReply + 1);
  // 先本地显示，服务端广播回来时按内容去重。
  S.messages.push({ id: `local_${Date.now()}`, role: 'me', text, images, at: new Date().toISOString(), local: true });
  renderChat();
  try {
    const r = await fetch('/api/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, images, ...(ask && { ask }) }) });
    if (!r.ok) throw new Error((await r.json()).error || r.status);
  } catch (e) {
    setWaiting(waitingReply - 1);
    S.messages.push({ id: `local_err_${Date.now()}`, role: 'bot', text: `发送失败：${e.message}`, at: new Date().toISOString(), local: true });
    renderChat();
  }
}
