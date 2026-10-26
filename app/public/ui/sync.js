// 同步：/api/state 拉全量，/api/events（SSE）推增量，收到什么就重画哪一块。
import { $ } from './util.js';
import { S, MOCK, setState, waitingReply, setWaiting, taskById, isAdmin } from './state.js';
import { renderChat } from './chat.js';
import { renderTasks } from './tasks.js';
import { renderGoals } from './goals.js';
import { renderTV, liveFrames, paintLive } from './live.js';
import { renderChatBar, renderChatsList, currentChat, NEW_CHAT_TITLE } from './sidebar.js';
import { setOnline, setStatusText } from './status.js';

export function renderAll() {
  renderChat(); renderTasks(); renderGoals(); renderChatBar(); renderTV();
  $('#meName').textContent = S.me?.name || ''; // 侧边栏底部的当前账号
  $('#meRole').hidden = !isAdmin();
}

export async function loadState() {
  if (MOCK) return; // 演示模式只用演示脚本的数据
  try { setState(await (await fetch('/api/state')).json()); } catch { return; }
  renderAll();
  if (!$('#drawer').hidden && !$('#chatSearch').value.trim()) renderChatsList();
}

const upsert = (list, item) => {
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = item; else list.push(item);
  return i < 0;
};

export function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => setOnline(true);
  // 断了：可能是网络，也可能是登录过期（EventSource 看不到状态码），问一下，401 会回登录页
  es.onerror = () => { setOnline(false); fetch('/api/auth/me').catch(() => {}); };
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'hello') return loadState();
    if (ev.type === 'message') {
      const m = ev.message;
      // 别的聊天里来的消息（比如那边派的任务做完了）：不显示在当前聊天，只刷新聊天列表
      if (m.chatId && S.currentChat && m.chatId !== S.currentChat) { if (!$('#drawer').hidden) loadState(); return; }
      const chat = currentChat();
      if (chat && chat.title === NEW_CHAT_TITLE && m.role === 'me' && m.text) { chat.title = m.text.replace(/\s+/g, ' ').slice(0, 20); renderChatBar(); }
      if (m.role === 'me') {
        const i = S.messages.findIndex((x) => x.local && x.role === 'me' && x.text === m.text);
        if (i >= 0) S.messages.splice(i, 1);
      }
      if (upsert(S.messages, m) && m.role === 'bot') setWaiting(waitingReply - 1); // 同一条消息会更新（提问卡答完收起来）
      renderChat();
    } else if (ev.type === 'task') {
      upsert(S.tasks, ev.task);
      renderTV();
      renderTasks();
      if (ev.task.goalId) renderGoals();
    } else if (ev.type === 'browser') {
      const t = taskById(ev.taskId);
      if (!t) return;
      t.browser ||= { actions: [], frames: [], active: false };
      t.browser.active = ev.active;
      if (ev.action) t.browser.actions = [...(t.browser.actions || []), ev.action].slice(-60);
      if (!ev.active) liveFrames.delete(t.id);
      renderTV();
      renderTasks();
    } else if (ev.type === 'browser-frame') {
      if (!taskById(ev.taskId)) return;
      liveFrames.set(ev.taskId, ev);
      // 第一帧到之前还没有 <img>：重画一次，之后只换图
      if (!document.querySelector(`[data-bimg="${ev.taskId}"]`)) { renderTV(); renderTasks(); }
      paintLive(ev.taskId);
    } else if (ev.type === 'activity') {
      // 喵团手上的事：在做的按开始的先后留着（顶栏显示最新那件），做完的去掉
      const list = (S.activity ||= []);
      const i = list.findIndex((a) => a.id === ev.activity.id);
      if (ev.activity.status !== 'running') { if (i >= 0) list.splice(i, 1); } else upsert(list, ev.activity);
      setStatusText();
      renderChat(); // 聊天里的「…」跟着主 agent 有没有在干活走
    } else if (ev.type === 'goal') {
      upsert(S.goals, ev.goal);
      renderGoals();
    } else if (ev.type === 'goal-removed') {
      S.goals = S.goals.filter((g) => g.id !== ev.id);
      renderGoals();
    } else if (ev.type === 'chats') {
      loadState(); // 开了新聊天 / 切换 / 删除（可能是在别的设备上）
    }
  };
}
