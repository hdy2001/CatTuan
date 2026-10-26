// 顶栏状态和计时：喵团（主 agent）手上有事时显示正在做的那一步（同时几件事就显示最新那件，带件数）；
// 没事时显示后台任务数或「在线」。进行中的任务每秒刷新计时。
import { $, elapsed } from './util.js';
import { S, taskById } from './state.js';

let online = false;
export function setOnline(v) { online = v; setStatusText(); }

export function setStatusText() {
  const active = S.tasks.filter((t) => t.status === 'running').length;
  const busy = (S.activity || []).filter((a) => a.status === 'running');
  const now = busy.at(-1);
  $('#dot').classList.toggle('on', online);
  $('#dot').classList.toggle('busy', online && !!now);
  $('#topStatus').classList.toggle('busy', online && !!now);
  $('#statusText').textContent = !online ? '连接中…'
    : now ? `${now.step || '想想怎么回'}…${busy.length > 1 ? ` · ${busy.length} 件事` : ''}`
    : active ? `后台 ${active} 个任务进行中` : '在线';
  $('#topStatus').title = now ? `${now.title}：${now.step || ''}` : '';
}

// HTML 里不放秒数（不然每次重画都算「变了」），重画后和每秒都填一次
export function tickElapsed() {
  document.querySelectorAll('[data-elapsed]').forEach((el) => {
    const t = el.dataset.elapsed && taskById(el.dataset.elapsed);
    if (t && t.status === 'running') el.textContent = elapsed(t);
  });
}
setInterval(tickElapsed, 1000);
