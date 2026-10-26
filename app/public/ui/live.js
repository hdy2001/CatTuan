// 浏览器实时画面（沙箱在做什么，仿 Claude Cowork）和聊天页右下角的「小电视」：后台任务在跑时直播它在干什么，可以收起。
import { $, esc, store, elapsed } from './util.js';
import { S, isActive } from './state.js';
import { stepTitle, currentStep } from './tasks.js';

export const liveFrames = new Map(); // taskId → 最新一帧 { data, url }

export function frameSrc(t) {
  const f = liveFrames.get(t.id);
  return f ? `data:image/jpeg;base64,${f.data}` : t.browser?.frames?.at(-1)?.src || '';
}

// 任务详情里正在用浏览器的那一步下面的实时画面。实时帧不放进 HTML（一帧几十 KB，重画时也不用换图），由 paintLive 填进去
export function liveView(t) {
  const b = t.browser;
  const url = liveFrames.get(t.id)?.url || b.frames?.at(-1)?.url || '';
  const still = liveFrames.has(t.id) ? '' : b.frames?.at(-1)?.src || '';
  return `<div class="bview live">
    <div class="bchrome"><span class="bdots"><i></i><i></i><i></i></span><span class="burl" data-burl="${t.id}">${esc(url.replace(/^https?:\/\//, ''))}</span><span class="blive">● 实时</span></div>
    <div class="bscreen"><img data-bimg="${t.id}"${still ? ` src="${esc(still)}"` : ''} alt=""></div>
    <div class="bcaption"><i class="spin"></i><span>${esc(b.actions?.at(-1)?.text || '打开浏览器')}</span></div>
  </div>`;
}

// 新帧到了只换图片和地址栏，不整块重画。
export function paintLive(id) {
  const f = liveFrames.get(id);
  if (!f) return;
  document.querySelectorAll(`[data-bimg="${id}"]`).forEach((img) => { img.src = `data:image/jpeg;base64,${f.data}`; });
  document.querySelectorAll(`[data-burl="${id}"]`).forEach((el) => { el.textContent = (f.url || '').replace(/^https?:\/\//, ''); });
}

// ---------- 小电视 ----------
const TV_HIDDEN_KEY = 'cattuan.tvHidden';
let tvHtml = null;

export function renderTV() {
  // 例行的目标检查不上小电视；到点办一次的（比如约好的重拨）是答应过用户的事，看得到
  const list = S.tasks.filter((t) => isActive(t) && (t.kind !== 'goal' || S.goals.find((g) => g.id === t.goalId)?.schedule?.once));
  // 有实时浏览器画面的优先，其次最近开始的
  const t = list.find((x) => x.browser?.active && x.status === 'running' && frameSrc(x))
    || list.filter((x) => x.status === 'running').sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0] || list[0];
  const hidden = store.get(TV_HIDDEN_KEY, false);
  let html = '';
  if (t) {
    const live = t.browser?.active && t.status === 'running' && frameSrc(t);
    const step = t.status === 'queued' ? '排队中' : stepTitle(currentStep(t)) || '思考中';
    const doing = live ? t.browser.actions?.at(-1)?.text || step : step;
    const count = list.length > 1 ? `<b class="tvcount">${list.length}</b>` : '';
    html = hidden
      ? `<button type="button" class="tvmini" data-tv-toggle aria-label="展开小电视" title="后台：${esc(t.title)}"><span aria-hidden="true">📺</span><i class="tvdot"></i>${count}</button>`
      : `<div class="tvset">
          <span class="tvant" aria-hidden="true"></span>${count}
          <button type="button" class="tvscreen" data-goto-task="${t.id}" aria-label="查看后台任务：${esc(t.title)}">
            ${live ? `<img data-bimg="${t.id}" src="${live}" alt="">` : `<span class="tvidle"><i class="spin"></i><b>${esc(step)}</b></span>`}
            <span class="tvtitle">${esc(t.title)}${t.round > 1 ? ` · 第 ${t.round} 轮` : ''}</span>
          </button>
          <div class="tvbar"><i class="tvdot"></i><span class="tvdoing">${esc(doing)}</span>${t.status === 'running' ? `<span class="tvtime" data-elapsed="${t.id}">${elapsed(t)}</span>` : ''}
            <button type="button" class="tvhide" data-tv-toggle aria-label="收起小电视" title="收起">–</button></div>
          <span class="tvlegs" aria-hidden="true"></span>
        </div>`;
  }
  $('#chatView').classList.toggle('tv-on', !!t && !hidden);
  $('#chatView').classList.toggle('tv-mini', !!t && hidden);
  if (html === tvHtml) return; // 没变就不重画（新帧只换图片，见 paintLive）
  const appearing = $('#tv').hidden && !!t;
  tvHtml = html;
  $('#tv').innerHTML = html;
  $('#tv').hidden = !t;
  if (appearing) { $('#tv').classList.add('appear'); setTimeout(() => $('#tv').classList.remove('appear'), 400); }
}

$('#tv').addEventListener('click', (e) => {
  if (!e.target.closest('[data-tv-toggle]')) return;
  store.set(TV_HIDDEN_KEY, !store.get(TV_HIDDEN_KEY, false));
  renderTV();
  $('#tv').classList.add('appear'); // 收起 / 展开时动一下
  setTimeout(() => $('#tv').classList.remove('appear'), 400);
});
// 小电视（和演示控制条）放在输入框上方：输入框（和加号面板、演示入口）高度变了就跟着挪。设在根上，挂在 body 上的演示控制条也能用
new ResizeObserver(() => document.documentElement.style.setProperty('--composer-h', `${$('#composer').offsetHeight}px`)).observe($('#composer'));
