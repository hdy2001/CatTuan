// 侧边栏（仿豆包 / 微信）：搜索聊天记录、新建对话、目标、后台任务、按日期分组的聊天记录；还有页面切换。
// 聊天之间共用后台任务和目标；删聊天只删聊天内容。
import { $, esc, store, chatGroup } from './util.js';
import { S, MOCK } from './state.js';
import { togglePanel } from './composer.js';
import { openIdCard, openResume } from './profile.js';
import { loadState } from './sync.js';

export const NEW_CHAT_TITLE = '新聊天';
export const currentChat = () => (S.chats || []).find((c) => c.id === S.currentChat);
const VIEW_TITLE = { goals: '目标', tasks: '后台任务' };

export function renderChatBar() {
  if (!$('#chatView').hidden) $('#topTitle').textContent = currentChat()?.title || NEW_CHAT_TITLE;
}

// list 不传就用 S.chats 按日期分组；搜索时传搜索结果，不分组
export function renderChatsList(list, searching = false) {
  const rows = list || S.chats || [];
  $('#chatCount').textContent = (S.chats || []).length || '';
  let group = '';
  $('#chatsList').innerHTML = rows.map((c) => {
    const g = searching ? '' : chatGroup(c.updatedAt);
    const head = g !== group ? `<div class="dgroup">${(group = g)}</div>` : '';
    return `${head}<div class="dchat${c.id === S.currentChat ? ' on' : ''}">
      <button type="button" class="dchatopen" data-chat-open="${esc(c.id)}"><b>${esc(c.title)}</b>${searching && c.preview ? `<small>${esc(c.preview)}</small>` : ''}</button>
      <button type="button" class="dchatdel" data-chat-del="${esc(c.id)}" aria-label="删除这个聊天" title="删除">×</button>
    </div>`;
  }).join('') || `<div class="dempty">${searching ? '没找到相关的聊天' : '还没有聊天'}</div>`;
}

const HIST_OPEN_KEY = 'cattuan.histOpen';
function setHistOpen(open, remember = true) {
  if (remember) store.set(HIST_OPEN_KEY, open);
  $('#chatsList').hidden = !open;
  $('#histToggle').setAttribute('aria-expanded', String(open));
  $('#histToggle').classList.toggle('open', open);
}
$('#histToggle').addEventListener('click', () => setHistOpen($('#chatsList').hidden));

function openDrawer() {
  togglePanel(false);
  $('#chatSearch').value = '';
  renderChatsList();
  setHistOpen(store.get(HIST_OPEN_KEY, false), false);
  $('#drawer').hidden = false;
  loadState(); // 拿最新的标题和时间
}
export const closeDrawer = () => { $('#drawer').hidden = true; };
export const drawerOpen = () => !$('#drawer').hidden;

export async function chatAction(url, method) {
  if (MOCK) return false;
  const r = await fetch(url, { method });
  if (!r.ok) { alert((await r.json().catch(() => ({}))).error || '没弄成'); return false; }
  await loadState();
  $('#messages').scrollTop = $('#messages').scrollHeight; // 换了聊天，从最新一条看起
  return true;
}

async function startNewChat() {
  togglePanel(false);
  if (await chatAction('/api/chats', 'POST')) { closeDrawer(); showView('chat'); $('#input').focus(); }
}

// 聊天是首页；目标、后台任务是从侧边栏进去的二级页面，顶栏左边变成 ‹ 返回
export function showView(view) {
  if (!['chat', 'goals', 'tasks'].includes(view)) view = 'chat';
  for (const v of ['chat', 'goals', 'tasks']) $(`#${v}View`).hidden = v !== view;
  $('.top').classList.toggle('sub', view !== 'chat');
  $('#topLeft').setAttribute('aria-label', view === 'chat' ? '打开侧边栏' : '返回聊天');
  $('#topTitle').textContent = VIEW_TITLE[view] || currentChat()?.title || NEW_CHAT_TITLE;
  closeDrawer();
  if (!MOCK) store.set('cattuan.view', view);
}

// 顶栏左边：聊天页是 ☰ 打开侧边栏，目标 / 任务页是 ‹ 返回聊天
$('#topLeft').addEventListener('click', () => ($('#chatView').hidden ? showView('chat') : openDrawer()));

$('#drawer').addEventListener('click', async (e) => {
  if (!e.target.closest('.drawerbody')) return closeDrawer(); // 点右边的遮罩关掉
  if (e.target.closest('[data-chat-new]')) return startNewChat();
  const view = e.target.closest('[data-goto-view]')?.dataset.gotoView;
  if (view) { closeDrawer(); return showView(view); }
  const viewer = e.target.closest('[data-open-viewer]')?.dataset.openViewer;
  if (viewer) { closeDrawer(); return viewer === 'id' ? openIdCard() : openResume(); }
  const del = e.target.closest('[data-chat-del]')?.dataset.chatDel;
  if (del) {
    const c = (S.chats || []).find((x) => x.id === del);
    if (confirm(`删除聊天「${c?.title || ''}」？聊天内容会删掉，后台任务和目标不受影响。`)) await chatAction(`/api/chats/${del}`, 'DELETE');
    if ($('#chatSearch').value.trim()) searchChats();
    return;
  }
  const open = e.target.closest('[data-chat-open]')?.dataset.chatOpen;
  if (open) {
    if (open !== S.currentChat) await chatAction(`/api/chats/${open}/open`, 'POST');
    closeDrawer();
    showView('chat');
  }
});

// 搜索聊天记录：标题和所有消息内容都搜（服务端搜，结果带命中的那句话）
let searchTimer = null;
async function searchChats() {
  const q = $('#chatSearch').value.trim();
  setHistOpen(q ? true : store.get(HIST_OPEN_KEY, false), false); // 搜的时候展开，清空后恢复原来的折叠状态
  if (!q) return renderChatsList();
  try {
    const d = await (await fetch(`/api/chats?q=${encodeURIComponent(q)}`)).json();
    if ($('#chatSearch').value.trim() === q) renderChatsList(d.chats || [], true);
  } catch {}
}
$('#chatSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(searchChats, 200); });

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-logout]')) fetch('/api/auth/logout', { method: 'POST' }).finally(() => location.replace('/login'));
});
