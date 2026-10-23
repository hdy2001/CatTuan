// 喵团前端：聊天（调度者短回复 + 任务/目标结果）、目标（持续目标 + 最新状态）、任务（后台执行 agent 状态）。
// 所有数据在服务端，/api/state 拉全量，/api/events（SSE）推增量。
// 演示模式（?mock=booking 等）：用 mock/ 下的脚本和假数据演示新流程（给 PRD 截交互图），不连服务端、不写任何数据。
import { bookingHtml, callHtml, openCallLog, openCallDetail } from './booking.js';

const $ = (s) => document.querySelector(s);
const MOCK = new URLSearchParams(location.search).get('mock');
let mock = null; // 演示脚本：{ send(text, images) }
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
// 登录过期、账号被停用：任何接口返回 401 就回登录页（演示模式不连服务端，不用管）
if (!MOCK) {
  const rawFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const r = await rawFetch(...args);
    if (r.status === 401 && String(args[0]).startsWith('/api/')) location.replace('/login');
    return r;
  };
}
const isAdmin = () => S.me?.role === 'admin';

const STATUS = { queued: '排队中', running: '进行中', done: '已完成', failed: '失败', stopped: '已停止', waiting: '待你决定' };

let S = { messages: [], tasks: [], goals: [] };
let pending = [];
let waitingReply = 0; // 发出去还没等到回复的消息数（可以连着发，喵团一条条回）

// ---------- 工具 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const imgProxy = (u) => `/api/img?u=${encodeURIComponent(u)}`;
const thumbSrc = (u) => (/\.bing\.net\//.test(u) ? u : imgProxy(u)); // 必应缩略图可直连，其余走代理（补 Referer / 翻墙）
const renderText = (t) => esc(t).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[\s(（])(https?:\/\/[^\s<>"）)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
  .replace(/\n{3,}/g, '\n\n').trim();

// ---------- 研究报告（和普通任务的完整结果）：聊天里是一张卡片，点开是全屏阅读页 ----------
const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; } };

// 简易 Markdown：标题、列表、表格、加粗、链接；正文里的 [n] 链到来源
function mdInline(text, byN) {
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(（:：])(https?:\/\/[^\s<>")　-〿＀-￯]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
    .replace(/\[(\d+)\]/g, (m, n) => {
      const src = byN.get(Number(n));
      return src ? `<a class="cite" href="${esc(src.url)}" target="_blank" rel="noopener noreferrer" title="${esc(src.title)}">[${n}]</a>` : m;
    });
}

function mdHtml(src, byN) {
  const out = [];
  let list = null;
  let table = null;
  const flush = () => {
    if (list) out.push(`<${list.tag}${list.start > 1 ? ` start="${list.start}"` : ''}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`);
    if (table?.length) {
      out.push(`<div class="mdtable"><table><thead><tr>${table[0].map((c) => `<th>${c}</th>`).join('')}</tr></thead>`
        + `<tbody>${table.slice(1).map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    }
    list = null; table = null;
  };
  for (const raw of String(src || '').split('\n')) {
    const line = raw.trim();
    let m;
    if (!line) { flush(); continue; }
    if (/^\|.*\|$/.test(line)) {
      if (list) flush();
      table ||= [];
      if (!/^\|[\s:|-]+\|$/.test(line)) table.push(line.slice(1, -1).split('|').map((c) => mdInline(c.trim(), byN)));
      continue;
    }
    if (table) flush();
    if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) { flush(); const h = Math.min(m[1].length + 2, 6); out.push(`<h${h}>${mdInline(m[2], byN)}</h${h}>`); continue; }
    if ((m = /^([-*•]|\d+[.、)）])\s+(.*)$/.exec(line))) {
      const tag = /\d/.test(m[1]) ? 'ol' : 'ul';
      if (list && list.tag !== tag) flush();
      list ||= { tag, items: [], start: parseInt(m[1], 10) || 1 }; // 条目中间夹着「电话：…」这类行时列表会断开，接着原来的序号编
      list.items.push(mdInline(m[2], byN));
      continue;
    }
    flush();
    out.push(`<p>${mdInline(line, byN)}</p>`);
  }
  flush();
  return out.join('');
}

// 卡片上的一句话摘要：报告第一段（结论），去掉 Markdown 符号和引用编号
function reportSummary(r) {
  const first = String(r.body || '').split('\n').map((l) => l.trim()).find((l) => l && !/^[#|]/.test(l)) || '';
  return first.replace(/^[-*•]\s+/, '').replace(/\*\*/g, '').replace(/\s*\[\d+\]/g, '').slice(0, 70);
}

// 卡片和阅读页上标的类型：研究报告带来源数；普通任务的完整结果（kind: 'result'）没有来源
const reportKind = (r) => (r.kind === 'result' ? '完整结果' : `研究报告 · ${(r.sources || []).length} 个来源`);

function reportCard(m) {
  const r = m.report;
  return `<div class="reportcard" role="button" tabindex="0" data-open-report="${esc(m.id)}">
    <span class="ricon">📑</span>
    <span class="rinfo"><b>${esc(r.title || '研究报告')}</b><small>${esc(reportSummary(r))}</small>
      <em>${reportKind(r)} · 约 ${String(r.body || '').length} 字</em></span>
  </div>`;
}

function openReport(id) {
  const m = S.messages.find((x) => x.id === id);
  if (!m?.report) return;
  const r = m.report;
  const byN = new Map((r.sources || []).map((x) => [x.n, x]));
  $('#rrTitle').textContent = r.title || '研究报告';
  $('#rrMeta').textContent = `${reportKind(r)} · ${clock(m.at)}`;
  const sources = (r.sources || []).map((x) => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title || x.url)}</a><small>${esc(hostOf(x.url))}</small></li>`).join('');
  $('#rrBody').innerHTML = mdHtml(r.body, byN) + (sources ? `<section class="rrsrc"><h4>来源</h4><ol>${sources}</ol></section>` : '');
  $('#rrBody').scrollTop = 0;
  $('#reportReader').hidden = false;
}

$('#reportReader').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-rr]')?.dataset.rr;
  if (e.target === $('#reportReader') || act === 'close') $('#reportReader').hidden = true;
  if (act === 'copy') {
    try { await navigator.clipboard.writeText($('#rrBody').innerText); e.target.closest('[data-rr]').textContent = '✓'; } catch { alert('复制失败，长按文字手动复制'); }
    setTimeout(() => { const b = $('[data-rr=copy]'); if (b) b.textContent = '⧉'; }, 1500);
  }
});

const taskById = (id) => S.tasks.find((t) => t.id === id);
// 没接通的自动重拨（一次性目标跑的任务）：不像例行的目标检查那样藏起来，小电视里也看得到
const isRedial = (t) => t.kind === 'goal' && S.goals.some((g) => g.id === t.goalId && g.kind === 'redial');

const fmtSecs = (s) => (s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`);
function elapsed(t) {
  const start = Date.parse(t.startedAt || t.createdAt);
  const end = t.endedAt ? Date.parse(t.endedAt) : Date.now();
  return fmtSecs(Math.max(0, Math.round((end - start) / 1000)));
}
const clock = (iso) => new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

function galleryHtml(photos) {
  if (!photos?.length) return '';
  return `<div class="gallery n${Math.min(photos.length, 3)}">${photos.map((p) => `
    <figure>
      <img src="${esc(thumbSrc(p.thumb))}" data-full="${esc(imgProxy(p.image))}" data-page="${esc(p.page || '')}" data-site="${esc(p.site)}"
           alt="${esc(p.title)}" loading="lazy" referrerpolicy="no-referrer">
      <figcaption>${esc(p.site.replace(/^www\./, ''))}</figcaption>
    </figure>`).join('')}</div>`;
}

// ---------- 聊天 ----------
// ---------- 浏览器实时画面（沙箱在做什么，仿 Claude Cowork） ----------
const liveFrames = new Map(); // taskId → 最新一帧 { data, url }

function frameSrc(t) {
  const f = liveFrames.get(t.id);
  return f ? `data:image/jpeg;base64,${f.data}` : t.browser?.frames?.at(-1)?.src || '';
}

// 任务详情里正在用浏览器的那一步下面的实时画面。实时帧不放进 HTML（一帧几十 KB，重画时也不用换图），由 paintLive 填进去
function liveView(t) {
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
function paintLive(id) {
  const f = liveFrames.get(id);
  if (!f) return;
  document.querySelectorAll(`[data-bimg="${id}"]`).forEach((img) => { img.src = `data:image/jpeg;base64,${f.data}`; });
  document.querySelectorAll(`[data-burl="${id}"]`).forEach((el) => { el.textContent = (f.url || '').replace(/^https?:\/\//, ''); });
}

// 任务结果消息：同一 taskId 的后一条（目标推送也算）
const isResultMsg = (m) => m.role === 'bot' && m.taskId && ((m.goalId && m.taskId) || S.messages.some((x) => x.taskId === m.taskId && x.at < m.at));

function msgHtml(m) {
  // 任务结果消息（同一 taskId 的后一条）在时间后面跟一行小字链到任务，像真人聊天一样不另外占一个框；目标带来的新进展标目标名。
  // 进行中的任务不在聊天里挂状态条，看右下角的小电视。
  const goal = m.goalId && S.goals.find((g) => g.id === m.goalId);
  const fromGoal = m.role === 'bot' && m.goalId && m.taskId;
  const isResult = isResultMsg(m);
  const resultOf = isResult && !fromGoal ? taskById(m.taskId) : null;
  let html = '';
  if (fromGoal) html += `<button type="button" class="pushtag" data-goto-goal="${m.goalId}">🎯 来自目标：${esc(goal?.title || '已删除的目标')}</button>`;
  if (m.images?.length) html += `<div class="thumbs">${m.images.map((u) => `<img src="${esc(u)}" alt="">`).join('')}</div>`;
  if (m.text || m.photos?.length) html += `<div class="bubble">${renderText(m.text)}${galleryHtml(m.photos)}</div>`;
  if (m.report?.body) html += reportCard(m);
  if (m.booking) html += bookingHtml(m.booking);
  // 一键选项只给演示流程（?mock=）用；以前普通搜索存下的选项不再显示
  if (m.options?.length && MOCK) html += `<div class="qopts">${m.options.map((o) => `<button type="button" class="qopt" data-quick="${esc(o.send)}">${esc(o.label)}</button>`).join('')}</div>`;
  if (m.goalId && !m.taskId && goal) html += `<button type="button" class="taskchip done" data-goto-goal="${goal.id}"><b>🎯</b>新目标：${esc(goal.title)} · ${esc(scheduleLabel(goal.schedule))}</button>`;
  const part = m.partOf && !m.taskId; // 拆开发的前几条
  // 挂了通话组件的（打电话的结果）不再显示来源：点通话组件就能看这通电话的详情（仿 Cue）
  const meta = resultOf && m.booking?.type !== 'calls'
    ? `<div class="msgmeta"><time>${clock(m.at)}</time><button type="button" class="fromtask" data-goto-task="${resultOf.id}">来自后台任务 ›</button></div>`
    : `<time>${clock(m.at)}</time>`;
  return `<div class="msg ${m.role}${fromGoal ? ' push' : ''}${part ? ' part' : ''}" data-mid="${m.id}">${html}${part ? '' : meta}</div>`;
}

// 喵团在干活、做完会在这个聊天里回话时显示「…」（仿 Muse：执行过程聊天里只有省略号，做到哪一步看顶栏状态）
const agentTyping = () => waitingReply > 0
  || (S.activity || []).some((a) => a.status === 'running' && a.replyIn && a.replyIn === S.currentChat);
// 没有内容的机器人消息不画（以前的普通搜索会先放一条空消息占位）
const visibleMsg = (m) => m.role !== 'bot' || m.text || m.photos?.length || m.report?.body || m.booking || (m.options?.length && MOCK);

// 按消息 id 增量更新，只重画内容变了的消息：整块重画会让图片每来一条消息就重新加载一遍。
function renderChat() {
  const box = $('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const old = new Map([...box.children].map((el) => [el.dataset.mid, el]));
  const typing = agentTyping();
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
  if (typing) box.insertAdjacentHTML('beforeend', '<div class="msg bot" data-mid="_typing"><div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div></div>');
  if (nearBottom || waitingReply) box.scrollTop = box.scrollHeight;
}

// ---------- 小电视悬浮窗：后台任务在跑时，聊天页右下角直播它在干什么（浏览器画面 / 当前步骤），可以收起 ----------
const TV_HIDDEN_KEY = 'cattuan.tvHidden';
let tvHtml = null;

function renderTV() {
  const list = S.tasks.filter((t) => (t.status === 'running' || t.status === 'queued') && (t.kind !== 'goal' || isRedial(t)));
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

// ask：在提问选项卡上选完时带上 { id: 那条消息, answers }，服务端据此把选项卡收起来
async function send(text, images, ask) {
  if (!text.trim() && !images.length) return;
  if (MOCK) return mock?.send(text, images);
  // 喵团在想上一条时也能接着发（仿 Muse）：每条各自回，顶栏状态显示它在做哪一步
  waitingReply++;
  // 先本地显示，服务端广播回来时按内容去重。
  S.messages.push({ id: `local_${Date.now()}`, role: 'me', text, images, at: new Date().toISOString(), local: true });
  renderChat();
  try {
    const r = await fetch('/api/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, images, ...(ask && { ask }) }) });
    if (!r.ok) throw new Error((await r.json()).error || r.status);
  } catch (e) {
    waitingReply = Math.max(0, waitingReply - 1);
    S.messages.push({ id: `local_err_${Date.now()}`, role: 'bot', text: `发送失败：${e.message}`, at: new Date().toISOString(), local: true });
    renderChat();
  }
}

// ---------- 后台任务（仿 Muse）：每行是类别图标、标题、一句最新动态和时间，按今天 / 昨天分组；点一行从底部弹出详情 ----------
// 详情是这个任务的轨迹：MAIN 是喵团（调度者）替你做的事，SUBAGENT 是执行 agent 每一轮调的工具，用浏览器的那一步里有实时画面和回放。

// 类别：调度者派任务时按用户的话分好（task.category）；老任务、目标检查、演示里的任务按关键词猜
const TASK_CATS = {
  life: { name: '生活', svg: '<svg viewBox="0 0 24 24"><path d="M5 9.6h11.2v4A5.4 5.4 0 0 1 10.8 19h-.4A5.4 5.4 0 0 1 5 13.6z" fill="currentColor"/><path d="M16.2 11.2h1.2a2.3 2.3 0 0 1 0 4.6h-1.9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M8.6 4.4c-.9 1 .9 1.7 0 2.8M12.4 4.4c-.9 1 .9 1.7 0 2.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity=".6"/></svg>' },
  work: { name: '工作', svg: '<svg viewBox="0 0 24 24"><path d="M9 7V5.8C9 4.8 9.8 4 10.8 4h2.4c1 0 1.8.8 1.8 1.8V7" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="3.5" y="7" width="17" height="12.5" rx="2.6" fill="currentColor"/><path d="M3.8 12.2h16.4" stroke="#fff" stroke-opacity=".5" stroke-width="1.3"/><rect x="10.3" y="10.8" width="3.4" height="2.8" rx=".9" fill="#fff" fill-opacity=".92"/></svg>' },
  coding: { name: '编程', svg: '<svg viewBox="0 0 24 24"><path d="M8.6 7.4L4 12l4.6 4.6M15.4 7.4L20 12l-4.6 4.6M13.5 5.4l-3 13.2" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>' },
  social: { name: '社交', svg: '<svg viewBox="0 0 24 24"><path d="M18.8 9.6c1 .5 1.7 1.5 1.7 2.7v3.3c0 1.3-.9 2.3-2.1 2.6V20l-2.9-2h-3c-1 0-1.9-.5-2.4-1.3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" opacity=".6"/><path d="M3.5 6.9C3.5 5.3 4.8 4 6.4 4h7.7c1.6 0 2.9 1.3 2.9 2.9v4.5c0 1.6-1.3 2.9-2.9 2.9H9.5l-3.4 2.5v-2.6A2.9 2.9 0 0 1 3.5 11.4z" fill="currentColor"/><circle cx="7.4" cy="9.2" r="1" fill="#fff"/><circle cx="10.3" cy="9.2" r="1" fill="#fff"/><circle cx="13.2" cy="9.2" r="1" fill="#fff"/></svg>' },
};
// 关键词打分：编程的词少而准，一个算两分；打平时按 编程 > 社交 > 工作 > 生活；一个都没中算生活
const CAT_WORDS = [
  ['coding', 2, /代码|编程|程序|脚本|网页|网站|页面|H5|html|css|小游戏|bug|报错|接口|API|部署|github|开发|调试|前端|后端|数据库|sql|python|javascript|插件|爬虫/gi],
  ['social', 1, /微博|小红书|推特|twitter|\bX\b|instagram|\bins\b|weverse|B ?站|抖音|博主|账号|粉丝|爱豆|偶像|明星|朋友|同事|家人|聚会|生日|礼物|送礼|约会|社交|评论|追星|应援|回归/gi],
  ['work', 1, /工作|调研|研究|报告|行业|市场|竞品|公司|融资|论文|PPT|文档|会议|邮件|简历|面试|招聘|项目|客户|分析|产品|商业|投资|股票|财报|新闻|资讯|政策|学习|课程|考试|资料|翻译|\bAI\b|模型|OpenAI/gi],
  ['life', 1, /天气|吃|美食|餐厅|饭|外卖|咖啡|奶茶|酒店|民宿|机票|火车|高铁|旅行|旅游|攻略|景点|电影|演出|门票|购物|买|价格|优惠|快递|记账|预算|消费|健康|医院|体检|喝水|睡|提醒|健身|运动|美甲|理发|按摩|SPA|预约|订位|电话|商K|KTV|租房|附近|周末/gi],
];
const catCache = new Map();
function taskCat(t) {
  if (Object.hasOwn(TASK_CATS, t.category || '')) return t.category;
  if (catCache.has(t.id)) return catCache.get(t.id);
  // 目标检查的任务说明是一段固定的模板（里面有「提醒」「天气」这类词），按目标自己的标题和说明猜
  const goal = t.goalId && S.goals.find((g) => g.id === t.goalId);
  const strong = goal ? goal.title : `${t.title} ${t.query || ''}`;
  const weak = goal ? goal.brief || '' : String(t.brief || '').slice(0, 300);
  let best = 'life';
  let top = 0;
  for (const [cat, weight, re] of CAT_WORDS) {
    const n = ((strong.match(re) || []).length * 2 + (weak.match(re) || []).length) * weight;
    if (n > top) { best = cat; top = n; }
  }
  if (!t.goalId || goal) catCache.set(t.id, best);
  return best;
}

// 图标右下角的小徽标：深度搜索、目标检查、打电话（仿 Muse 的放大镜 / 闹钟）
const BADGES = {
  search: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="5.4" fill="none" stroke="currentColor" stroke-width="2.8"/><path d="M14.8 14.8l4.4 4.4" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
  goal: '<svg viewBox="0 0 24 24"><path d="M12 6.4V12l3.6 2.4" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  call: '<svg viewBox="0 0 24 24"><path d="M7.4 4h2.4l1.3 3.6-1.7 1.2a10 10 0 0 0 5.8 5.8l1.2-1.7 3.6 1.3v2.4a1.8 1.8 0 0 1-2 1.8A15 15 0 0 1 5.6 6a1.8 1.8 0 0 1 1.8-2z" fill="currentColor"/></svg>',
};
const taskKind = (t) => (isRedial(t) || t.kind === 'call' || t.callMode || t.call ? 'call' : t.kind === 'goal' ? 'goal' : t.kind === 'research' ? 'research' : 'chat');
const KIND_NAME = { call: '打电话', goal: '目标检查', research: '深度搜索', chat: '对话任务' };
const kindName = (t) => (isRedial(t) ? '自动重拨' : KIND_NAME[taskKind(t)]);

function taskIcon(t, mini = false) {
  const cat = taskCat(t);
  const badge = !mini && { research: 'search', goal: 'goal', call: 'call' }[taskKind(t)];
  const busy = mini ? '' : t.status === 'running' ? ' busy' : t.status === 'queued' ? ' wait' : '';
  return `<span class="ticon c-${cat}${mini ? ' mini' : ''}${busy}" aria-hidden="true">${TASK_CATS[cat].svg}${badge ? `<i class="tbadge b-${badge}">${BADGES[badge]}</i>` : ''}</span>`;
}

// 这一步的标题：新任务每一步都有服务端写好的一句人话（按工具参数和结果），老任务只有工具的中文名
const stepTitle = (s) => (s ? s.title || (s.status === 'running' ? `正在${s.label}` : s.label) || '' : '');
// 正在做的那一步：工具可能并行，取最后一个还在跑的；都跑完了取最后一步
const currentStep = (t) => [...(t.steps || [])].reverse().find((s) => s.status === 'running') || t.steps?.at(-1);
const isActive = (t) => t.status === 'running' || t.status === 'queued';

// 结果里第一句有内容的话：目标检查的 STATUS 行就是结论；研究报告从 REPORT: 后面算（前面是 agent 边做边说的话）；
// 跳过小标题（「当前数据：」这种）和 Markdown 符号
function firstLine(text) {
  const raw = String(text || '');
  const status = /^\s*STATUS[:：]\s*(.+)$/im.exec(raw)?.[1];
  const report = raw.split(/^\s*REPORT[:：]\s*$/m).at(-1);
  const line = status || report.split('\n').map((l) => l.replace(/^[>*•\-\s]+|\*\*/g, '').trim())
    .find((l) => l && !/^[#|]/.test(l) && !/^(NEW|DONE|GALLERY|REPORT|SOURCES)[:：]/i.test(l) && !/[：:]$/.test(l)) || '';
  return line.length > 80 ? `${line.slice(0, 80)}…` : line.trim();
}

// 一段话里的第一句（喵团转述时可能连着发了两三条）
const oneSentence = (text) => String(text || '').trim().split(/(?<=[。！？!?])\s*/).find(Boolean) || '';

// 「最新动态」：只有一句话。在跑的说正在做哪一步（用浏览器时说浏览器里在干什么），做完的是喵团最后跟你说的那句
function latestLine(t) {
  if (t.status === 'queued') return (t.round || 1) > 1 ? `排队中，马上按你的修改做第 ${t.round} 轮` : t.resumed ? '排队中，App 重启过，马上接着做' : '排队中，马上开始';
  if (t.status === 'running') {
    if (t.stopRequested) return '正在停下…';
    return (t.browser?.active && t.browser.actions?.at(-1)?.text) || stepTitle(currentStep(t)) || '在想怎么做';
  }
  const said = oneSentence(t.history?.at(-1)?.said?.text);
  if (t.status === 'done') return said || oneSentence(firstLine(t.result?.text)) || '做完了';
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

// 按 key 增量更新子元素，只换 HTML 变了的（和 renderChat 一个思路）：任务一直在推进度，整块重画会闪、会丢掉展开状态
function patchList(box, items) {
  const old = new Map([...box.children].map((el) => [el.dataset.key, el]));
  let prev = null;
  for (const { key, html } of items) {
    let el = old.get(key);
    old.delete(key);
    if (!el || el._html !== html) {
      const tpl = document.createElement('template');
      tpl.innerHTML = html.trim();
      const node = tpl.content.firstElementChild;
      node.dataset.key = key;
      node._html = html;
      if (el) el.replaceWith(node);
      el = node;
    }
    if ((prev ? prev.nextElementSibling : box.firstElementChild) !== el) prev ? prev.after(el) : box.prepend(el);
    prev = el;
  }
  old.forEach((el) => el.remove());
}

function renderTasks() {
  const list = [...S.tasks].sort((a, b) => taskTime(b) - taskTime(a) || String(b.createdAt).localeCompare(String(a.createdAt)));
  const items = [];
  let group = '';
  for (const t of list) {
    const g = chatGroup(new Date(taskTime(t)).toISOString());
    if (g !== group) items.push({ key: `g:${(group = g)}`, html: `<h3 class="tgroup">${g}</h3>` });
    items.push({ key: t.id, html: taskRow(t) });
  }
  if (!items.length) items.push({ key: 'empty', html: '<div class="empty">还没有后台任务。让喵团查资料、找图、打电话时，它会派执行 agent 去干活。</div>' });
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
let openTaskId = null;
const openSteps = new Set(); // 展开了的步骤
let openResult = false; // 结果全文展开了没有

const STEP_ICON = {
  done: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6.3 10.3l2.4 2.4 5-5.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 5.8v5.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="14.1" r="1.1" fill="currentColor"/></svg>',
  fail: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M7.2 7.2l5.6 5.6M12.8 7.2l-5.6 5.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  cut: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.6 2.4"/><path d="M6.6 10h6.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  wait: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.6 2.4"/></svg>',
  running: '<i class="tsspin"></i>',
};
const CHEVRON = '<svg class="tschev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// MAIN：喵团（调度者）替你做的事——收到消息、派执行 agent、转达修改、把结果告诉你
function mainSteps(t) {
  const goal = t.goalId && S.goals.find((g) => g.id === t.goalId);
  const kind = taskKind(t);
  const list = [];
  if (isRedial(t)) list.push({ title: '到点自动重拨', detail: goal ? `之前没打通的电话，约好${scheduleLabel(goal.schedule)}再打` : '', at: t.createdAt });
  else if (t.kind === 'goal') list.push({ title: `检查目标「${goal?.title || t.title.replace(/^目标：/, '')}」`, detail: goal ? `${scheduleLabel(goal.schedule)} · ${goal.brief}` : '', at: t.createdAt });
  else if (t.query) list.push({ title: '收到你的消息', detail: `「${t.query}」`, at: t.createdAt });
  list.push({
    title: kind === 'goal' ? '派执行 agent 去检查' : isRedial(t) ? '派执行 agent 再打一次' : `派执行 agent ${kind === 'research' ? '深度搜索' : '去办'}：${t.title}`,
    detail: t.brief, brief: true, at: t.createdAt,
  });
  for (const v of t.revisions || []) {
    list.push({ title: '把你的修改转给执行 agent', detail: `「${v.text}」\n${(REV_STATE[v.state] || v.state).replace('{n}', v.round)}`, at: v.at, state: v.state === 'dropped' ? 'cut' : 'done' });
  }
  for (const h of t.history || []) if (h.said) list.push({ title: saidTitle(t, h), detail: h.said.text, at: h.said.at, state: h.status === 'failed' ? 'warn' : 'done' });
  if (t.status === 'stopped') list.push({ title: '按你的要求停下了任务', at: t.endedAt || t.createdAt, state: 'cut' });
  list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  // 结果还没说：在跑的等执行 agent，刚做完的在整理（老任务没记这一步，做完超过两分钟就不显示了）
  if (isActive(t)) list.push({ title: t.status === 'queued' ? '排好队了，等执行 agent 开始' : '等执行 agent 做完，再把结果告诉你', state: 'wait' });
  else if (['done', 'failed'].includes(t.status) && t.history?.length && !t.history.at(-1).said && Date.now() - Date.parse(t.endedAt) < 120_000) list.push({ title: '整理结果，马上告诉你', state: 'running' });
  return list.map((x) => ({ state: 'done', ...x }));
}

function saidTitle(t, h) {
  const routine = t.kind === 'goal' && !isRedial(t);
  if (h.status === 'failed') return routine ? '这次检查没成功' : '告诉你没做成';
  if (routine) return h.said.quiet ? '没有新进展，没打扰你' : '有新进展，发消息告诉了你';
  return (t.history || []).filter((x) => x.said).length > 1 ? `把第 ${h.round} 轮的结果告诉你` : '把结果告诉你';
}

// SUBAGENT：执行 agent 的每一轮（第一次做、重试、按修改再做）各一段，历史记录中的子任务跟在后面、每个一段；
// 这一轮的步骤和子 agent 服务端在一轮结束时存进 history
function taskRounds(t) {
  const hist = t.history || [];
  const rounds = hist.map((h, i) => ({ ...h, steps: h.steps || (i === hist.length - 1 && !isActive(t) ? t.steps || [] : null) }));
  if (isActive(t)) rounds.push({ round: t.round || 1, status: t.status, startedAt: t.startedAt, steps: t.steps || [], agents: t.status === 'running' ? t.agents : undefined, current: true });
  else if (!rounds.length && t.steps?.length) rounds.push({ round: t.round || 1, status: t.status, startedAt: t.startedAt, endedAt: t.endedAt, steps: t.steps });
  return rounds;
}

const ROUND_END = { done: '完成', failed: '失败', stopped: '已停止', revised: '按新要求接着改' };
function roundLabel(t, r, i, all) {
  const parts = ['执行 agent'];
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

const SANDBOX_TOOLS = new Set(['deep_web_search', 'read_webpage']);

const stepItem = (s) => ({ title: stepTitle(s), detail: s.detail || '', name: s.name, at: s.at, end: s.endedAt,
  state: s.status === 'running' ? 'running' : s.cut ? 'cut' : s.ok === false ? 'warn' : 'done' });

// 一轮的几段：执行 agent 一段，它派出去的每个子 agent 各一段（编号接着往下排）。浏览器画面跨这几段一起挂（子 agent 可能同时在等浏览器）
function roundSections(t, r, i, rounds, no) {
  const last = i === rounds.length - 1;
  const kids = r.steps ? r.agents || [] : [];
  const execNo = no();
  const nos = new Map(kids.map((a) => [a.id, no()]));
  const kidNo = (a) => nos.get(a.id);
  const exec = roundItems(t, r, kidNo);
  // 子 agent 那段第一行是它接到的任务（执行 agent 写的目标常常带一长串要查的点和搜索词，标题只放第一句，全文点开看）
  const lists = kids.map((a) => [...(a.goal ? [{ title: '接到执行 agent 派的任务', detail: a.goal, at: a.startedAt, state: 'done' }] : []),
    ...r.steps.filter((s) => s.agent === a.id).map(stepItem)]);
  if (exec) {
    attachBrowser(t, [exec, ...lists], r);
    const live = r.current && t.status === 'running' && t.browser?.active;
    if (live && ![exec, ...lists].some((l) => l.some((x) => x.live))) exec.push({ title: t.browser.actions?.at(-1)?.text || '在用浏览器', state: 'running', live: true });
    if (r.current && t.status === 'queued') exec.push({ title: '排队中，等着开始', state: 'wait' });
    // 两次调工具之间是模型在想：不然看上去步骤全打了勾、却还在跑
    else if (r.current && !exec.some((x) => x.state === 'running')) exec.push({ title: exec.length ? '在想下一步' : '在想怎么做', state: 'running' });
    if (!r.current) exec.push(roundEnd(t, r, last));
    kids.forEach((a, k) => lists[k].push(...agentEnd(t, r, a, lists[k])));
  }
  return [
    ...sectionBlocks(t, `sub${i}`, execNo, roundLabel(t, r, i, rounds), exec),
    ...kids.flatMap((a, k) => sectionBlocks(t, `sub${i}:${a.id}`, kidNo(a), agentLabel(t, r, a), lists[k], goalTitle(a.goal) || '子任务')),
  ];
}

// 执行 agent 自己的步骤（子 agent 的在它们自己那段），派子 agent 的那步拆成每个子 agent 一行
function roundItems(t, r, kidNo) {
  if (!r.steps) return null; // 早期的任务只记了最后一轮
  return r.steps.some((s) => s.at)
    ? r.steps.filter((s) => !s.agent).flatMap((s) => (s.agents?.length ? delegateItems(s, r.agents || [], kidNo) : [stepItem(s)]))
    : legacySteps(t, r);
}

// 执行 agent 派子 agent 的那一步（仿 Muse 的「Launched subagent to …」）：每个子 agent 一行，再一行说在等它们还是都做完了
const agentRunning = (t, r, a) => a.status === 'running' && r.current && t.status === 'running';
const AGENT_DONE = { completed: '做完了', interrupted: '停下了', cut: '没做完' };
function delegateItems(s, kids, kidNo) {
  const mine = kids.filter((a) => s.agents?.includes(a.id));
  if (!mine.length) return [stepItem(s)];
  const left = mine.filter((a) => a.status === 'running').length;
  return [
    ...mine.map((a) => ({ title: launchTitle(goalTitle(a.goal)), detail: `${kidNo(a)} · ${a.status === 'running' ? '进行中' : AGENT_DONE[a.status] || '没做成'}`, at: a.startedAt, state: 'done' })),
    s.status === 'running'
      ? { title: mine.length > 1 ? `等 ${mine.length} 个子 agent 做完，还剩 ${left} 个` : '等子 agent 做完', state: 'running', at: s.at }
      : stepItem(s),
  ];
}
// 目标的第一句，最多 60 字
function goalTitle(goal) {
  const g = String(goal || '').trim().split('\n')[0].split('。')[0].replace(/[：:，,\s]+$/, '');
  return g.length > 60 ? `${g.slice(0, 60)}…` : g;
}
function launchTitle(goal) {
  const g = String(goal || '').replace(/\s+/g, ' ').trim();
  if (!g) return '派了个子 agent';
  return `派子 agent ${/^[\u4e00-\u9fff]/.test(g) ? '去' : '：'}${g.length > 32 ? `${g.slice(0, 32)}…` : g}`;
}

// 子 agent 那段的最后一行：在跑就是在想下一步，做完了附上它交回的结果摘要
function agentEnd(t, r, a, items) {
  if (agentRunning(t, r, a)) return items.some((x) => x.state === 'running') ? [] : [{ title: items.length ? '在想下一步' : '在想怎么做', state: 'running' }];
  if (a.status === 'completed') return [{ title: '做完了，把结果交回执行 agent', detail: a.summary || '', state: 'done' }];
  if (['interrupted', 'cut', 'running'].includes(a.status)) return [{ title: '停下了，没做完', detail: a.summary || '', state: 'cut' }];
  return [{ title: '出错了，没做完', detail: a.summary || '', state: 'fail' }];
}

function agentLabel(t, r, a) {
  const parts = ['子 agent'];
  if (agentRunning(t, r, a)) parts.push('进行中');
  else {
    parts.push(a.status === 'completed' ? '完成' : ['interrupted', 'cut', 'running'].includes(a.status) ? '已停止' : '失败');
    const secs = a.secs ?? (a.startedAt && a.endedAt ? Math.max(0, Math.round((Date.parse(a.endedAt) - Date.parse(a.startedAt)) / 1000)) : null);
    if (secs != null) parts.push(`用时 ${fmtSecs(secs)}`);
  }
  return parts.join(' · ');
}

function roundEnd(t, r, last) {
  if (r.status === 'failed') return { title: '出错了，没做完', detail: r.error || (last ? t.error : '') || '', state: 'fail' };
  if (r.status === 'stopped') return { title: '按你的要求停下了', state: 'cut' };
  if (r.status === 'revised') return { title: '这一轮做完了，按你的新要求接着改', state: 'done' };
  return { title: '做完了，把结果交给喵团', detail: last ? firstLine(t.result?.text) : '', state: 'done' };
}

// 老任务：步骤没有时间和说明，连续同类的还合并成了一步；按深度搜索记下的「搜了什么、读了哪些网页」拆回一步一步
function legacySteps(t, r) {
  const inRound = (x) => (!r.startedAt || x.at >= r.startedAt) && (!r.endedAt || x.at <= r.endedAt);
  const research = [
    ...(t.research?.searches || []).map((x) => ({ ...x, name: 'deep_web_search' })),
    ...(t.research?.reads || []).map((x) => ({ ...x, name: 'read_webpage' })),
  ].filter(inRound).sort((a, b) => a.at.localeCompare(b.at));
  const runs = []; // 连续同类的合成一段，和合并过的步骤一一对上
  for (const x of research) { if (runs.at(-1)?.[0].name === x.name) runs.at(-1).push(x); else runs.push([x]); }
  return r.steps.flatMap((s) => {
    const i = runs.findIndex((g) => g[0].name === s.name);
    if (i < 0) return [{ title: stepTitle(s), name: s.name, state: s.status === 'running' ? 'running' : 'done' }];
    return runs.splice(0, i + 1).at(-1).map((x) => (x.name === 'deep_web_search'
      ? { title: x.n == null ? `搜「${x.q}」` : x.n ? `搜「${x.q}」，找到 ${x.n} 条结果` : `搜「${x.q}」，没有结果`, name: x.name, at: x.at, state: x.n === 0 ? 'warn' : 'done' }
      : { title: x.ok === false ? `打开 ${hostOf(x.url) || x.url}，没读到内容` : `读了「${x.title || hostOf(x.url)}」`, detail: [x.url, x.ok === false && x.note].filter(Boolean).join('\n'),
        name: x.name, at: x.at, state: x.ok === false ? 'warn' : 'done' }));
  });
}

// 用沙箱浏览器的步骤：按时间把浏览器里的每个动作和关键帧（回放）挂到那一步下面；正在跑的那一步放实时画面。
// lists 是一轮里的几段（执行 agent、各个子 agent）：沙箱一次只做一件、先来先做，几个子 agent 同时在等时，
// 按开始时间先挂给先开始的那步，实时画面也只放在最先开始、还在跑的那步下面
function attachBrowser(t, lists, r) {
  const b = t.browser;
  if (!b) return;
  const used = new Set();
  const marks = lists.flat().filter((x) => x.at && SANDBOX_TOOLS.has(x.name)).sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
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
      ${s.live ? liveView(t) : ''}
    </div>
  </div>`;
}

// 一段轨迹：小标题（MAIN / SUBAGENT 01）+ 每一步各是一块（单独更新，实时画面那一步变了不会连带别的步骤重画）；子 agent 那段标题下面写它的目标
function sectionBlocks(t, key, label, sub, steps, goal) {
  const blocks = [{ key, html: `<div class="tssec"><b>${label}</b><span>${sub}</span>${goal ? `<p class="tsgoal">${esc(goal)}</p>` : ''}</div>` }];
  if (!steps) return [...blocks, { key: `${key}:none`, html: '<div class="tsnone">这一轮的步骤没有记下来</div>' }];
  return [...blocks, ...steps.map((s, i) => ({ key: `${key}:${i}`, html: stepHtml(t, s, `${key}:${i}`, i === steps.length - 1) }))];
}

function sheetHead(t) {
  const cat = taskCat(t);
  const time = t.status === 'running' ? `${dayClock(t.startedAt || t.createdAt)} 开始 · 已经 <span data-elapsed="${t.id}"></span>`
    : t.status === 'queued' ? `${dayClock(t.createdAt)} 派出`
      : `${dayClock(t.createdAt)} 派出${t.startedAt ? ` · 用时 ${elapsed(t)}` : ''}`;
  return `<header class="tshead">
    <div class="tstags"><span class="tspill ${t.status}">${STATUS[t.status] || t.status}</span><span class="tscat">${taskIcon(t, true)}${TASK_CATS[cat].name} · ${kindName(t)}</span></div>
    <h2 id="tsTitle">${esc(t.title)}</h2>
    <p class="tslatest${t.status === 'failed' ? ' bad' : ''}">${esc(latestLine(t))}</p>
    <time>${time}${(t.round || 1) > 1 ? ` · 第 ${t.round} 轮` : ''}</time>
  </header>`;
}

// 结果：研究报告挂报告卡片（点开是阅读页），其余的文字结果可以展开全文；做的网页、找到的图跟在后面
function resultBlock(t) {
  if (t.status !== 'done' || !t.result) return '';
  const r = t.result;
  const text = String(r.text || '').replace(/^\s*(STATUS|NEW|DONE)[:：].*$/gim, '').replace(/`?GALLERY:[^\n]*`?/gi, '').trim();
  const msg = S.messages.find((m) => m.taskId === t.id && m.report?.body);
  const body = msg ? reportCard(msg)
    : text ? `<div class="tsrtext${openResult || text.length <= 240 ? ' open' : ''}">${mdHtml(text, new Map())}</div>${text.length > 240 ? `<button type="button" class="tsmorebtn" data-result-more>${openResult ? '收起' : '展开全文'}</button>` : ''}` : '';
  const photos = r.photos?.length ? galleryHtml(r.photos.slice(0, 9)) : '';
  if (!body && !photos) return '';
  return `<section class="tsresult"><div class="tssec"><b>RESULT</b><span>执行 agent 交回的结果</span></div>${body}${photos}</section>`;
}

function sheetFoot(t) {
  const btns = [];
  if (t.status === 'running' || (t.status === 'queued' && t.kind !== 'goal')) {
    btns.push(`<button type="button" class="tsbtn danger" data-task-stop="${t.id}" ${t.stopRequested ? 'disabled' : ''}>${t.stopRequested ? '正在停止…' : '停止任务'}</button>`);
  }
  if (t.status === 'failed' || t.status === 'stopped') btns.push(`<button type="button" class="tsbtn primary" data-task-retry="${t.id}">${t.status === 'failed' ? '重试' : '重新开始'}</button>`);
  if (t.chatId && t.kind !== 'goal' && !isActive(t) && !MOCK) btns.push(`<button type="button" class="tsbtn" data-task-chat="${t.id}">回到聊天</button>`);
  const trace = t.traced ? traceLink(`sessions/task-${t.id}`) : '';
  return btns.length || trace ? `${btns.join('')}${trace}` : '';
}

function renderTaskSheet() {
  const t = openTaskId && taskById(openTaskId);
  if (!t) return closeTask();
  const items = [{ key: 'head', html: sheetHead(t) }];
  if (t.call) items.push({ key: 'call', html: `<div class="tscall">${callHtml(t)}</div>` });
  items.push(...sectionBlocks(t, 'main', 'MAIN', '喵团 · 主 agent', mainSteps(t)));
  const rounds = taskRounds(t);
  let n = 0;
  const no = () => `SUBAGENT ${String(++n).padStart(2, '0')}`;
  rounds.forEach((r, i) => items.push(...roundSections(t, r, i, rounds, no)));
  const result = resultBlock(t);
  if (result) items.push({ key: 'result', html: result });
  patchList($('#taskDetail'), items);
  const foot = sheetFoot(t);
  if ($('#taskFoot')._html !== foot) { $('#taskFoot').innerHTML = foot; $('#taskFoot')._html = foot; }
  $('#taskFoot').hidden = !foot;
  paintLive(t.id);
  tickElapsed();
}

function openTask(id) {
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

function closeTask() {
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
function sheetDrag(sheet, scroller, close) {
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
sheetDrag('#goalSheet', '#goalDetail', () => closeGoalSheet());

// 调试用：开了 Langfuse（scripts/start-langfuse.sh）才有。任务链到 Langfuse 会话 task-<id>（调度者 + 执行 agent 的完整轨迹）。
const traceLink = (path) => (S.traceBase ? `<a class="alink" href="${esc(`${S.traceBase}/${path}`)}" target="_blank" rel="noopener">轨迹 ›</a>` : '');

// 用户中途 / 做完后提的修改，每条的去向
const REV_STATE = {
  merged: '已并进任务说明', sent: '已发给正在跑的任务', delivered: '已按这条调整', pending: '这一轮跑完接着改',
  round: '第 {n} 轮按这条改', dropped: '任务停了，没用上',
};

// ---------- 目标 ----------
// once：一次性的（没接通的自动重拨），到点跑一次
const scheduleLabel = (s) => (s?.once ? `${dayClock(s.once)} 一次` : s?.at ? `每天 ${s.at}` : s?.every >= 60 ? `每 ${+(s.every / 60).toFixed(1)} 小时` : `每 ${s?.every} 分钟`);

function ago(iso) {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

// 今天的只写时间，别的日子带上日期
const dayClock = (iso) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? clock(iso) : `${d.getMonth() + 1}月${d.getDate()}日 ${clock(iso)}`;
};
// ---------- 目标列表（仿 Muse Goals）：「正在盯」每行是勾选框（= 完成）、标题和一句最新状态；点一行从底部弹出详情 ----------
// 暂停、现在检查、删除都在详情右上角的 ··· 里，列表上只留这三样；已完成的收起来；最下面是「新建目标」。

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
function renderGoals() {
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
let openGoalId = null;
const ALARM = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="7" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 9.6V13l2.3 1.6M4.8 5.6l2.6-2.1M19.2 5.6l-2.6-2.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ACTIVE 里那一条（仿 Muse 的定时自动化）：在查的点开看这次检查的轨迹
function goalAuto(g) {
  const s = g.schedule || {};
  const what = g.kind === 'redial' ? '重拨' : '检查';
  const name = s.once ? `${dayClock(s.once)} ${what}一次` : s.at ? `每天 ${s.at} ${what}`
    : `每 ${s.every >= 60 ? `${+(s.every / 60).toFixed(1)} 小时` : `${s.every} 分钟`}${what}一次`;
  const checking = goalChecking(g);
  const sub = checking ? '正在检查 · 点开看过程' : g.done ? '已完成，不再检查' : !g.enabled ? '已暂停'
    : g.nextRunAt ? `定时检查 · 下次 ${dayClock(g.nextRunAt)}` : '定时检查';
  const inner = `<span class="galarm">${checking ? '<i class="tsspin"></i>' : ALARM}</span><span class="gautotext"><b>${esc(name)}</b><small>${sub}</small></span>`;
  return checking ? `<button type="button" class="gautorow" data-goal-task="${checking.id}">${inner}${CHEVRON}</button>` : `<div class="gautorow">${inner}</div>`;
}

// 动态的一条：服务端记的是一句话，拆成标题（发生了什么）和说明；检查的结论本身就是标题
function goalEntry(x) {
  const t = x.text || '';
  let m;
  if ((m = /^检查：(.*?)(（有新进展，告诉你了）)?$/.exec(t))) return { title: m[1] || '检查了一次', desc: m[2] ? '有新进展，在聊天里告诉了你' : '例行检查，没打扰你' };
  if ((m = /^这次检查没成功：?(.*)$/.exec(t))) return { title: '这次检查没成功', desc: m[1], state: 'warn' };
  if ((m = /^重拨：(.*)$/.exec(t))) return { title: m[1], desc: '自动重拨了一次' };
  if ((m = /^建好目标 · (.*)$/.exec(t))) return { title: '建好目标', desc: m[1].replace(/\s*·\s*$/, '') };
  if ((m = /^完成(?:：(.*))?$/.exec(t))) return { title: '完成了', desc: m[1] || '' };
  if (t === '暂停') return { title: '暂停了检查', state: 'cut' };
  if (t === '继续检查') return { title: '继续检查' };
  const i = t.indexOf('：');
  return i > 0 ? { title: t.slice(0, i), desc: t.slice(i + 1) } : { title: t };
}

// 动态按天分组：今天 / 昨天 / 10月18日（不是今年的带上年份）
function dayLabel(iso) {
  const g = chatGroup(iso);
  if (g === '今天' || g === '昨天') return g;
  const d = new Date(iso);
  return `${d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}年`}${d.getMonth() + 1}月${d.getDate()}日`;
}

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

function renderGoalSheet() {
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

function toggleGoalMenu(open = $('#goalMenu').hidden) {
  const g = S.goals.find((x) => x.id === openGoalId);
  if (open && g) renderGoalMenu(g);
  $('#goalMenu').hidden = !(open && g);
  $('[data-goal-menu]').setAttribute('aria-expanded', String(!!(open && g)));
}

function openGoalSheet(id) {
  if (!S.goals.some((g) => g.id === id)) return;
  openGoalId = id;
  toggleGoalMenu(false);
  $('#goalSheet').hidden = false;
  renderGoalSheet();
  $('#goalDetail').scrollTop = 0;
  $('#goalSheet .tsbody').focus({ preventScroll: true });
}

function closeGoalSheet() {
  openGoalId = null;
  $('#goalMenu').hidden = true;
  $('#goalSheet').hidden = true;
}

// ---------- 同步 ----------
async function loadState() {
  if (MOCK) return; // 演示模式只用演示脚本的数据
  try { S = await (await fetch('/api/state')).json(); } catch { return; }
  renderChat(); renderTasks(); renderGoals(); renderChatBar(); renderTV(); renderMe();
  if (!$('#drawer').hidden && !$('#chatSearch').value.trim()) renderChatsList();
}

// 侧边栏底部的当前账号
function renderMe() {
  $('#meName').textContent = S.me?.name || '';
  $('#meRole').hidden = !isAdmin();
}

function connect() {
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
      const at = S.messages.findIndex((x) => x.id === m.id);
      if (at >= 0) S.messages[at] = m; else { S.messages.push(m); if (m.role === 'bot') waitingReply = Math.max(0, waitingReply - 1); } // 同一条消息会更新（普通搜索先显示过程、搜完填回答）
      renderChat();
    } else if (ev.type === 'task') {
      const i = S.tasks.findIndex((t) => t.id === ev.task.id);
      if (i >= 0) S.tasks[i] = ev.task; else S.tasks.push(ev.task);
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
      const t = taskById(ev.taskId);
      if (!t) return;
      liveFrames.set(ev.taskId, ev);
      // 第一帧到之前还没有 <img>：重画一次，之后只换图
      if (!document.querySelector(`[data-bimg="${ev.taskId}"]`)) { renderTV(); renderTasks(); }
      paintLive(ev.taskId);
    } else if (ev.type === 'activity') {
      // 喵团手上的事：在做的按开始的先后留着（顶栏显示最新那件），做完的去掉
      const list = (S.activity ||= []);
      const i = list.findIndex((a) => a.id === ev.activity.id);
      if (ev.activity.status !== 'running') { if (i >= 0) list.splice(i, 1); }
      else if (i >= 0) list[i] = ev.activity; else list.push(ev.activity);
      setStatusText();
      renderChat(); // 聊天里的「…」跟着主 agent 有没有在干活走
    } else if (ev.type === 'goal') {
      const i = S.goals.findIndex((g) => g.id === ev.goal.id);
      if (i >= 0) S.goals[i] = ev.goal; else S.goals.push(ev.goal);
      renderGoals();
    } else if (ev.type === 'goal-removed') {
      S.goals = S.goals.filter((g) => g.id !== ev.id);
      renderGoals();
    } else if (ev.type === 'chats') {
      loadState(); // 开了新聊天 / 切换 / 删除（可能是在别的设备上）
    }
  };
}

let online = false;
function setOnline(v) { online = v; setStatusText(); }
// 顶栏状态：喵团（主 agent）手上有事时显示正在做的那一步（同时几件事就显示最新那件，带件数）；
// 没事时显示后台任务数或「在线」。
function setStatusText() {
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

// 进行中的任务每秒刷新计时；重画列表和详情后也马上填一次（HTML 里不放秒数，不然每次重画都算「变了」）
function tickElapsed() {
  document.querySelectorAll('[data-elapsed]').forEach((el) => {
    const t = el.dataset.elapsed && taskById(el.dataset.elapsed);
    if (t && t.status === 'running') el.textContent = elapsed(t);
  });
}
setInterval(tickElapsed, 1000);

// ---------- 输入区（微信式：有内容显示「发送」，否则显示「+」） ----------
const input = $('#input');
function autosize() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 120)}px`; }
function syncComposer() {
  const hasContent = !!input.value.trim() || pending.length > 0;
  $('#send').hidden = !hasContent;
  $('#plus').hidden = hasContent;
}
input.addEventListener('input', () => { autosize(); syncComposer(); });
input.addEventListener('focus', () => togglePanel(false));
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); }
});
const INPUT_PLACEHOLDER = input.placeholder; // 提问选项卡点「其他」时会临时换掉，发出去就换回来
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  const images = pending.slice();
  input.value = ''; pending = []; renderAttachments(); autosize(); syncComposer();
  input.placeholder = INPUT_PLACEHOLDER;
  send(text, images);
});

function togglePanel(open = $('#toolPanel').hidden) {
  $('#toolPanel').hidden = !open;
  $('#plus').classList.toggle('open', open);
  $('#plus').setAttribute('aria-expanded', String(open));
  if (open) {
    input.blur();
    requestAnimationFrame(() => { $('#messages').scrollTop = $('#messages').scrollHeight; });
  }
}
$('#plus').addEventListener('click', () => togglePanel());
$('#messages').addEventListener('click', () => togglePanel(false));

$('#toolPanel').addEventListener('click', (e) => {
  const tool = e.target.closest('[data-tool]')?.dataset.tool;
  if (tool === 'album') return $('#fileInput').click();
  if (tool === 'camera') return $('#cameraInput').click();
});

function downscale(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1280 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}
for (const id of ['#fileInput', '#cameraInput']) {
  $(id).addEventListener('change', async (e) => {
    let bad = 0; // 浏览器解不开的图（比如 iPhone 的 HEIC、坏文件）跳过，别让后面的图也丢了
    for (const f of [...e.target.files].slice(0, 3 - pending.length)) {
      try { pending.push(await downscale(f)); } catch { bad++; }
    }
    e.target.value = '';
    togglePanel(false);
    renderAttachments();
    if (bad) alert(`有 ${bad} 张图打不开（可能是 HEIC 这类浏览器不认的格式），换成 JPG 或 PNG 再试试`);
  });
}
function renderAttachments() {
  $('#attachments').innerHTML = pending.map((u, i) => `<div class="att"><img src="${u}" alt=""><button type="button" data-i="${i}" aria-label="移除">×</button></div>`).join('');
  syncComposer();
}
$('#attachments').addEventListener('click', (e) => {
  if (e.target.dataset.i == null) return;
  pending.splice(Number(e.target.dataset.i), 1);
  renderAttachments();
});

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

// 新建目标：一句话说想盯什么；从哪一类点进来就给那一类的例子，从「+」进来每类给一个
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

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-logout]')) fetch('/api/auth/logout', { method: 'POST' }).finally(() => location.replace('/login'));
});

// ---------- 侧边栏（仿豆包 / 微信）：搜索聊天记录、新建对话、目标、后台任务、按日期分组的聊天记录 ----------
// 聊天之间共用后台任务和目标；删聊天只删聊天内容。
const NEW_CHAT_TITLE = '新聊天';
const currentChat = () => (S.chats || []).find((c) => c.id === S.currentChat);
const VIEW_TITLE = { goals: '目标', tasks: '后台任务' };

function renderChatBar() {
  if (!$('#chatView').hidden) $('#topTitle').textContent = currentChat()?.title || NEW_CHAT_TITLE;
}

function chatGroup(iso) {
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(new Date(iso))) / 86_400_000);
  return diff <= 0 ? '今天' : diff === 1 ? '昨天' : diff < 7 ? '7 天内' : '更早';
}

// list 不传就用 S.chats 按日期分组；搜索时传搜索结果，不分组
function renderChatsList(list, searching = false) {
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
const closeDrawer = () => { $('#drawer').hidden = true; };

async function chatAction(url, method) {
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

// ---------- 喵团档案：身份证（按二代证正反面的版式比例重画，可翻面）和简历（Deedy 双栏版式） ----------
// 身份证全部用矢量重画：不用真证件图片、国徽和官方标题，号码是带字母的虚构格式，卡上注明仅供娱乐。
// 底纹：左青右粉两组交叉的细波浪线，像真证的网纹观感，但图案是自己生成的。
let idMeshUrl = '';
function idMesh() {
  if (idMeshUrl) return idMeshUrl;
  const W = 856, H = 540;
  const wave = (i, k, a, slope) => {
    let d = '';
    for (let x = -20; x <= W + 20; x += 20) d += `${d ? 'L' : 'M'}${x} ${(i * 15 + a * Math.sin(x / k + i * 0.55) + x * slope).toFixed(1)}`;
    return `<path d="${d}"/>`;
  };
  const family = (from, to, k, a, slope) => Array.from({ length: to - from }, (_, j) => wave(from + j, k, a, slope)).join('');
  const mesh = family(-6, 44, 62, 11, 0.1) + family(-4, 60, 48, 9, -0.32) + family(-8, 52, 90, 16, 0.22);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <defs>
      <linearGradient id="l" x1="0" x2="1"><stop offset="0" stop-color="#fff"/><stop offset=".62" stop-color="#fff" stop-opacity="0"/></linearGradient>
      <linearGradient id="r" x1="0" x2="1"><stop offset=".38" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff"/></linearGradient>
      <mask id="ml"><rect width="${W}" height="${H}" fill="url(#l)"/></mask><mask id="mr"><rect width="${W}" height="${H}" fill="url(#r)"/></mask>
      <radialGradient id="g" cx=".55" cy=".45" r=".7"><stop offset="0" stop-color="#fdfcff"/><stop offset="1" stop-color="#eeecf6"/></radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#g)"/>
    <g mask="url(#ml)" fill="none" stroke="#38a3bb" stroke-opacity=".62" stroke-width="1">${mesh}</g>
    <g mask="url(#mr)" fill="none" stroke="#d97cae" stroke-opacity=".55" stroke-width="1">${mesh}</g>
  </svg>`;
  return (idMeshUrl = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
}

// 背面中间的线稿：一排猫耳朵形状的山（照 LongCat 的 M 形耳朵），代替真证背面的长城图案
function earRidgeSvg() {
  let d = 'M0 60';
  for (let x = 0; x < 400; x += 50) d += ` L${x + 12} 18 L${x + 25} 34 L${x + 38} 18 L${x + 50} 60`;
  return `<svg viewBox="0 0 400 64" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="${d.replace(/ (\d+)$/, ' $1')}" transform="translate(25 8)" fill="none" stroke="currentColor" stroke-width=".7" opacity=".6"/></svg>`;
}

function openIdCard() {
  const bg = `style='background-image:${idMesh()}'`;
  $('#idCard').classList.remove('flipped');
  $('#idCard').innerHTML = `
    <span class="idface idfront" ${bg}>
      <i class="ic-k ic-k2" style="left:8.1%;top:20.6%">姓名</i><b class="ic-v ic-name" style="left:18.4%;top:20.6%">喵团</b>
      <i class="ic-k ic-k2" style="left:8.1%;top:32.3%">性别</i><b class="ic-v" style="left:18.4%;top:32.3%">猫</b>
      <i class="ic-k ic-k2" style="left:30.2%;top:32.3%">民族</i><b class="ic-v" style="left:39.4%;top:32.3%">数码猫</b>
      <i class="ic-k ic-k2" style="left:8.1%;top:43.7%">出生</i><b class="ic-v" style="left:19.5%;top:43.7%">2026</b>
      <i class="ic-k" style="left:30.2%;top:43.7%">年</i><b class="ic-v" style="left:34.9%;top:43.7%">10</b>
      <i class="ic-k" style="left:42.2%;top:43.7%">月</i><b class="ic-v" style="left:45.2%;top:43.7%">15</b><i class="ic-k" style="left:53.9%;top:43.7%">日</i>
      <i class="ic-k ic-k2" style="left:8.1%;top:55.1%">住址</i><b class="ic-v ic-addr" style="left:18.4%;top:55.1%">数字宇宙 LongCat 星<br>喵团路 3210 号</b>
      <span class="ic-photo">${catPortraitSvg()}</span>
      <i class="ic-k" style="left:8.1%;top:85.9%">喵民身份号码</i><b class="ic-no" style="left:35.6%;top:85.9%">MEOW202610153210</b>
      <em class="ic-note">仅供娱乐 · 非真实证件</em>
    </span>
    <span class="idface idback" ${bg}>
      <img class="ic-logo" src="longcat-icon.svg" alt="">
      <span class="ic-title"><small>喵 团 星 球</small><b>居民身份卡</b></span>
      <span class="ic-ridge">${earRidgeSvg()}</span>
      <i class="ic-k ic-bk" style="left:21%;top:73.5%">签发机关</i><b class="ic-v ic-bv" style="left:36.5%;top:73.5%">LongCat 团队</b>
      <i class="ic-k ic-bk" style="left:21%;top:85.5%">有效期限</i><b class="ic-v ic-bv" style="left:36.5%;top:85.5%">2026.10.15-长期</b>
    </span>`;
  $('#idViewer').hidden = false;
}
$('#idCard').addEventListener('click', () => $('#idCard').classList.toggle('flipped'));

// 简历：Deedy 双栏版式（宋体大标题、细线、左栏教育/链接/技能、右栏经历/项目/开源/里程碑）。
// 写的能力都是喵团真会的，数字来自 App 的真实数据（/api/profile）。
async function openResume() {
  let p = {};
  try { p = await (await fetch('/api/profile')).json(); } catch {}
  const n = (x) => (Number.isFinite(x) ? x.toLocaleString('zh-CN') : '—');
  const since = p.since ? `${p.since.slice(0, 4)}.${p.since.slice(5, 7)}` : '2026.10';
  const today = new Date();
  const job = (name, role, time, items) => `<div class="dd-job"><div><b>${name}</b><span>${role}</span></div><time>${time}</time><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul></div>`;
  $('#resumeBody').innerHTML = `<div class="dd-page">
    <div class="dd-updated">最后更新于 ${today.getFullYear()} 年 ${today.getMonth() + 1} 月 ${today.getDate()} 日</div>
    <h1 class="dd-name">喵　团</h1>
    <div class="dd-contact">${esc(location.host)} ｜ 7×24 小时在线 ｜ ${esc(p.model || 'LongCat')}</div>
    <hr>
    <div class="dd-cols">
      <aside>
        <section><h2>教育经历</h2>
          <div class="dd-ent"><b>LongCat 大模型</b><span>${esc(p.model || 'LongCat')}<br>主修中文对话与工具调用</span><time>2026</time></div>
        </section>
        <section><h2>链接</h2>
          <p>App:// <b>${esc(location.host)}</b><br>技能:// <b>agent-home/skills</b></p>
        </section>
        <section><h2>技能</h2>
          <h3>调研</h3><small>精通</small><p>深度搜索 · 研究报告 · 交叉核对</p>
          <h3>生活</h3><small>熟练</small><p>找图 · 打电话 · 目标追踪</p>
        </section>
        <section><h2>数据</h2>
          <p><b>${n(p.tasksDone)}</b> 个后台任务<br><b>${n(p.reports)}</b> 份研究报告<br><b>${n(p.goals)}</b> 个长期目标<br><b>${n(p.chats)}</b> 个话题</p>
        </section>
      </aside>
      <main>
        <section><h2>工作经历</h2>
          ${job('喵团', '私人助理', `${since} - 至今 ｜ 你的手机和电脑`, [
            `累计完成 <b>${n(p.tasksDone)} 个后台任务</b>，写了 <b>${n(p.reports)} 份研究报告</b>`,
            '查资料、找图、替你打电话问问，结果像聊天一样一两句说清',
            `同时盯着 <b>${n(p.goals)} 个长期目标</b>，有新进展才说，不打扰`,
          ])}
        </section>
        <section><h2>项目经历</h2>
          ${job('深度搜索', 'Owner', since, ['多角度搜索、读原文、<b>交叉核对</b>，输出带编号引用的研究报告', '聊天里只说结论，报告单独一份，表格和引用都排好版'])}
          ${job('中途改任务', 'Maintainer', since, ['任务跑到一半改要求就<b>直接插话</b>，做完不满意在原任务上再改一轮，也能随时停'])}
        </section>
        <section><h2>开源依赖</h2>
          <table class="dd-tab">
            <tr><td><b>Pi SDK</b></td><td>后台执行 agent，调工具干活</td></tr>
            <tr><td><b>microsoft/playwright</b></td><td>沙箱浏览器：搜网页、读网页</td></tr>
          </table>
        </section>
        <section><h2>里程碑</h2>
          <table class="dd-tab dd-awards">
            <tr><td>${since}</td><td>上岗</td><td>找图、盯目标</td></tr>
            <tr><td>${since}</td><td>升级</td><td>学会深度搜索，报告带引用</td></tr>
            <tr><td>${since}</td><td>升级</td><td>学会中途改任务和停止任务</td></tr>
          </table>
        </section>
      </main>
    </div>
  </div>`;
  $('#resumeViewer').hidden = false;
  resumePZ.fit(); // 每次打开都从「铺满宽度、看最上面」开始
}

// ---------- 拖动 / 缩放查看器：内容按固定尺寸排好，不随窗口重排；像看 PDF 一样拖动、缩放 ----------
// 单指 / 鼠标拖动平移；双指捏合、⌘/Ctrl + 滚轮（触控板捏合也是这个）缩放；普通滚轮上下移；双击放大 / 回到铺满宽度。
function makePanZoom(view, stage, onScale) {
  let s = 1, x = 0, y = 0, fitted = true;
  const pts = new Map();
  let pinch = null;
  const MIN = 0.2, MAX = 4, EDGE = 40;
  function apply() {
    const vw = view.clientWidth, vh = view.clientHeight, w = stage.offsetWidth * s, h = stage.offsetHeight * s;
    x = w <= vw ? (vw - w) / 2 : Math.min(EDGE, Math.max(vw - w - EDGE, x)); // 比窗口窄就居中，宽就不让拖出太远
    y = h <= vh ? (vh - h) / 2 : Math.min(EDGE, Math.max(vh - h - EDGE, y));
    stage.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    onScale?.(s);
  }
  function zoomAt(ns, cx, cy) {
    ns = Math.min(MAX, Math.max(MIN, ns));
    const r = view.getBoundingClientRect();
    const px = cx - r.left, py = cy - r.top;
    x = px - ((px - x) * ns) / s; // 以手指 / 鼠标所在的点为中心缩放
    y = py - ((py - y) * ns) / s;
    s = ns;
    fitted = false;
    apply();
  }
  // 铺满宽度；keep：窗口变了时保持看的位置，不跳回顶部
  function fit(keep = false) {
    if (!stage.offsetWidth || !view.clientWidth) return;
    const ns = Math.min(1.5, (view.clientWidth - 24) / stage.offsetWidth);
    y = keep ? (y * ns) / s : 16;
    s = ns;
    fitted = true;
    apply();
  }
  view.addEventListener('pointerdown', (e) => {
    view.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s }; }
    view.classList.add('grabbing');
  });
  view.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pts.size === 1) { x += dx; y += dy; apply(); return; }
    if (pinch) {
      const [a, b] = [...pts.values()];
      x += dx / 2; y += dy / 2; // 两指一起挪也能平移
      zoomAt((pinch.s * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
  });
  const lift = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (!pts.size) view.classList.remove('grabbing');
  };
  view.addEventListener('pointerup', lift);
  view.addEventListener('pointercancel', lift);
  view.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomAt(s * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    else { x -= e.deltaX; y -= e.deltaY; apply(); }
  }, { passive: false });
  view.addEventListener('dblclick', (e) => (fitted ? zoomAt(Math.max(1, s * 2), e.clientX, e.clientY) : fit()));
  new ResizeObserver(() => (fitted ? fit(true) : apply())).observe(view);
  const zoomBy = (f) => { const r = view.getBoundingClientRect(); zoomAt(s * f, r.left + r.width / 2, r.top + r.height / 2); };
  return { fit, zoomBy };
}

const resumePZ = makePanZoom($('#resumeView'), $('#resumeBody'), (s) => { $('#zoomLabel').textContent = `${Math.round(s * 100)}%`; });
$('#resumeViewer').addEventListener('click', (e) => {
  const z = e.target.closest('[data-zoom]')?.dataset.zoom;
  if (z === 'in') resumePZ.zoomBy(1.25);
  else if (z === 'out') resumePZ.zoomBy(0.8);
  else if (z === 'fit') resumePZ.fit();
});
document.addEventListener('keydown', (e) => {
  if ($('#resumeViewer').hidden || e.target.closest?.('input, textarea')) return;
  if (e.key === '+' || e.key === '=') resumePZ.zoomBy(1.25);
  else if (e.key === '-') resumePZ.zoomBy(0.8);
  else if (e.key === '0') resumePZ.fit();
});

for (const id of ['#idViewer', '#resumeViewer']) {
  $(id).addEventListener('click', (e) => {
    if (e.target === $(id) || e.target.closest('[data-close-viewer]')) $(id).hidden = true;
  });
}

document.addEventListener('keydown', (e) => {
  // 任务详情上面又开了报告、大图时，Esc 先关上面那层；目标详情上面可能还叠着任务详情
  const nothingAbove = $('#reportReader').hidden && $('#lightbox').hidden;
  if (e.key === 'Escape' && openGoalId && !openTaskId && nothingAbove) { if ($('#goalMenu').hidden) closeGoalSheet(); else toggleGoalMenu(false); }
  if (e.key === 'Escape' && openTaskId && nothingAbove) closeTask();
  if (e.key === 'Escape' && !$('#goalNewSheet').hidden) $('#goalNewSheet').hidden = true;
  if (e.key === 'Escape' && !$('#reportReader').hidden) $('#reportReader').hidden = true;
  if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer();
  if (e.key === 'Escape') { $('#idViewer').hidden = true; $('#resumeViewer').hidden = true; }
  const rc = (e.key === 'Enter' || e.key === ' ') && e.target.closest?.('[data-open-report]');
  if (rc) { e.preventDefault(); openReport(rc.dataset.openReport); }
});

// ---------- 切换 / 大图 ----------
// 聊天是首页；目标、后台任务是从侧边栏进去的二级页面，顶栏左边变成 ‹ 返回
function showView(view) {
  if (!['chat', 'goals', 'tasks'].includes(view)) view = 'chat';
  for (const v of ['chat', 'goals', 'tasks']) $(`#${v}View`).hidden = v !== view;
  $('.top').classList.toggle('sub', view !== 'chat');
  $('#topLeft').setAttribute('aria-label', view === 'chat' ? '打开侧边栏' : '返回聊天');
  $('#topTitle').textContent = VIEW_TITLE[view] || currentChat()?.title || NEW_CHAT_TITLE;
  closeDrawer();
  if (!MOCK) store.set('cattuan.view', view);
}

// ---------- 打电话：提问选项卡、通话组件、侧边栏「喵团档案 → 电话」（演示里由演示脚本接管） ----------
let callLog = []; // 「电话」里的通话记录（/api/calls），新的在后
async function loadCalls() {
  try { callLog = (await (await fetch('/api/calls')).json()).calls || []; } catch {}
  return callLog;
}
const findCall = (id) => [...callLog, ...S.messages.flatMap((m) => (m.booking?.type === 'calls' ? m.booking.calls : []))].find((c) => c.id === id);

// 提问选项卡：点选项记下答案、跳到下一题；都答完了替用户把答案拼成一句话发出去（带上是哪张卡、选了什么），服务端把卡片收起来。
// 「其他」：不在选项里的，直接在输入框里说（服务端收到下一句话时也会把卡片收起来）。
function bookingClick(e) {
  const opt = e.target.closest('[data-ask-opt]');
  const tab = e.target.closest('[data-ask-tab]');
  const other = e.target.closest('[data-ask-other]');
  const m = (opt || tab || other) && S.messages.find((x) => x.id === e.target.closest('[data-mid]')?.dataset.mid);
  const b = m?.booking;
  if (b?.type === 'ask' && !b.answered) {
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
    if (other) { $('#input').placeholder = '不在选项里的，直接说就行'; $('#input').focus(); }
    renderChat();
    return true;
  }
  const call = e.target.closest('[data-call]');
  if (call) { const c = findCall(call.dataset.call); if (c) openCallDetail(c); return true; }
  if (e.target.closest('[data-open-calls]')) { closeDrawer(); loadCalls().then(openCallLog); return true; }
  return false;
}

document.addEventListener('click', (e) => {
  if (!MOCK && bookingClick(e)) return;
  const quick = e.target.closest('[data-quick]'); // 搜不到时给的一键选项：替用户把这句话发出去
  if (quick) { send(quick.dataset.quick, []); return; }
  const report = e.target.closest('[data-open-report]');
  if (report) { openReport(report.dataset.openReport); return; }
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

// ---------- 像素小猫的配色和头像（爬行小猫、身份证照片、简历头像共用） ----------
const CAT_COLORS = { D: '#17633d', G: '#29e154', L: '#8ff5ab', K: '#0b0f0d' };
const CAT_HEAD = [ // 14×12，LongCat 的 M 形耳朵 + 两条竖眼睛
  '.D..........D.',
  '.DD........DD.',
  '.DGD......DGD.',
  '.DGGD....DGGD.',
  '.DGGGDDDDGGGD.',
  'DGLGKKGGKKGGGD',
  'DGGGKKGGKKGGGD',
  'DGGGKKGGKKGGGD',
  'DGGGKKGGKKGGGD',
  'DGGGGGGGGGGGGD',
  '.DGGGGGGGGGGD.',
  '..DDDDDDDDDD..',
];

// 像素头像画成 SVG：每格一个方块，放大也是清晰的像素
function catPortraitSvg() {
  const rects = CAT_HEAD.flatMap((row, y) => [...row].map((c, x) => (c === '.' ? '' : `<rect x="${x}" y="${y}" width="1" height="1" fill="${CAT_COLORS[c]}"/>`))).join('');
  return `<svg viewBox="-1 -1 16 14" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
}

// ---------- 像素小猫：照 LongCat 标志画的数码小猫（绿色、M 形尖耳朵、竖条黑眼睛），
// 在聊天输入框和顶部聊天标题栏之间来回爬：输入框上坐一会儿 → 往右走 → 爬上右边的墙 → 倒挂着沿标题栏往左爬 →
// 停下眨眨眼 → 原路爬回来，一直循环。点进输入框打字时淡出让开；它不接收点击，不会挡住按钮。
(function pixelCat() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return; // 系统设置了「减少动态效果」就不放
  const W = 26, H = 17, PX = 2; // 26×17 的像素格，每格画成 2px
  const COLORS = CAT_COLORS, HEAD = CAT_HEAD;
  const BLINK = { 5: 'DGLGGGGGGGGGGD', 6: 'DGGGGGGGGGGGGD', 7: 'DGGGGGGGGGGGGD' }; // 闭眼：竖条只剩最下面一行

  // 画一帧：legs 是四条腿的脚往前(+1)/往后(-1)迈，bob 是头上下颠一下，tail 是尾巴尖左右摆
  function drawFrame(ctx, ox, { legs = [0, 0, 0, 0], bob = 0, tail = 0, blink = false }) {
    const put = (x, y, c) => { if (c !== '.' && x >= 0 && x < W && y >= 0 && y < H) { ctx.fillStyle = COLORS[c]; ctx.fillRect(ox + x, y, 1, 1); } };
    for (let x = 5; x <= 14; x++) { put(x, 7, 'D'); put(x, 13, 'D'); } // 身体
    for (let y = 8; y <= 12; y++) { put(4, y, 'D'); put(15, y, 'D'); for (let x = 5; x <= 14; x++) put(x, y, y === 8 && x < 11 ? 'L' : 'G'); }
    [[3, 9], [2, 8], [2, 7], [1 + tail, 6], [1 + tail, 5], [2 + tail, 4]].forEach(([x, y]) => put(x, y, 'D')); // 尾巴
    [5, 7, 11, 13].forEach((x, i) => { // 腿：两格宽，脚掌按步子前后挪
      for (let y = 14; y <= 15; y++) { put(x, y, 'D'); put(x + 1, y, 'D'); }
      put(x + legs[i], 16, 'D'); put(x + 1 + legs[i], 16, 'D');
    });
    HEAD.forEach((row, y) => [...((blink && BLINK[y]) || row)].forEach((c, x) => put(12 + x, y + bob, c))); // 头盖在身体前面
  }

  const FRAMES = [ // 0–3 走路，4 坐着，5 眨眼
    { legs: [0, 0, 0, 0] }, { legs: [1, -1, -1, 1], bob: 1, tail: 1 },
    { legs: [0, 0, 0, 0] }, { legs: [-1, 1, 1, -1], bob: 1, tail: -1 },
    {}, { blink: true },
  ];
  const sheet = document.createElement('canvas');
  sheet.width = W * FRAMES.length; sheet.height = H;
  FRAMES.forEach((f, i) => drawFrame(sheet.getContext('2d'), i * W, f));

  const cat = document.createElement('div');
  cat.className = 'pixelcat';
  cat.setAttribute('aria-hidden', 'true');
  Object.assign(cat.style, {
    width: `${W * PX}px`, height: `${H * PX}px`,
    backgroundImage: `url(${sheet.toDataURL()})`, backgroundSize: `${W * FRAMES.length * PX}px ${H * PX}px`,
  });
  $('#chatView').append(cat);

  // 路线：每一段是走 / 转弯 / 歇着。坐标是小猫脚底中点（相对聊天页），a 是转角，f=1 脸朝右、-1 脸朝左（先翻再转）。
  // 转弯时脚底沿对角线挪半个身长，像真的从地面拐上墙，不会穿墙。
  const SPEED = 48; // 像素 / 秒
  const HALF = (W * PX) / 2 - 4;
  let segs = [];
  let si = 0, st = 0, fi = 0, frameT = 0, last = performance.now();
  function buildPath() {
    const v = $('#chatView').getBoundingClientRect();
    const inp = $('#input').getBoundingClientRect();
    const bar = document.querySelector('.top')?.getBoundingClientRect();
    if (!v.width || !inp.width || !bar?.width) return false;
    const banner = $('#demoBanner');
    const ground = banner?.offsetParent ? banner.getBoundingClientRect().top : inp.top;
    const floor = ground - v.top + 1;         // 输入区上沿（有演示入口就站在入口上面，不挡字）
    const ceil = bar.bottom - v.top - 1;      // 顶栏下沿（倒挂着爬）
    const wall = v.width - 1;                 // 右边的墙
    const start = inp.left - v.left + HALF + 6;
    const hang = Math.min(wall - HALF - 60, Math.max(v.width * 0.42, wall - 190));
    const walk = (x0, y0, x1, y1, a, f) => ({ kind: 'walk', x0, y0, x1, y1, a0: a, a1: a, f, ms: (Math.hypot(x1 - x0, y1 - y0) / SPEED) * 1000 });
    const turn = (x0, y0, x1, y1, a0, a1, f) => ({ kind: 'turn', x0, y0, x1, y1, a0, a1, f, ms: 420 });
    const rest = (x, y, a, f, ms) => ({ kind: 'rest', x0: x, y0: y, x1: x, y1: y, a0: a, a1: a, f, ms });
    segs = [
      rest(start, floor, 0, 1, 1600),
      walk(start, floor, wall - HALF, floor, 0, 1),
      turn(wall - HALF, floor, wall, floor - HALF, 0, -90, 1),        // 地面 → 墙（往上）
      walk(wall, floor - HALF, wall, ceil + HALF, -90, 1),
      turn(wall, ceil + HALF, wall - HALF, ceil, -90, -180, 1),       // 墙 → 天花板（倒挂往左）
      walk(wall - HALF, ceil, hang, ceil, -180, 1),
      rest(hang, ceil, -180, 1, 2000),
      walk(hang, ceil, wall - HALF, ceil, 180, -1),                   // 掉头往右
      turn(wall - HALF, ceil, wall, ceil + HALF, 180, 270, -1),       // 天花板 → 墙（往下）
      walk(wall, ceil + HALF, wall, floor - HALF, 270, -1),
      turn(wall, floor - HALF, wall - HALF, floor, 270, 360, -1),     // 墙 → 地面（往左）
      walk(wall - HALF, floor, start, floor, 360, -1),
    ].filter((s) => s.ms > 0);
    return true;
  }

  // 你在输入框里（聚焦或有字）、聊天页没显示时：淡出，原地等着
  const away = () => document.activeElement === $('#input') || !!$('#input').value.trim() || $('#chatView').hidden;

  function tick(now) {
    requestAnimationFrame(tick);
    const dt = Math.min(100, now - last);
    last = now;
    const hide = away();
    cat.classList.toggle('away', hide);
    if (hide || (!segs.length && !buildPath())) return;
    st += dt;
    while (st >= segs[si].ms) {
      st -= segs[si].ms;
      si = (si + 1) % segs.length;
      if (si === 0) buildPath(); // 每圈按当前布局重算一次
    }
    const s = segs[si];
    const k = st / s.ms;
    const x = s.x0 + (s.x1 - s.x0) * k, y = s.y0 + (s.y1 - s.y0) * k, a = s.a0 + (s.a1 - s.a0) * k;
    let f;
    if (s.kind === 'rest') f = st % 1600 > 1000 && st % 1600 < 1160 ? 5 : 4; // 歇着时偶尔眨眼
    else {
      frameT += dt;
      if (frameT > 110) { frameT = 0; fi = (fi + 1) % 4; }
      f = fi;
    }
    cat.style.backgroundPosition = `-${f * W * PX}px 0`;
    cat.style.transform = `translate(${x - (W * PX) / 2}px, ${y - H * PX}px) rotate(${a}deg) scaleX(${s.f})`;
  }
  new ResizeObserver(() => buildPath()).observe($('#chatView'));
  requestAnimationFrame(tick);
})();

// ---------- 演示模式：mock/<名字>.js 接管聊天里的数据和发送，给它画界面需要的几个函数 ----------
async function startMock() {
  setOnline(true);
  S = { messages: [], tasks: [], goals: [], chats: [{ id: 'mock', title: '演示', updatedAt: new Date().toISOString() }], currentChat: 'mock' };
  const script = await import(`./mock/${encodeURIComponent(MOCK)}.js`).catch(() => null);
  if (!script) {
    S.messages.push({ id: 'mock_missing', role: 'bot', text: `没有找到演示脚本 mock/${MOCK}.js`, at: new Date().toISOString() });
    return renderChat();
  }
  mock = script.start({
    S,
    showView,
    render: () => { renderChat(); renderTasks(); renderTV(); renderChatBar(); },
    typing: (on) => { waitingReply = on; renderChat(); },
  });
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
