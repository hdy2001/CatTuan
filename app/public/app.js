// 喵团前端：聊天（调度者短回复 + 任务/目标结果）、目标（持续目标 + 最新状态）、任务（后台执行 agent 状态）。
// 所有数据在服务端，/api/state 拉全量，/api/events（SSE）推增量。
const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const LEDGER_CATS = {
  expense: ['餐饮', '交通', '购物', '娱乐', '旅行', '居住', '医疗', '学习', '人情', '其他'],
  income: ['工资', '副业', '红包', '其他'],
};
const STATUS = { queued: '排队中', running: '进行中', done: '已完成', failed: '失败', stopped: '已停止' };

let S = { messages: [], tasks: [], goals: [] };
let pending = [];
let waitingReply = false;

// ---------- 工具 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const imgProxy = (u) => `/api/img?u=${encodeURIComponent(u)}`;
const thumbSrc = (u) => (/\.bing\.net\//.test(u) ? u : imgProxy(u)); // 必应缩略图可直连，其余走代理（补 Referer / 翻墙）
const renderText = (t) => esc(t).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[\s(（])(https?:\/\/[^\s<>"）)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
  .replace(/\n{3,}/g, '\n\n').trim();

// ---------- 研究报告：聊天里是一张卡片，点开是全屏阅读页 ----------
const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; } };

// 简易 Markdown：标题、列表、表格、加粗、链接；正文里的 [n] 链到来源
function mdInline(text, byN) {
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(（])(https?:\/\/[^\s<>"）)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
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
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`);
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
      list ||= { tag, items: [] };
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

function reportCard(m) {
  const r = m.report;
  return `<div class="reportcard" role="button" tabindex="0" data-open-report="${esc(m.id)}">
    <span class="ricon">📑</span>
    <span class="rinfo"><b>${esc(r.title || '研究报告')}</b><small>${esc(reportSummary(r))}</small>
      <em>研究报告 · ${(r.sources || []).length} 个来源 · 约 ${String(r.body || '').length} 字</em></span>
  </div>`;
}

function openReport(id) {
  const m = S.messages.find((x) => x.id === id);
  if (!m?.report) return;
  const r = m.report;
  const byN = new Map((r.sources || []).map((x) => [x.n, x]));
  $('#rrTitle').textContent = r.title || '研究报告';
  $('#rrMeta').textContent = `研究报告 · ${(r.sources || []).length} 个来源 · ${clock(m.at)}`;
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

// 深度搜索过程：搜了什么、读了哪些网页
function researchHtml(t) {
  const r = t.research;
  if (!r || (!r.searches?.length && !r.reads?.length)) return '';
  const host = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return u; } };
  const items = [
    ...(r.searches || []).map((x) => ({ at: x.at, html: `🔎 搜「${esc(x.q)}」${x.n != null ? `<small>${x.n} 条结果</small>` : '<i class="spin"></i>'}` })),
    ...(r.reads || []).map((x) => ({ at: x.at, html: `📄 <a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title || host(x.url))}</a>${x.ok === undefined ? '<i class="spin"></i>' : x.ok ? '<small class="ok">读到了</small>' : `<small class="bad">${esc(x.note || '没读到')}</small>`}` })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return `<details class="research"${t.status === 'running' ? ' open' : ''}><summary>深度搜索过程 · 搜了 ${r.searches?.length || 0} 次，读了 ${r.reads?.length || 0} 个网页</summary><ol>${items.map((x) => `<li>${x.html}</li>`).join('')}</ol></details>`;
}
const taskById = (id) => S.tasks.find((t) => t.id === id);

// ---------- 网站（agent 用 publish_site 发布的网页） ----------
// 网页在单独的端口上（和 App 不同源），App 用 iframe 嵌进来看。
const siteById = (id) => (S.sites || []).find((s) => s.id === id);
const siteUrl = (s) => `${location.protocol}//${location.hostname}:${S.sitesPort || 3211}/${s.id}/?v=${s.version || 1}`;

function siteCards(sites, { thumb = true } = {}) {
  return (sites || []).map((x) => {
    const s = siteById(x.id) || x; // 网站改过版本时用最新的
    return `<div class="sitecard${thumb ? '' : ' slim'}" role="button" tabindex="0" data-open-site="${esc(s.id)}">
      ${thumb ? `<span class="sitethumb"><iframe src="${esc(siteUrl(s))}" loading="lazy" tabindex="-1" aria-hidden="true" sandbox="allow-scripts allow-same-origin"></iframe></span>` : ''}
      <span class="siteinfo"><b>🌐 ${esc(s.title)}</b><small>网页${s.version > 1 ? ` · 第 ${s.version} 版` : ''} · 点开看</small></span>
    </div>`;
  }).join('');
}

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

function browserView(t) {
  const b = t.browser;
  if (!b || (!b.actions?.length && !b.frames?.length)) return '';
  const active = b.active && t.status === 'running';
  const last = b.actions?.at(-1)?.text || '';
  const url = liveFrames.get(t.id)?.url || b.frames?.at(-1)?.url || '';
  const src = frameSrc(t);
  const replay = !active && b.frames?.length
    ? `<div class="breplay">${b.frames.map((f, i) => `<img src="${esc(f.src)}" data-frame="${esc(f.src)}" data-frame-text="${esc(f.text || '')}" title="${esc(f.text || '')}" alt="第 ${i + 1} 步" loading="lazy">`).join('')}</div>` : '';
  const log = `<details class="blog"${active ? ' open' : ''}><summary>浏览过程（${b.actions?.length || 0} 步）</summary><ol>${(b.actions || []).slice(-20).map((a) => `<li><time>${clock(a.at)}</time>${esc(a.text)}</li>`).join('')}</ol></details>`;
  return `<div class="bview${active ? ' live' : ''}">
    <div class="bchrome"><span class="bdots"><i></i><i></i><i></i></span><span class="burl" data-burl="${t.id}">${esc(url.replace(/^https?:\/\//, ''))}</span>${active ? '<span class="blive">● 实时</span>' : '<span class="bdone">回放</span>'}</div>
    ${src ? `<div class="bscreen"><img data-bimg="${t.id}" src="${src}" alt=""></div>` : '<div class="bscreen empty">等待画面…</div>'}
    ${active ? `<div class="bcaption"><i class="spin"></i><span data-bcap="${t.id}">${esc(last)}</span></div>` : ''}
    ${replay}${log}
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
  // 任务结果消息（同一 taskId 的后一条）标来源；目标带来的新进展标目标名。进行中的任务不在聊天里挂状态条，看右下角的小电视。
  const goal = m.goalId && S.goals.find((g) => g.id === m.goalId);
  const fromGoal = m.role === 'bot' && m.goalId && m.taskId;
  const isResult = isResultMsg(m);
  const resultOf = isResult && !fromGoal ? taskById(m.taskId) : null;
  let html = '';
  if (fromGoal) html += `<button type="button" class="pushtag" data-goto-goal="${m.goalId}">🎯 来自目标：${esc(goal?.title || '已删除的目标')}</button>`;
  if (m.images?.length) html += `<div class="thumbs">${m.images.map((u) => `<img src="${esc(u)}" alt="">`).join('')}</div>`;
  if (m.text || m.photos?.length) html += `<div class="bubble">${renderText(m.text)}${galleryHtml(m.photos)}</div>`;
  if (m.report?.body) html += reportCard(m);
  if (m.sites?.length) html += siteCards(m.sites);
  html += loginButtons(m);
  if (m.goalId && !m.taskId && goal) html += `<button type="button" class="taskchip done" data-goto-goal="${goal.id}"><b>🎯</b>新目标：${esc(goal.title)} · ${esc(scheduleLabel(goal.schedule))}</button>`;
  if (resultOf) {
    // 用这条消息自己记下的那一轮用时；老消息没记、任务又改过几轮，就不显示（任务现在的计时不是那一轮的）
    const took = m.took != null ? fmtSecs(m.took) : m.round == null && (resultOf.round || 1) === 1 ? elapsed(resultOf) : '';
    html += `<button type="button" class="fromtask" data-goto-task="${resultOf.id}">来自后台任务：${esc(resultOf.title)}${m.round > 1 ? ` · 第 ${m.round} 轮` : ''}${took ? ` · 用时 ${took}` : ''}</button>`;
  }
  const part = m.partOf && !m.taskId; // 拆开发的前几条
  return `<div class="msg ${m.role}${fromGoal ? ' push' : ''}${part ? ' part' : ''}" data-mid="${m.id}">${html}${part ? '' : `<time>${clock(m.at)}</time>`}</div>`;
}

// 按消息 id 增量更新，只重画内容变了的消息：整块重画会让网站缩略图（iframe）每来一条消息就重新加载一遍。
function renderChat() {
  const box = $('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const old = new Map([...box.children].map((el) => [el.dataset.mid, el]));
  let prev = null;
  for (const m of S.messages) {
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
  if (waitingReply) box.insertAdjacentHTML('beforeend', '<div class="msg bot" data-mid="_typing"><div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div></div>');
  if (nearBottom || waitingReply) box.scrollTop = box.scrollHeight;
}

// ---------- 小电视悬浮窗：后台任务在跑时，聊天页右下角直播它在干什么（浏览器画面 / 当前步骤），可以收起 ----------
const TV_HIDDEN_KEY = 'cattuan.tvHidden';
let tvHtml = null;

function renderTV() {
  const list = S.tasks.filter((t) => (t.status === 'running' || t.status === 'queued') && t.kind !== 'goal');
  // 有实时浏览器画面的优先，其次最近开始的
  const t = list.find((x) => x.browser?.active && x.status === 'running' && frameSrc(x))
    || list.filter((x) => x.status === 'running').sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0] || list[0];
  const hidden = store.get(TV_HIDDEN_KEY, false);
  let html = '';
  if (t) {
    const live = t.browser?.active && t.status === 'running' && frameSrc(t);
    const step = t.status === 'queued' ? '排队中' : t.steps?.at(-1)?.label || '思考中';
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
// 小电视放在输入框上方：输入框（和加号面板）高度变了就跟着挪
new ResizeObserver(() => $('#chatView').style.setProperty('--composer-h', `${$('#composer').offsetHeight}px`)).observe($('#composer'));

async function send(text, images) {
  if (!text.trim() && !images.length) return;
  waitingReply = true;
  $('#send').disabled = true;
  // 先本地显示，服务端广播回来时按内容去重。
  S.messages.push({ id: `local_${Date.now()}`, role: 'me', text, images, at: new Date().toISOString(), local: true });
  renderChat();
  try {
    const r = await fetch('/api/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, images }) });
    if (!r.ok) throw new Error((await r.json()).error || r.status);
  } catch (e) {
    S.messages.push({ id: `local_err_${Date.now()}`, role: 'bot', text: `发送失败：${e.message}`, at: new Date().toISOString(), local: true });
  } finally {
    waitingReply = false;
    $('#send').disabled = false;
    renderChat();
  }
}

// ---------- 任务 ----------
function taskCard(t) {
  const steps = t.steps?.length
    ? `<div class="steps">${t.steps.map((s) => `<span class="step ${s.status === 'done' ? 'done' : 'running'}">${esc(s.label)}</span>`).join('')}</div>` : '';
  let result = '';
  if (t.status === 'done') {
    const photos = t.result?.photos || [];
    result = `<details><summary>执行结果</summary><div class="brief">${renderText(t.result?.text || '（无文字）')}</div></details>`
      + siteCards(t.result?.sites, { thumb: false })
      + (photos.length ? `<div class="tthumbs">${photos.slice(0, 6).map((p) => `<img src="${esc(thumbSrc(p.thumb))}" alt="" loading="lazy" referrerpolicy="no-referrer">`).join('')}${photos.length > 6 ? `<span>+${photos.length - 6}</span>` : ''}</div>` : '');
  } else if (t.status === 'failed') {
    result = `<div class="terror">${esc(t.error || '失败')}</div><button type="button" class="tretry" data-task-retry="${t.id}">重试</button>`;
  } else if (t.status === 'stopped') {
    result = `<div class="tstopped">已停止${t.endedAt ? ` · ${clock(t.endedAt)}` : ''}</div><button type="button" class="tretry" data-task-retry="${t.id}">重新开始</button>`;
  } else if (t.kind !== 'goal' || t.status === 'running') {
    result = `<button type="button" class="tstop" data-task-stop="${t.id}" ${t.stopRequested ? 'disabled' : ''}>${t.stopRequested ? '正在停止…' : '■ 停止'}</button>`;
  }
  return `<article class="card task ${t.status}" id="task-${t.id}">
    <header>
      <span class="pill ${t.status}">${t.status === 'running' || t.status === 'queued' ? '<i class="spin"></i>' : ''}${STATUS[t.status]}</span>
      <strong>${esc(t.title)}</strong>
      ${t.round > 1 ? `<span class="roundtag">第 ${t.round} 轮</span>` : ''}
      <span class="kind">${t.kind === 'goal' ? '目标检查' : t.kind === 'research' ? '深度搜索' : '对话'}</span>
    </header>
    <div class="tmeta">${clock(t.createdAt)} 派出 · ${t.status === 'queued' ? '等待中' : `用时 <span data-elapsed="${t.status === 'running' ? t.id : ''}">${elapsed(t)}</span>`}</div>
    ${steps}
    ${browserView(t)}
    ${researchHtml(t)}
    ${revisionsHtml(t)}
    <details><summary>任务说明</summary><div class="brief">${renderText(t.brief)}</div></details>
    ${result}
  </article>`;
}

// 用户中途 / 做完后提的修改，以及每条的去向
const REV_STATE = {
  merged: '已并进任务说明', sent: '已发给正在跑的任务', delivered: '已按这条调整', pending: '这一轮跑完接着改',
  round: '第 {n} 轮按这条改', dropped: '任务停了，没用上',
};
function revisionsHtml(t) {
  if (!t.revisions?.length) return '';
  return `<div class="revs"><b>修改记录</b><ol>${t.revisions.map((v) => `<li><time>${clock(v.at)}</time><span>${esc(v.text)}</span>`
    + `<small class="${esc(v.state)}">${esc((REV_STATE[v.state] || v.state).replace('{n}', v.round))}</small></li>`).join('')}</ol></div>`;
}

$('#tasks').addEventListener('click', async (e) => {
  const frame = e.target.closest('[data-frame]');
  if (frame) {
    $('#lightboxImg').src = frame.dataset.frame;
    $('#lightboxSave').href = frame.dataset.frame;
    $('#lightboxSource').href = frame.dataset.frame;
    $('#lightboxSource').textContent = frame.dataset.frameText || '浏览回放';
    $('#lightbox').hidden = false;
    return;
  }
  const stop = e.target.closest('[data-task-stop]');
  if (stop) {
    stop.disabled = true;
    const r = await fetch(`/api/tasks/${stop.dataset.taskStop}/stop`, { method: 'POST' });
    if (!r.ok) { alert((await r.json()).error || '没停下来'); stop.disabled = false; }
    return;
  }
  const id = e.target.closest('[data-task-retry]')?.dataset.taskRetry;
  if (!id) return;
  e.target.disabled = true;
  const r = await fetch(`/api/tasks/${id}/retry`, { method: 'POST' });
  if (!r.ok) { alert((await r.json()).error || '重试失败'); e.target.disabled = false; }
});

function renderTasks() {
  const list = [...S.tasks].reverse();
  $('#tasks').innerHTML = list.map(taskCard).join('') || '<div class="empty">还没有后台任务。让喵团查资料、做网页、看社媒账号、找附近好去处时，它会派执行 agent 去干活。</div>';
  const active = S.tasks.filter((t) => t.status === 'running' || t.status === 'queued').length;
  $('#taskBadge').hidden = !active;
  $('#taskBadge').textContent = `${active} 进行中`;
  setStatusText();
}

// ---------- 目标 ----------
const scheduleLabel = (s) => (s?.at ? `每天 ${s.at}` : s?.every >= 60 ? `每 ${+(s.every / 60).toFixed(1)} 小时` : `每 ${s?.every} 分钟`);

function ago(iso) {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

function goalCard(g) {
  const checking = S.tasks.find((t) => t.goalId === g.id && (t.status === 'running' || t.status === 'queued'));
  const status = checking
    ? `<i class="spin"></i>正在检查${checking.steps?.length ? ` · ${esc(checking.steps.at(-1).label)}` : ''}`
    : `${esc(g.status?.text || '等待第一次检查')}${g.status?.at ? ` · ${ago(g.status.at)}` : ''}`;
  return `<article class="card goal${g.enabled ? '' : ' off'}" id="goal-${g.id}">
    <div class="gmain">
      <div class="gtitle">${esc(g.title)}${g.createdBy === 'ai' ? '<span class="aibadge">AI 维护</span>' : ''}</div>
      <div class="gstatus${g.status?.error ? ' err' : ''}">${status}</div>
      <div class="gmeta">${scheduleLabel(g.schedule)}${g.enabled ? '' : ' · 已暂停'}</div>
    </div>
    <div class="gactions">
      <button type="button" data-goal-run="${g.id}" title="现在检查" ${checking || !g.enabled ? 'disabled' : ''}>↻</button>
      <label class="switch" title="${g.enabled ? '暂停' : '启用'}"><input type="checkbox" data-goal-toggle="${g.id}" ${g.enabled ? 'checked' : ''}><span></span></label>
      <button type="button" data-goal-del="${g.id}" title="删除">×</button>
    </div>
  </article>`;
}

function renderGoals() {
  $('#goalCount').textContent = S.goals.length || '';
  $('#goals').innerHTML = S.goals.map(goalCard).join('') || '<div class="empty">还没有目标。告诉喵团想让它一直盯着什么，比如「每天早上告诉我天气」「机票降到 800 以下提醒我」。</div>';
}

// ---------- 同步 ----------
async function loadState() {
  try { S = await (await fetch('/api/state')).json(); } catch { return; }
  renderChat(); renderTasks(); renderGoals(); renderChatBar(); renderTV();
  if (!$('#drawer').hidden && !$('#chatSearch').value.trim()) renderChatsList();
  if (!loadState.autoLocated) { loadState.autoLocated = true; autoUpdateLocation(); }
}

function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => setOnline(true);
  es.onerror = () => setOnline(false);
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
      if (!S.messages.some((x) => x.id === m.id)) S.messages.push(m);
      if (m.role === 'bot') waitingReply = false;
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
    } else if (ev.type === 'goal') {
      const i = S.goals.findIndex((g) => g.id === ev.goal.id);
      if (i >= 0) S.goals[i] = ev.goal; else S.goals.push(ev.goal);
      renderGoals();
    } else if (ev.type === 'goal-removed') {
      S.goals = S.goals.filter((g) => g.id !== ev.id);
      renderGoals();
    } else if (ev.type === 'ledger' && !$('#ledgerSheet').hidden) {
      loadLedger();
    } else if (ev.type === 'location') {
      S.location = ev.location;
      if (!$('#locationSheet').hidden) renderLocation();
    } else if (ev.type === 'chats') {
      loadState(); // 开了新聊天 / 切换 / 删除（可能是在别的设备上）
    } else if (ev.type === 'site') {
      S.sites = [ev.site, ...(S.sites || []).filter((s) => s.id !== ev.site.id)];
      if (!$('#sitesSheet').hidden) renderSitesList();
      renderChat();
    }
  };
}

let online = false;
function setOnline(v) { online = v; setStatusText(); }
function setStatusText() {
  const active = S.tasks.filter((t) => t.status === 'running').length;
  $('#dot').classList.toggle('on', online);
  $('#statusText').textContent = !online ? '连接中…' : active ? `后台 ${active} 个任务进行中` : '在线';
}

// 进行中的任务每秒刷新计时。
setInterval(() => {
  document.querySelectorAll('[data-elapsed]').forEach((el) => {
    const t = el.dataset.elapsed && taskById(el.dataset.elapsed);
    if (t && t.status === 'running') el.textContent = elapsed(t);
  });
}, 1000);

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
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  const images = pending.slice();
  input.value = ''; pending = []; renderAttachments(); autosize(); syncComposer();
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
  if (tool === 'ledger') { togglePanel(false); return openLedger(); }
  if (tool === 'goal') { togglePanel(false); showView('goals'); $('#goalInput').focus(); }
  if (tool === 'accounts') { togglePanel(false); openAccounts(); }
  if (tool === 'skills') { togglePanel(false); openSkills(); }
  if (tool === 'location') { togglePanel(false); openLocation(); }
  if (tool === 'sites') { togglePanel(false); openSites(); }
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
    for (const f of [...e.target.files].slice(0, 3 - pending.length)) pending.push(await downscale(f));
    e.target.value = '';
    togglePanel(false);
    renderAttachments();
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

// ---------- 目标操作 ----------
$('#goalForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#goalInput').value.trim();
  if (!text) return;
  const btn = $('#goalForm button');
  btn.disabled = true; btn.textContent = '理解中…';
  try {
    const r = await fetch('/api/goals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!r.ok) throw new Error((await r.json()).error || r.status);
    $('#goalInput').value = '';
  } catch (err) {
    alert(`没建成：${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = '添加';
  }
});
$('#goals').addEventListener('click', async (e) => {
  const run = e.target.closest('[data-goal-run]')?.dataset.goalRun;
  const del = e.target.closest('[data-goal-del]')?.dataset.goalDel;
  if (run) await fetch(`/api/goals/${run}/run`, { method: 'POST' });
  if (del && confirm('删掉这个目标？')) await fetch(`/api/goals/${del}`, { method: 'DELETE' });
});
$('#goals').addEventListener('change', (e) => {
  const id = e.target.dataset.goalToggle;
  if (id) fetch(`/api/goals/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: e.target.checked }) });
});
// 状态小字里的「x 分钟前」每分钟刷新一次。
setInterval(() => { if (!$('#goalsView').hidden) renderGoals(); }, 60_000);

// ---------- 记账面板 ----------
let ledgerType = 'expense';
let ledgerCat = '餐饮';

function renderCats() {
  if (!LEDGER_CATS[ledgerType].includes(ledgerCat)) ledgerCat = LEDGER_CATS[ledgerType][0];
  $('#lCategories').innerHTML = LEDGER_CATS[ledgerType].map((c) => `<button type="button" data-cat="${c}" class="${c === ledgerCat ? 'on' : ''}">${c}</button>`).join('');
  document.querySelectorAll('.ltype button').forEach((b) => b.classList.toggle('on', b.dataset.type === ledgerType));
}

const yuan = (n) => `¥${(Math.round(n * 100) / 100).toLocaleString('zh-CN')}`;

async function loadLedger() {
  let d;
  try { d = await (await fetch('/api/ledger')).json(); } catch { return; }
  const s = d.summary;
  const top = s.byCategory.slice(0, 4).map((c) => `<span>${esc(c.category)} ${yuan(c.amount)}</span>`).join('');
  $('#ledgerSummary').innerHTML = `
    <div class="lnums">
      <div><small>${s.month.replace('-', ' 年 ')} 月支出</small><b>${yuan(s.expense)}</b></div>
      <div><small>收入</small><b>${yuan(s.income)}</b></div>
      <div><small>今天</small><b>${yuan(s.todayExpense)}</b></div>
    </div>${top ? `<div class="ltop">${top}</div>` : ''}`;
  $('#ledgerEntries').innerHTML = d.entries.map((e) => `
    <div class="lentry">
      <span class="lcat">${esc(e.category)}</span>
      <span class="lnote">${esc(e.note || '')}<small>${e.date.slice(5)}${e.source === 'chat' ? ' · 聊天' : e.source === 'agent' ? ' · AI' : ''}</small></span>
      <b class="${e.type}">${e.type === 'income' ? '+' : '-'}${yuan(e.amount)}</b>
      <button type="button" data-ledger-del="${e.id}" aria-label="删除">×</button>
    </div>`).join('') || '<div class="empty">这个月还没记账。也可以直接在聊天里说「午饭 35」。</div>';
  $('#ledgerMemory').innerHTML = d.memory ? renderText(d.memory) : '还没有记账记忆。多记几笔，喵团会慢慢摸清你的预算和消费习惯。';
}

function openLedger() {
  renderCats();
  loadLedger();
  $('#ledgerSheet').hidden = false;
  setTimeout(() => $('#lAmount').focus(), 50);
}

$('#ledgerSheet').addEventListener('click', async (e) => {
  if (e.target === $('#ledgerSheet') || e.target.closest('[data-close-sheet]')) { $('#ledgerSheet').hidden = true; return; }
  const type = e.target.closest('.ltype button')?.dataset.type;
  if (type) { ledgerType = type; renderCats(); return; }
  const cat = e.target.closest('[data-cat]')?.dataset.cat;
  if (cat) { ledgerCat = cat; renderCats(); return; }
  const del = e.target.closest('[data-ledger-del]')?.dataset.ledgerDel;
  if (del) { await fetch(`/api/ledger/${del}`, { method: 'DELETE' }); loadLedger(); }
});

$('#ledgerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const amount = Number($('#lAmount').value);
  if (!(amount > 0)) { $('#lAmount').focus(); return; }
  const r = await fetch('/api/ledger', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: ledgerType, amount, category: ledgerCat, note: $('#lNote').value.trim() }),
  });
  if (!r.ok) return alert((await r.json()).error || '没记上');
  $('#lAmount').value = ''; $('#lNote').value = '';
  loadLedger();
});

// ---------- 平台登录（沙箱浏览器） ----------
// X / Instagram / Weverse 要在沙箱里登录：点「登录」会在电脑上弹出一个独立的浏览器窗口，用户自己在里面登录，App 不经手密码。
let SESS = null; // /api/sessions：{ mode, login, platforms: [{ id, label, canLogin, needsLogin, loggedIn, expired, note }] }
let sessTimer = null;

async function refreshSessions() {
  try { SESS = await (await fetch('/api/sessions')).json(); sessCheckedAt = new Date().toISOString(); } catch { SESS = { message: '沙箱没连上' }; }
  renderSessions();
  // 登录窗口开着时每 3 秒刷新，看什么时候登好、窗口什么时候关。
  clearTimeout(sessTimer);
  if (SESS?.mode === 'login') sessTimer = setTimeout(refreshSessions, 3000);
}

// 社媒账号备忘录：每个平台的登录态 + 在这个平台上已关注的账号。
let FOLLOWS = [];
let sessCheckedAt = null;

function renderSessions() {
  const box = $('#accounts');
  if (!SESS?.platforms) {
    box.innerHTML = `<div class="empty">${esc(SESS?.message || '读取中…')}</div>`;
    return;
  }
  const loginOn = SESS.mode === 'login' && SESS.platforms.find((p) => p.id === SESS.login);
  box.innerHTML = `${loginOn ? `<div class="logintip"><span>登录窗口已打开：在电脑上弹出的窗口里自己登录 <b>${esc(loginOn.label)}</b>（扫码或输入账号密码，喵团看不到你的密码）。${loginOn.loggedIn ? '已检测到登录 ✓ ' : ''}登好后关掉窗口，或点「完成」。</span><button type="button" data-login-done>完成</button></div>` : ''}
    <div class="plats memo">${SESS.platforms.map((p) => {
      const label = !p.canLogin ? '免登录' : p.loggedIn ? '已登录' : p.expired ? '登录已过期' : p.needsLogin ? '未登录' : '免登录可读';
      const cls = !p.canLogin || p.loggedIn ? 'ok' : p.needsLogin || p.expired ? 'need' : 'opt';
      const btn = p.canLogin ? `<button type="button" class="${p.loggedIn ? 'ghost' : ''}" data-login="${p.id}">${p.loggedIn ? '重新登录' : '登录'}</button>` : '';
      const follows = FOLLOWS.filter((a) => (a.platform || 'weibo') === p.id);
      const followText = follows.length ? `已关注：${follows.map((a) => `${esc(a.name)}${a.idol ? `（${esc(a.idol)}）` : ''}`).join('、')}` : '还没关注这个平台的账号';
      return `<div class="plat ${cls}" title="${esc(p.note)}"><i></i><span><b>${esc(p.label)}<em>${label}</em></b><small>${followText}</small></span>${btn}</div>`;
    }).join('')}</div>
    <div class="acccheck">登录态检查于 ${sessCheckedAt ? clock(sessCheckedAt) : '—'} · 关注列表由喵团在聊天里帮你维护</div>`;
}

async function openAccounts() {
  $('#accountsSheet').hidden = false;
  try { FOLLOWS = await (await fetch('/api/follows')).json(); } catch { FOLLOWS = []; }
  refreshSessions();
}

$('#accountsSheet').addEventListener('click', (e) => {
  if (e.target === $('#accountsSheet') || e.target.closest('[data-close-sheet]')) $('#accountsSheet').hidden = true;
});

// ---------- 位置（浏览器定位；服务端反查城市/区，只把大致位置给 AI） ----------
const LOC_AUTO_KEY = 'cattuan.locAuto';
const LOC_STALE = 30 * 60_000; // 自动更新：超过 30 分钟才重新定位

function renderLocation() {
  const loc = S.location;
  $('#locationCard').innerHTML = loc
    ? `<div class="locplace">📍 ${esc(loc.label || '已获取坐标（地名没查到）')}</div>
       <div class="locmeta">误差约 ${loc.accuracy >= 1000 ? `${(loc.accuracy / 1000).toFixed(1)} 公里` : `${loc.accuracy} 米`} · ${ago(loc.at)}更新</div>`
    : '<div class="locplace muted">还没共享位置</div><div class="locmeta">共享后，喵团能回答「附近」「这边」相关的问题</div>';
  $('#locClear').hidden = !loc;
  $('#locAuto').checked = store.get(LOC_AUTO_KEY, false);
}

function locationErrorText(err) {
  if (!window.isSecureContext) return '浏览器只允许在 https 或 localhost 页面上定位。请用 http://localhost:3210 打开喵团。';
  if (!navigator.geolocation) return '这个浏览器不支持定位。';
  if (err?.code === 1) return '浏览器没有给喵团位置权限：点地址栏左边的站点设置，把「位置」改成允许，然后再点一次「更新位置」。';
  if (err?.code === 2) return '系统定位不可用：在「系统设置 → 隐私与安全性 → 定位服务」里打开定位，并允许你正在用的浏览器。';
  if (err?.code === 3) return '定位超时了，换个网络或稍后再试。';
  return `定位失败：${err?.message || '未知原因'}`;
}

function showLocationError(text) {
  $('#locationError').hidden = !text;
  $('#locationError').textContent = text || '';
}

async function updateLocation({ silent = false } = {}) {
  const btn = $('#locUpdate');
  btn.disabled = true; btn.textContent = '定位中…';
  try {
    if (!window.isSecureContext || !navigator.geolocation) throw {};
    const pos = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject,
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 60_000 }));
    const r = await fetch('/api/location', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    S.location = d;
    showLocationError('');
    if (!silent && !store.get(LOC_AUTO_KEY, null)) store.set(LOC_AUTO_KEY, true); // 第一次共享后默认开自动更新
    renderLocation();
  } catch (err) {
    if (!silent) showLocationError(locationErrorText(err));
  } finally {
    btn.disabled = false; btn.textContent = '更新位置';
  }
}

function openLocation() {
  showLocationError('');
  renderLocation();
  $('#locationSheet').hidden = false;
}

$('#locationSheet').addEventListener('click', async (e) => {
  if (e.target === $('#locationSheet') || e.target.closest('[data-close-sheet]')) { $('#locationSheet').hidden = true; return; }
  if (e.target.closest('#locUpdate')) updateLocation();
  if (e.target.closest('#locClear')) {
    await fetch('/api/location', { method: 'DELETE' });
    S.location = null;
    store.set(LOC_AUTO_KEY, false);
    renderLocation();
  }
});
$('#locAuto').addEventListener('change', (e) => store.set(LOC_AUTO_KEY, e.target.checked));

// 打开 App 时：开了自动更新、浏览器已授权、上次位置超过 30 分钟，才静默更新（不会弹授权框）。
async function autoUpdateLocation() {
  if (!store.get(LOC_AUTO_KEY, false) || !navigator.permissions) return;
  try {
    if ((await navigator.permissions.query({ name: 'geolocation' })).state !== 'granted') return;
  } catch { return; }
  if (S.location && Date.now() - Date.parse(S.location.at) < LOC_STALE) return;
  updateLocation({ silent: true });
}

// ---------- 技能（只读：执行 agent 需要什么技能就自己装，用户不用设置） ----------
const SKILL_GROUPS = [
  ['store', '按需装的', '做事时发现需要，喵团自己装上的'],
  ['agent', 'AI 自己写的', '做完复杂任务后总结出来的做法'],
  ['cattuan', '喵团自带', '深度搜索、做网页、记账等做事手册'],
  ['user', '其他', ''],
];
let SKILLS = [];

function skillRow(s) {
  const meta = [
    s.origin === 'store' && s.installedAt ? `${ago(s.installedAt)}装的${s.installReason ? `：${s.installReason}` : ''}` : '',
    s.lastUsedAt ? `${ago(s.lastUsedAt)}用过` : '',
  ].filter(Boolean).join(' · ');
  return `<details class="skill" data-skill="${esc(s.name)}">
    <summary><span class="sinfo"><b>${esc(s.name)}</b><small>${esc(s.description)}</small>${meta ? `<em>${esc(meta)}</em>` : ''}</span></summary>
    <div class="sbody"><div class="brief" data-skill-content>展开中…</div></div>
  </details>`;
}

function renderSkills() {
  const box = $('#skillsList');
  if (!SKILLS.length) { box.innerHTML = '<div class="empty">读取中…</div>'; return; }
  const active = SKILLS.filter((s) => s.enabled && !s.essential);
  const groups = SKILL_GROUPS.map(([origin, title, sub]) => {
    const list = active.filter((s) => s.origin === origin);
    if (!list.length) return origin === 'store' ? `<div class="sgroup"><b>${title}</b><small>${sub}</small></div><div class="sempty">还没装过。遇到需要新技能的事，喵团会自己去找、自己装。</div>` : '';
    return `<div class="sgroup"><b>${title}</b><small>${list.length} 个 · ${sub}</small></div>${list.map(skillRow).join('')}`;
  }).join('');
  const spare = SKILLS.filter((s) => !s.enabled && s.origin === 'bundled').length;
  box.innerHTML = groups + `<div class="sstore">🧩 另外还有 ${spare} 个本地技能和在线技能库，需要时喵团会自动装上，不用你操心。</div>`;
}

async function openSkills() {
  $('#skillsSheet').hidden = false;
  try {
    const d = await (await fetch('/api/skills')).json();
    SKILLS = d.skills || [];
    if (d.error) throw new Error(d.error);
  } catch (e) {
    $('#skillsList').innerHTML = `<div class="empty">读不到技能：${esc(e.message)}</div>`;
    return;
  }
  renderSkills();
}

$('#skillsSheet').addEventListener('click', (e) => {
  if (e.target === $('#skillsSheet') || e.target.closest('[data-close-sheet]')) $('#skillsSheet').hidden = true;
});
// 展开时再取全文，省得一次拉几十份 SKILL.md。
$('#skillsSheet').addEventListener('toggle', async (e) => {
  const box = e.target.matches?.('details.skill') && e.target.open && e.target.querySelector('[data-skill-content]');
  if (!box || box.dataset.loaded) return;
  const d = await (await fetch(`/api/skills/${encodeURIComponent(e.target.dataset.skill)}`)).json();
  box.dataset.loaded = '1';
  box.innerHTML = renderText((d.content || d.error || '').replace(/^---[\s\S]*?---\s*/, ''));
}, true);

// 消息里提到「登录 X」时，在消息下面放一个直接打开登录窗口的按钮。
const LOGIN_IDS = { x: 'x', instagram: 'instagram', ig: 'instagram', weverse: 'weverse', b站: 'bilibili', 小红书: 'xiaohongshu' };
function loginButtons(m) {
  if (m.role !== 'bot' || !m.text) return '';
  const ids = [...new Set([...m.text.matchAll(/登录\s*(X|Instagram|IG|Weverse|B\s?站|小红书)/gi)]
    .map((x) => LOGIN_IDS[x[1].toLowerCase().replace(/\s/g, '')]).filter(Boolean))];
  const plat = (id) => SESS?.platforms?.find((p) => p.id === id);
  return ids.filter((id) => !plat(id)?.loggedIn)
    .map((id) => `<button type="button" class="loginchip" data-login="${id}">🔑 登录 ${esc(plat(id)?.label || id)}</button>`).join('');
}

async function openLogin(platform, btn) {
  btn.disabled = true;
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform }) });
    if (!r.ok) alert((await r.json()).message || '打开登录窗口失败');
  } catch (e) { alert(`打开登录窗口失败：${e.message}`); }
  btn.disabled = false;
  openAccounts(); // 登录进度在「社媒账号」面板里看
}

document.addEventListener('click', (e) => {
  const login = e.target.closest('[data-login]');
  if (login) openLogin(login.dataset.login, login);
  else if (e.target.closest('[data-login-done]')) fetch('/api/login/done', { method: 'POST' }).finally(refreshSessions);
});
// 从登录窗口切回来时刷新一下状态。
window.addEventListener('focus', () => { if (!$('#accountsSheet').hidden || SESS?.mode === 'login') refreshSessions(); });

// ---------- 侧边栏（仿豆包 / 微信）：搜索聊天记录、新建对话、目标、后台任务、按日期分组的聊天记录 ----------
// 聊天之间共用后台任务、目标、记账和网站；删聊天只删聊天内容。
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
    if (confirm(`删除聊天「${c?.title || ''}」？聊天内容会删掉，后台任务、目标、记账和网站不受影响。`)) await chatAction(`/api/chats/${del}`, 'DELETE');
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
    <div class="dd-contact">localhost:3210 ｜ 7×24 小时在线 ｜ ${esc(p.model || 'LongCat')}</div>
    <hr>
    <div class="dd-cols">
      <aside>
        <section><h2>教育经历</h2>
          <div class="dd-ent"><b>LongCat 大模型</b><span>${esc(p.model || 'LongCat')}<br>主修中文对话与工具调用</span><time>2026</time></div>
        </section>
        <section><h2>链接</h2>
          <p>App:// <b>localhost:3210</b><br>网站:// <b>localhost:3211</b><br>（已上线 ${n(p.sites)} 个网页）<br>技能:// <b>hermes-home/skills</b></p>
        </section>
        <section><h2>技能</h2>
          <h3>调研</h3><small>精通</small><p>深度搜索 · 研究报告 · 交叉核对</p>
          <h3>制作</h3><small>熟练</small><p>网页 · 地图标注 · 小游戏</p>
          <h3>生活</h3><small>熟练</small><p>记账 · 预算 · 目标追踪 · 附近好去处</p>
          <h3>平台</h3><small>了解</small><p>小红书 · 微博 · X · Instagram · Weverse · B 站</p>
        </section>
        <section><h2>数据</h2>
          <p><b>${n(p.tasksDone)}</b> 个后台任务<br><b>${n(p.reports)}</b> 份研究报告<br><b>${n(p.sites)}</b> 个网页<br><b>${n(p.goals)}</b> 个长期目标<br><b>${n(p.ledger)}</b> 笔账<br><b>${n(p.chats)}</b> 个话题</p>
        </section>
      </aside>
      <main>
        <section><h2>工作经历</h2>
          ${job('喵团', '私人助理', `${since} - 至今 ｜ 你的手机和电脑`, [
            `累计完成 <b>${n(p.tasksDone)} 个后台任务</b>，写了 <b>${n(p.reports)} 份研究报告</b>，做了 <b>${n(p.sites)} 个网页</b>`,
            '查资料、找附近的吃喝玩乐、读小红书和微博等平台的公开账号，结果像聊天一样一两句说清',
            `同时盯着 <b>${n(p.goals)} 个长期目标</b>，有新进展才说，不打扰`,
          ])}
        </section>
        <section><h2>项目经历</h2>
          ${job('深度搜索', 'Owner', since, ['多角度搜索、读原文、<b>交叉核对</b>，输出带编号引用的研究报告', '聊天里只说结论，报告单独一份，表格和引用都排好版'])}
          ${job('网页工坊', 'Owner', since, ['把调研结果做成导游图、攻略页、小游戏，在 App 的内置浏览器里打开', '发布后在沙箱里<b>真的打开网页看报错</b>，有问题自己修'])}
          ${job('中途改任务', 'Maintainer', since, ['任务跑到一半改要求就<b>直接插话</b>，做完不满意在原任务上再改一轮，也能随时停'])}
          ${job('记账管家', 'Maintainer', since, ['一句"午饭 35"就记好，自动维护记账记忆和预算提醒'])}
        </section>
        <section><h2>开源依赖</h2>
          <table class="dd-tab">
            <tr><td><b>NousResearch/hermes-agent</b></td><td>后台执行 agent，调工具干活</td></tr>
            <tr><td><b>microsoft/playwright</b></td><td>沙箱浏览器：读网页、看社媒、检查网页</td></tr>
            <tr><td><b>Leaflet/Leaflet</b></td><td>网页里的交互地图</td></tr>
            <tr><td><b>OpenStreetMap</b></td><td>地图底图、地址查坐标</td></tr>
          </table>
        </section>
        <section><h2>里程碑</h2>
          <table class="dd-tab dd-awards">
            <tr><td>${since}</td><td>上岗</td><td>找图、记账、盯目标</td></tr>
            <tr><td>${since}</td><td>升级</td><td>学会深度搜索，报告带引用</td></tr>
            <tr><td>${since}</td><td>升级</td><td>学会做网页，能在 App 里打开</td></tr>
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

// ---------- 网站列表 + 内置浏览器 ----------
function renderSitesList() {
  const list = S.sites || [];
  $('#sitesList').innerHTML = list.map((s) => `<button type="button" class="siterow" data-open-site="${esc(s.id)}">
      <span class="sicon">🌐</span>
      <span><b>${esc(s.title)}</b><small>${s.version > 1 ? `第 ${s.version} 版 · ` : ''}${ago(s.updatedAt)}更新${s.description ? ` · ${esc(s.description)}` : ''}</small></span>
      <em>打开</em>
    </button>`).join('') || '<div class="empty">还没有网站。在聊天里说「把 xx 做成一个网页」试试，比如「把这周的行程做成一个导游图网页」。</div>';
}

function openSites() {
  renderSitesList();
  $('#sitesSheet').hidden = false;
}

$('#sitesSheet').addEventListener('click', (e) => {
  if (e.target === $('#sitesSheet') || e.target.closest('[data-close-sheet]')) $('#sitesSheet').hidden = true;
});

const SB_DEVICE_KEY = 'cattuan.sbDevice';
function setSbDevice(device) {
  store.set(SB_DEVICE_KEY, device);
  $('#sbStage').classList.toggle('phone', device === 'phone');
  $('#sbDevice').textContent = device === 'phone' ? '🖥' : '📱';
  $('#sbDevice').title = device === 'phone' ? '切到电脑宽度' : '切到手机宽度';
}

function loadInBrowser(url) {
  const bar = $('#sbBar');
  bar.className = 'sbbar';
  void bar.offsetWidth; // 重新开始进度条动画
  bar.className = 'sbbar loading';
  $('#sbFrame').src = url;
}

function openSite(id) {
  const s = siteById(id);
  if (!s) return alert('这个网站找不到了');
  const url = siteUrl(s);
  $('#sbTitle').textContent = s.title;
  $('#sbUrl').textContent = url.replace(/^https?:\/\//, '').replace(/\?.*$/, '');
  $('#sbOpen').href = url;
  setSbDevice(store.get(SB_DEVICE_KEY, 'full'));
  $('#siteBrowser').hidden = false;
  loadInBrowser(url);
}

function closeSite() {
  $('#siteBrowser').hidden = true;
  $('#sbFrame').src = 'about:blank'; // 停掉网页里的脚本、地图
}

$('#sbFrame').addEventListener('load', () => { $('#sbBar').className = 'sbbar done'; });
$('#siteBrowser').addEventListener('click', (e) => {
  const act = e.target.closest('[data-sb]')?.dataset.sb;
  if (e.target === $('#siteBrowser') || act === 'close') closeSite();
  else if (act === 'reload') loadInBrowser($('#sbOpen').href);
  else if (act === 'device') setSbDevice($('#sbStage').classList.contains('phone') ? 'full' : 'phone');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#siteBrowser').hidden) closeSite();
  if (e.key === 'Escape' && !$('#reportReader').hidden) $('#reportReader').hidden = true;
  if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer();
  if (e.key === 'Escape') { $('#idViewer').hidden = true; $('#resumeViewer').hidden = true; }
  const rc = (e.key === 'Enter' || e.key === ' ') && e.target.closest?.('[data-open-report]');
  if (rc) { e.preventDefault(); openReport(rc.dataset.openReport); }
  const card = (e.key === 'Enter' || e.key === ' ') && e.target.closest?.('[data-open-site]');
  if (card) { e.preventDefault(); openSite(card.dataset.openSite); }
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
  store.set('cattuan.view', view);
}

document.addEventListener('click', (e) => {
  const report = e.target.closest('[data-open-report]');
  if (report) { openReport(report.dataset.openReport); return; }
  const site = e.target.closest('[data-open-site]');
  if (site) { $('#sitesSheet').hidden = true; openSite(site.dataset.openSite); return; }
  const goto = e.target.closest('[data-goto-task]');
  if (goto) {
    showView('tasks');
    document.getElementById(`task-${goto.dataset.gotoTask}`)?.scrollIntoView({ block: 'start' });
    return;
  }
  const gotoGoal = e.target.closest('[data-goto-goal]');
  if (gotoGoal) {
    showView('goals');
    document.getElementById(`goal-${gotoGoal.dataset.gotoGoal}`)?.scrollIntoView({ block: 'start' });
    return;
  }
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
    const floor = inp.top - v.top + 1;      // 输入框上沿
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

showView(store.get('cattuan.view', 'chat'));
refreshSessions(); // 聊天里的「登录」按钮也要知道哪些平台已登录
connect();
