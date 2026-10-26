// 前端到处用的小函数：选元素、转义、时间、简易 Markdown、按 key 增量更新列表。
export const $ = (s) => document.querySelector(s);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// localStorage 里记的界面偏好（收起的小电视、当前页面……）：读写失败（隐私模式）就当没有
export const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

export const CHEVRON = '<svg class="tschev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ---------- 时间 ----------
export const clock = (iso) => new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
// 今天的只写时间，别的日子带上日期
export function dayClock(iso) {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? clock(iso) : `${d.getMonth() + 1}月${d.getDate()}日 ${clock(iso)}`;
}
export const fmtSecs = (s) => (s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`);
export function elapsed(t) {
  const start = Date.parse(t.startedAt || t.createdAt);
  const end = t.endedAt ? Date.parse(t.endedAt) : Date.now();
  return fmtSecs(Math.max(0, Math.round((end - start) / 1000)));
}
export function chatGroup(iso) {
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(new Date(iso))) / 86_400_000);
  return diff <= 0 ? '今天' : diff === 1 ? '昨天' : diff < 7 ? '7 天内' : '更早';
}
// 按天分组的标题：今天 / 昨天 / 10月18日（不是今年的带上年份）
export function dayLabel(iso) {
  const g = chatGroup(iso);
  if (g === '今天' || g === '昨天') return g;
  const d = new Date(iso);
  return `${d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}年`}${d.getMonth() + 1}月${d.getDate()}日`;
}
// 目标多久查一次：once 是到点办一次
export const scheduleLabel = (s) => (s?.once ? `${dayClock(s.once)} 一次` : s?.at ? `每天 ${s.at}` : s?.every >= 60 ? `每 ${+(s.every / 60).toFixed(1)} 小时` : `每 ${s?.every} 分钟`);

// ---------- 文字 ----------
export const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; } };
export const imgProxy = (u) => `/api/img?u=${encodeURIComponent(u)}`;
export const thumbSrc = (u) => (/\.bing\.net\//.test(u) ? u : imgProxy(u)); // 必应缩略图可直连，其余走代理（补 Referer / 翻墙）
// 一段话里的第一句；一段文字里第一行有内容的（跳过 Markdown 标题、表格和小标题）
export const oneSentence = (text) => String(text || '').trim().split(/(?<=[。！？!?])\s*/).find(Boolean) || '';
export function firstLine(text) {
  const line = String(text || '').split('\n').map((l) => l.replace(/^[>*•\-\s]+|\*\*/g, '').trim()).find((l) => l && !/^[#|]/.test(l) && !/[：:]$/.test(l)) || '';
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

const link = (url, label) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
// 聊天气泡里的字：加粗和网址
export const renderText = (t) => esc(t).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[\s(（])(https?:\/\/[^\s<>"）)]+)/g, (_, pre, url) => `${pre}${link(url, url)}`)
  .replace(/\n{3,}/g, '\n\n').trim();

// 简易 Markdown（文档、结果全文）：标题、列表、表格、加粗、链接；正文里的 [n] 链到来源
function mdInline(text, byN) {
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => link(url, label))
    .replace(/(^|[\s(（:：])(https?:\/\/[^\s<>")　-〿＀-￯]+)/g, (_, pre, url) => `${pre}${link(url, url)}`)
    .replace(/\[(\d+)\]/g, (m, n) => {
      const src = byN.get(Number(n));
      return src ? `<a class="cite" href="${esc(src.url)}" target="_blank" rel="noopener noreferrer" title="${esc(src.title)}">[${n}]</a>` : m;
    });
}

export function mdHtml(src, sources = []) {
  const byN = new Map(sources.map((x) => [x.n, x]));
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

// 按 key 增量更新子元素，只换 HTML 变了的：任务一直在推进度，整块重画会闪、会丢掉展开状态
export function patchList(box, items) {
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
