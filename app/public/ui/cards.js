// 挂在消息（和任务结果）下面的附件：服务端给的是 attachments: [{ type, ... }]，这里按 type 画——
//   images 图墙 · document 文档卡片（点开是全屏阅读页，[n] 链到来源） · ask 提问选项卡 · calls 通话组件（点开看详情和转写）
// 还有任务轨迹里实时的通话状态（phone_call 这一步的 progress：{ type: 'call', call }）、侧边栏「喵团档案 → 电话」的通话记录。
// 按钮只带 data-*，点击由 App（或演示脚本）接管。
import { $, esc, clock, fmtSecs, hostOf, imgProxy, thumbSrc, mdHtml } from './util.js';
import { S, taskById } from './state.js';

// ---------- 图墙 ----------
function imagesHtml(a) {
  if (!a.items?.length) return '';
  return `<div class="gallery n${Math.min(a.items.length, 3)}">${a.items.map((p) => `
    <figure>
      <img src="${esc(thumbSrc(p.thumb))}" data-full="${esc(imgProxy(p.image))}" data-page="${esc(p.page || '')}" data-site="${esc(p.site)}"
           alt="${esc(p.title)}" loading="lazy" referrerpolicy="no-referrer">
      <figcaption>${esc(String(p.site || '').replace(/^www\./, ''))}</figcaption>
    </figure>`).join('')}</div>`;
}

// ---------- 文档卡片和阅读页 ----------
// 卡片上的一句话摘要：第一段（结论），去掉 Markdown 符号和引用编号
function docSummary(d) {
  const first = String(d.body || '').split('\n').map((l) => l.trim()).find((l) => l && !/^[#|]/.test(l)) || '';
  return first.replace(/^[-*•]\s+/, '').replace(/\*\*/g, '').replace(/\s*\[\d+\]/g, '').slice(0, 70);
}
const docKind = (d) => (d.sources?.length ? `研究报告 · ${d.sources.length} 个来源` : '文档');

function documentHtml(d, key) {
  return `<div class="reportcard" role="button" tabindex="0" data-open-doc="${esc(key)}">
    <span class="ricon">📑</span>
    <span class="rinfo"><b>${esc(d.title || '文档')}</b><small>${esc(docSummary(d))}</small>
      <em>${docKind(d)} · 约 ${String(d.body || '').length} 字</em></span>
  </div>`;
}

// key：m:<消息 id>:<第几个附件> 或 t:<任务 id>:<第几个附件>
function findDoc(key) {
  const [kind, id, i] = String(key).split(':');
  const owner = kind === 'm' ? S.messages.find((m) => m.id === id) : taskById(id)?.result;
  const at = kind === 'm' ? owner?.at : taskById(id)?.endedAt;
  const d = owner?.attachments?.[Number(i)];
  return d?.type === 'document' ? { d, at } : null;
}

export function openDoc(key) {
  const found = findDoc(key);
  if (!found) return;
  const { d, at } = found;
  $('#rrTitle').textContent = d.title || '文档';
  $('#rrMeta').textContent = `${docKind(d)}${at ? ` · ${clock(at)}` : ''}`;
  const sources = (d.sources || []).map((x) => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title || x.url)}</a><small>${esc(hostOf(x.url))}</small></li>`).join('');
  $('#rrBody').innerHTML = mdHtml(d.body, d.sources) + (sources ? `<section class="rrsrc"><h4>来源</h4><ol>${sources}</ol></section>` : '');
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

// ---------- 提问选项卡（仿 Claude Code）：一次一个问题，点选项或按数字键；最后一个选完就替你发出去 ----------
// 不是表单：也可以不点，直接在输入框里说（「纯色，下午三点，有空就约」）。
function askHtml(b) {
  const done = !!b.answered;
  const label = (q) => q.options.find((o) => o.value === b.answers?.[q.key])?.label || b.answers?.[q.key] || '';
  const tabs = b.questions.map((q, i) => `<button type="button" class="bk-asktab${!done && i === b.cur ? ' on' : ''}${b.answers?.[q.key] ? ' ok' : ''}"`
    + ` data-ask-tab="${i}"${done ? ' disabled' : ''}><i>${b.answers?.[q.key] ? '✓' : ''}</i>${esc(q.tab)}</button>`).join('');
  const q = b.questions[b.cur] || b.questions[0];
  const body = done
    ? `<div class="bk-asksum">${b.typed ? `你直接回了：<b>${esc(b.typed)}</b>` : b.questions.map((x) => `${esc(x.tab)}：<b>${esc(label(x))}</b>`).join(' · ')}</div>`
    : `<div class="bk-askq">${esc(q.label)}</div>
      <ol class="bk-askopts">${q.options.map((o, i) => `<li><button type="button" class="${b.answers?.[q.key] === o.value ? 'on' : ''}" data-ask-opt="${esc(o.value)}">`
        + `<kbd>${i + 1}</kbd><span><b>${esc(o.label)}</b>${o.hint ? `<small>${esc(o.hint)}</small>` : ''}</span></button></li>`).join('')}
        <li class="other"><button type="button" data-ask-other><kbd>${q.options.length + 1}</kbd><span>其他：直接在输入框里说</span></button></li></ol>`;
  return `<div class="bk-card bk-ask${done ? ' done' : ''}"><div class="bk-asktabs">${tabs}</div>${body}</div>`;
}

// ---------- 通话组件（仿 Cue：喵团有自己的电话，每通电话一条记录） ----------
// 记录：{ id, who, short, phone, agent, at, seconds, status, summary, lines }。status：done 接通了 / missed 打出去没接通 / blocked 平台拦下没打出去 / dialing、pending 打出去了还没等到结果
const CALL_LINE = '美团专线'; // 拨出线路：外显号码不固定，界面上不显示号码
const PHONE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 3.5h2.6l1.4 4.1-1.9 1.3a11.5 11.5 0 0 0 6.4 6.4l1.3-1.9 4.1 1.4v2.6a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
const CALL_CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const outcome = (c) => (c.status === 'done' ? `通话 ${Math.floor(c.seconds / 60)}:${String(c.seconds % 60).padStart(2, '0')}`
  : c.status === 'noanswer' ? `响了 ${c.seconds} 秒没人接` : c.summary || c.label || '没打通');

function callsHtml(a) {
  return (a.calls || []).map((c) => `<button type="button" class="bk-callcard" data-call="${esc(c.id)}">
    <span class="bk-callicon">${PHONE_ICON}</span><span class="bk-callmain"><b>通话</b><small>${esc(c.short)} · ${clock(c.at)}</small></span>${CALL_CHEVRON}
    <em>查看详情</em>
  </button>`).join('');
}

const linesHtml = (lines, agent) => `<div class="bk-lines">${lines.map((l) => `<p class="${l.who}"><i>${l.who === 'ai' ? esc(agent) : '店员'}</i><span>${esc(l.text)}</span></p>`).join('')}</div>`;

// 「电话」页：喵团用的线路（不显示号码），下面是通话记录（新的在上）
function callLogHtml(calls) {
  const rows = [...calls].reverse().map((c) => `<li><button type="button" data-call="${esc(c.id)}">
      <span class="bk-callicon${c.status !== 'done' ? ' miss' : ''}">${PHONE_ICON}</span>
      <span class="bk-callmain"><b>${esc(c.short)}</b><small>${clock(c.at)} · ${outcome(c)}</small></span>${CALL_CHEVRON}</button></li>`).join('');
  return `<div class="bk-phone"><span class="bk-callicon">${PHONE_ICON}</span><span class="bk-callmain"><b>${CALL_LINE}</b><small>喵团的电话 · 替你打给商家</small></span></div>
    <div class="bk-calllisthead">通话记录${calls.length ? ` · ${calls.length}` : ''}</div>
    ${rows ? `<ul class="bk-calllist">${rows}</ul>` : '<div class="bk-callempty">还没打过电话</div>'}`;
}

// 一通电话的详情：打给谁、什么时候、结果，喵团的小结，挂断后给的转写
function callDetailHtml(c) {
  const fact = (k, v) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`;
  return `<div class="bk-calldetail">
    <div class="bk-calltop"><b>${esc(c.who)}</b><small>${esc(c.phone)}</small></div>
    <dl class="bk-callfacts">${fact('时间', clock(c.at))}${fact('结果', outcome(c))}${fact('拨出号码', CALL_LINE)}</dl>
    ${c.summary && c.summary !== outcome(c) ? `<p class="bk-callsum">${esc(c.summary)}</p>` : ''}
    ${c.lines?.length ? `<div class="bk-calltitle">通话转写（${c.lines.length} 句）</div>${linesHtml(c.lines, c.agent)}` : ''}
  </div>`;
}

// 「电话」底部弹窗：通话记录列表，或者一通电话的详情（左上角 ‹ 回到列表）
function callSheet(label, head, body) {
  let el = document.getElementById('callsSheet');
  if (!el) {
    el = document.createElement('div');
    el.id = 'callsSheet';
    el.className = 'sheet';
    el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('[data-close-sheet]')) closeCallSheet(); });
    document.body.append(el);
  }
  el.innerHTML = `<div class="sheetbody" role="dialog" aria-label="${label}"><header class="sheethead">${head}`
    + `<button type="button" class="sheetclose" data-close-sheet aria-label="关闭">×</button></header>${body}</div>`;
  el.hidden = false;
}
export const openCallLog = (calls) => callSheet('电话', '<strong>电话</strong>', callLogHtml(calls));
export const openCallDetail = (c) => callSheet('通话详情',
  '<button type="button" class="sheetclose" data-open-calls aria-label="返回通话记录">‹</button><strong>通话详情</strong>', callDetailHtml(c));
export function closeCallSheet() { const el = document.getElementById('callsSheet'); if (el) el.hidden = true; }

// ---------- 任务轨迹里的通话：排队 → 拨号 → 通话 → 核对。外呼平台挂断后才给转写，通话中只显示阶段和计时 ----------
// call：{ shop, phone, agent, stage, lines }；演示脚本还会给 attempt（第几次拨）、retryIn / retryAt（多久后重拨）、eta
const STAGES = [['queued', '排队'], ['dialing', '拨号'], ['talking', '通话'], ['verifying', '核对']];
const STAGE_TEXT = { queued: '排队中', dialing: '正在拨号…', talking: '通话中', verifying: '核对结果…', retry: '等待重拨', missed: '没打通', blocked: '没打出去', pending: '等结果', waiting: '等你决定', done: '通话结束' };

export function callLiveHtml(c, t) {
  if (!c) return '';
  const order = STAGES.map(([k]) => k);
  const miss = ['retry', 'missed', 'blocked'].includes(c.stage);
  const pending = c.stage === 'pending'; // 打出去了，没等到平台的结果：不知道接没接通
  const at = miss ? 1 : pending ? 2 : order.includes(c.stage) ? order.indexOf(c.stage) : order.length;
  const stages = STAGES.map(([k, label], i) => {
    if (miss && k === 'dialing') return `<li class="fail">${c.stage === 'blocked' ? '没打出去' : '没打通'}</li>`;
    return `<li class="${i < at ? 'done' : i === at && !pending ? 'now' : ''}">${label}</li>`;
  }).join('');
  const live = ['dialing', 'talking', 'verifying'].includes(c.stage);
  const took = t?.startedAt ? Math.max(0, Math.round(((t.endedAt ? Date.parse(t.endedAt) : Date.now()) - Date.parse(t.startedAt)) / 1000)) : 0;
  const note = c.stage === 'retry'
    ? `<div class="bk-callnote warn">第 ${c.attempt || 1} 次没打通，${c.retryAt ? `${esc(c.retryAt)} ` : `${esc(c.retryIn || '过一会儿')}后`}再打 1 次。你可以先去忙，有结果会通知你。</div>`
    : c.stage === 'waiting' ? '<div class="bk-callnote warn">店里给的条件跟你确认的不一样，我没答应，等你决定后回电。</div>'
      : live ? `<div class="bk-callnote">预计 ${esc(c.eta || '1–5 分钟内')}出结果 · 你可以先去忙，结果会通知你</div>` : '';
  const transcript = live || !c.lines?.length ? ''
    : `<details class="bk-script"><summary>通话转写（${c.lines.length} 句）</summary>${linesHtml(c.lines, c.agent)}</details>`;
  return `<div class="bk-call">
    <div class="bk-callhead">
      <span class="bk-ring${live ? ' live' : ''}">📞</span>
      <span class="bk-callwho"><b>${esc(c.shop)}</b><small>${esc(c.phone)}${c.attempt > 1 ? ` · 第 ${c.attempt} 次拨打` : ''}</small></span>
      <span class="bk-callstate${miss || pending || c.stage === 'waiting' ? ' warn' : ''}">${STAGE_TEXT[c.stage] || ''}${live && t ? ` <span data-elapsed="${esc(t.id)}">${fmtSecs(took)}</span>` : ''}</span>
    </div>
    <ol class="bk-stages">${stages}</ol>
    ${transcript}${note}
  </div>`;
}

// ---------- 附件 ----------
const RENDER = { images: imagesHtml, document: documentHtml, ask: askHtml, calls: callsHtml };
// owner：附件挂在哪（m:<消息 id> / t:<任务 id>），文档卡片点开时按它找回全文；skip：这里不画的类型
export function attachmentsHtml(list, owner, { skip = [] } = {}) {
  return (list || []).map((a, i) => (skip.includes(a.type) ? '' : RENDER[a.type]?.(a, `${owner}:${i}`) || '')).join('');
}
export const hasAttachment = (x, type) => !!x?.attachments?.some((a) => a.type === type);
export const askOf = (m) => m?.attachments?.find((a) => a.type === 'ask');

// 这一步打电话时的实时状态（工具的 progress：{ type: 'call', call }）
export const callOfStep = (s) => (s?.progress?.type === 'call' ? s.progress.call : null);

// 演示用：仿手机系统通知横幅
export function noticeHtml(n) {
  return `<img src="longcat-icon.svg" alt=""><span class="bk-ntext"><span class="bk-nmeta"><em>喵团</em><time>现在</time></span><b>${esc(n.title)}</b><span>${esc(n.body)}</span></span>`;
}

