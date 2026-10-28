// 网页正文提取（web_fetch 的 http 后端用）：Readability 找出正文，再转成 Markdown（标题、段落、列表、链接、代码、引用、表格）。
// 找不到正文（列表页、导航页）就用整页。脚本、样式、表单、图片都不要；不跑页面上的脚本。
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';

// 超过这么大的 HTML（比如 SEC 的招股书，十几 MB）Readability 要跑好几秒、占几百 MB 内存，还会卡住整个 App：改用正则快速转成文本
const BIG_HTML = 2_000_000;

export function unescapeHtml(input) {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return String(input || '').replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (whole, code) => {
    if (!code.startsWith('#')) return named[code.toLowerCase()] ?? whole;
    const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
  });
}


const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'form', 'button', 'select', 'input', 'textarea', 'img', 'picture', 'video', 'audio']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'table', 'details', 'summary', 'address']);

function absolute(href, base) {
  try {
    const url = new URL(href, base);
    return /^https?:$/.test(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function markdown(node, base) {
  if (node.nodeType === 3) return node.textContent.replace(/\s+/g, ' ');
  if (node.nodeType !== 1) return '';
  const tag = node.localName;
  if (SKIP.has(tag)) return '';
  const inner = () => [...node.childNodes].map((child) => markdown(child, base)).join('');
  if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${inner().trim()}\n\n`;
  if (BLOCK.has(tag)) return `\n\n${inner().trim()}\n\n`;
  switch (tag) {
    case 'br': return '\n';
    case 'hr': return '\n\n---\n\n';
    case 'ul': case 'ol': return `\n\n${inner().trim()}\n\n`;
    case 'li': { const text = inner().trim().replace(/\n+/g, ' '); return text ? `\n- ${text}` : ''; }
    case 'pre': return `\n\n\`\`\`\n${node.textContent.trim()}\n\`\`\`\n\n`;
    case 'code': return `\`${node.textContent.trim()}\``;
    case 'blockquote': return `\n\n> ${inner().trim().replace(/\n+/g, '\n> ')}\n\n`;
    case 'tr': return `\n| ${[...node.children].map((cell) => markdown(cell, base).trim().replace(/\s*\n\s*/g, ' ').replace(/\|/g, '/')).join(' | ')} |`;
    case 'a': {
      const text = inner().trim();
      const href = absolute(node.getAttribute('href') || '', base);
      return text && href ? `[${text}](${href})` : text;
    }
    default: return inner();
  }
}

const tidy = (text) => text.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// 大页面：去掉脚本和样式，表格每行压成一行（空格子去掉，「$」「%」「)」并回旁边的数字），块级标签换行，再去掉其余标签
const tableRow = (_, row) => {
  const cells = row.split(/<\/t[dh]>/i).map((cell) => cell.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  return cells.length ? `\n| ${cells.join(' | ').replace(/\$ \| /g, '$').replace(/ \| ([%)])/g, '$1')} |\n` : '\n';
};
function roughText(html) {
  return unescapeHtml(html
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, tableRow)
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/table|\/section)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\u00a0]+/g, ' ');
}

/** HTML → { title, text(Markdown) }. base 用来把相对链接补成完整网址。 */
export function htmlToMarkdown(html, base) {
  if (html.length > BIG_HTML) return { title: unescapeHtml(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').trim(), text: tidy(roughText(html)) };
  const { document } = parseHTML(html);
  const title = (document.title || '').trim();
  const article = new Readability(document).parse(); // 会改动 document，要在取标题之后
  let root;
  if (article?.content) root = parseHTML(`<!doctype html><html><body>${article.content}</body></html>`).document.body;
  else { // 没有明显的正文：用整页，去掉导航、页头页脚和侧栏
    root = parseHTML(html).document.body;
    for (const el of root?.querySelectorAll('nav, header, footer, aside, [role=navigation]') || []) el.remove();
  }
  const text = root ? markdown(root, base) : '';
  return { title: title || article?.title || '', text: tidy(text) };
}

/** 长文分页：从 offset 开始取 max 字；给了 find 就从 offset 之后第一次出现它的地方开始（往前留一点上下文），并数一下一共出现几次。
 *  find 不分大小写，空白和换行都算一样（网页里同一句话常被折成几行）。 */
export function pageOf(text, { offset = 0, find = '', max }) {
  let start = Math.max(0, Math.min(Math.trunc(offset) || 0, text.length));
  let matches;
  if (find) {
    const pattern = new RegExp(find.trim().split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'gi');
    pattern.lastIndex = start;
    const at = pattern.exec(text)?.index ?? -1;
    if (at < 0) return { start, end: start, text: '', matches: 0 };
    matches = 0;
    for (pattern.lastIndex = 0; pattern.exec(text) && matches < 999;) matches++;
    start = Math.max(0, at - 200);
  }
  const end = Math.min(text.length, start + max);
  return { start, end, text: text.slice(start, end).toWellFormed(), ...(find && { matches }) };
}
