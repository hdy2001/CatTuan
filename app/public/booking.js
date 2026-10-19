// 电话预订（Longcat 第一期 PRD）用到的界面。聊天参考 Manus 的 Cue：喵团像真人一样发消息，打之前确认、在打、没接通、要你定、结果都是普通文字消息，
// 聊天里只有补全预约信息的提问选项卡，和每通电话打完挂在消息下面的通话组件（点开看详情和转写）；通话的阶段和计时在任务页里看。
// 这一期没接美团搜索：找店就是普通网页搜索，回答是纯文字，没有店铺卡片；也没有结构化的预约表单，缺的信息用提问选项卡问。
// 这里只按数据画界面；数据现在来自演示脚本 mock/booking.js（?mock=booking），以后由服务端按同样的结构推过来。
// 选项卡上的按钮只带 data-ask-*，由演示脚本（以后是真实流程）接管点击。
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const secs = (n) => (n < 60 ? `${n} 秒` : `${Math.floor(n / 60)} 分 ${n % 60} 秒`);

// ---------- 补全预约信息（仿 Claude Code 的提问选项卡）：一次一个问题，点选项或按数字键；最后一个选完就替你发出去 ----------
// 不是表单：也可以不点，直接在输入框里说（「纯色，下午三点，有空就约」）。
function askHtml(b) {
  const done = !!b.answered;
  const label = (q) => q.options.find((o) => o.value === b.answers?.[q.key])?.label || b.answers?.[q.key] || '';
  const tabs = b.questions.map((q, i) => `<button type="button" class="bk-asktab${!done && i === b.cur ? ' on' : ''}${b.answers?.[q.key] ? ' ok' : ''}"`
    + ` data-ask-tab="${i}"${done ? ' disabled' : ''}><i>${b.answers?.[q.key] ? '✓' : ''}</i>${esc(q.tab)}</button>`).join('');
  const q = b.questions[b.cur] || b.questions[0];
  const body = done
    ? `<div class="bk-asksum">${b.questions.map((x) => `${esc(x.tab)}：<b>${esc(label(x))}</b>`).join(' · ')}</div>`
    : `<div class="bk-askq">${esc(q.label)}</div>
      <ol class="bk-askopts">${q.options.map((o, i) => `<li><button type="button" class="${b.answers?.[q.key] === o.value ? 'on' : ''}" data-ask-opt="${esc(o.value)}">`
        + `<kbd>${i + 1}</kbd><span><b>${esc(o.label)}</b>${o.hint ? `<small>${esc(o.hint)}</small>` : ''}</span></button></li>`).join('')}
        <li class="other"><button type="button" data-ask-other><kbd>${q.options.length + 1}</kbd><span>其他：直接在输入框里说</span></button></li></ol>`;
  return `<div class="bk-card bk-ask${done ? ' done' : ''}"><div class="bk-asktabs">${tabs}</div>${body}</div>`;
}

// 聊天消息里的电话预订卡片（m.booking）：提问选项卡，和打完电话挂在消息下面的通话组件
export function bookingHtml(b) {
  if (b.type === 'ask') return askHtml(b);
  if (b.type === 'calls') return b.calls.map(callCardHtml).join('');
  return '';
}

// ---------- 通话记录（仿 Cue：喵团有自己的电话，每通电话一条记录） ----------
// 聊天里每通电话打完挂一个通话组件（通话 · 哪家 · 几点 · 查看详情）；侧边栏「喵团档案 → 电话」里是全部通话记录，点开看详情和转写。
// 记录：{ id, who, short, phone, agent, at, seconds, status: 'done' | 'noanswer', summary, lines }；点击只带 data-call / data-open-calls，由演示脚本接管。
export const PHONE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 3.5h2.6l1.4 4.1-1.9 1.3a11.5 11.5 0 0 0 6.4 6.4l1.3-1.9 4.1 1.4v2.6a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const clock = (iso) => new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
const outcome = (c) => (c.status === 'noanswer' ? `响了 ${c.seconds} 秒没人接` : `通话 ${Math.floor(c.seconds / 60)}:${String(c.seconds % 60).padStart(2, '0')}`);

function callCardHtml(c) {
  return `<button type="button" class="bk-callcard" data-call="${esc(c.id)}">
    <span class="bk-callicon">${PHONE_ICON}</span><span class="bk-callmain"><b>通话</b><small>${esc(c.short)} · ${clock(c.at)}</small></span>${CHEVRON}
    <em>查看详情</em>
  </button>`;
}

// 「电话」页：喵团用的线路（不显示号码，写「美团专线」），下面是通话记录（新的在上）
export function callLogHtml(line, calls) {
  const rows = [...calls].reverse().map((c) => `<li><button type="button" data-call="${esc(c.id)}">
      <span class="bk-callicon${c.status === 'noanswer' ? ' miss' : ''}">${PHONE_ICON}</span>
      <span class="bk-callmain"><b>${esc(c.short)}</b><small>${clock(c.at)} · ${outcome(c)}</small></span>${CHEVRON}</button></li>`).join('');
  return `<div class="bk-phone"><span class="bk-callicon">${PHONE_ICON}</span><span class="bk-callmain"><b>${esc(line)}</b><small>喵团的电话 · 替你打给商家</small></span></div>
    <div class="bk-calllisthead">通话记录${calls.length ? ` · ${calls.length}` : ''}</div>
    ${rows ? `<ul class="bk-calllist">${rows}</ul>` : '<div class="bk-callempty">还没打过电话</div>'}`;
}

// 一通电话的详情：打给谁、什么时候、结果，喵团的小结，挂断后给的转写
export function callDetailHtml(c, line) {
  const fact = (k, v) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`;
  return `<div class="bk-calldetail">
    <div class="bk-calltop"><b>${esc(c.who)}</b><small>${esc(c.phone)}</small></div>
    <dl class="bk-callfacts">${fact('时间', clock(c.at))}${fact('结果', outcome(c))}${fact('拨出号码', line)}</dl>
    ${c.summary ? `<p class="bk-callsum">${esc(c.summary)}</p>` : ''}
    ${c.lines.length ? `<div class="bk-calltitle">通话转写（${c.lines.length} 句）</div>${linesHtml(c.lines, c.agent)}` : ''}
  </div>`;
}

// ---------- 任务页里的通话：排队 → 拨号 → 通话 → 核对。外呼平台挂断后才给转写，通话中只显示阶段和计时 ----------
const STAGES = [['queued', '排队'], ['dialing', '拨号'], ['talking', '通话'], ['verifying', '核对']];
const STAGE_TEXT = { queued: '排队中', dialing: '正在拨号…', talking: '通话中', verifying: '核对结果…', retry: '等待重拨', waiting: '等你决定', done: '通话结束' };

function linesHtml(lines, agent) {
  return `<div class="bk-lines">${lines.map((l) => `<p class="${l.who}"><i>${l.who === 'ai' ? esc(agent) : '店员'}</i><span>${esc(l.text)}</span></p>`).join('')}</div>`;
}

export function callHtml(t) {
  const c = t?.call;
  if (!c) return '';
  const order = STAGES.map(([k]) => k);
  const at = c.stage === 'retry' ? 1 : order.includes(c.stage) ? order.indexOf(c.stage) : order.length;
  const stages = STAGES.map(([k, label], i) => {
    if (c.stage === 'retry' && k === 'dialing') return '<li class="fail">没人接</li>';
    return `<li class="${i < at ? 'done' : i === at ? 'now' : ''}">${label}</li>`;
  }).join('');
  const live = ['dialing', 'talking', 'verifying'].includes(c.stage);
  const took = t.startedAt ? Math.max(0, Math.round(((t.endedAt ? Date.parse(t.endedAt) : Date.now()) - Date.parse(t.startedAt)) / 1000)) : 0;
  const note = c.stage === 'retry'
    ? `<div class="bk-callnote warn">第 ${c.attempt} 次没人接，${esc(c.retryIn)}后再打 1 次（这家店每天最多打 ${c.maxAttempts} 次）。你可以先去忙，有结果会通知你。</div>`
    : c.stage === 'waiting' ? '<div class="bk-callnote warn">店里给的条件跟你确认的不一样，我没答应，等你决定后回电。</div>'
      : live ? `<div class="bk-callnote">预计 ${esc(c.eta)}出结果 · 你可以先去忙，结果会通知你</div>` : '';
  const transcript = live || !c.lines.length ? ''
    : `<details class="bk-script"><summary>通话转写（${c.lines.length} 句）</summary>${linesHtml(c.lines, c.agent)}</details>`;
  return `<div class="bk-call">
    <div class="bk-callhead">
      <span class="bk-ring${live ? ' live' : ''}">📞</span>
      <span class="bk-callwho"><b>${esc(c.shop)}</b><small>${esc(c.phone)}${c.attempt > 1 ? ` · 第 ${c.attempt} 次拨打` : ''}</small></span>
      <span class="bk-callstate${c.stage === 'retry' || c.stage === 'waiting' ? ' warn' : ''}">${STAGE_TEXT[c.stage] || ''}${live ? ` <span data-elapsed="${esc(t.id)}">${secs(took)}</span>` : ''}</span>
    </div>
    <ol class="bk-stages">${stages}</ol>
    ${transcript}${note}
  </div>`;
}

// ---------- App 外通知（演示用，仿手机系统通知横幅） ----------
export function noticeHtml(n) {
  return `<img src="longcat-icon.svg" alt=""><span class="bk-ntext"><span class="bk-nmeta"><em>喵团</em><time>现在</time></span><b>${esc(n.title)}</b><span>${esc(n.body)}</span></span>`;
}
