// User-scoped business tools. Pi invokes these functions directly in Node.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readJson, writeJson, withFileLock, fetchJson, tool } from './common.mjs';

const TYPES = ['expense', 'income'];
const SECTIONS = ['## 预算', '## 固定收支', '## 消费习惯', '## 备注'];
const MEMORY_TEMPLATE = `# 记账记忆\n\n${SECTIONS.join('\n\n')}\n`;
const SITE_ID = /^s_[0-9a-f]{8}$/;
const MAX_HTML = 1_500_000;

const schemas = {
  ledger_add: {
    description: '把一笔或多笔收支记进用户的账本（和 App 记账面板是同一份）。用户说「午饭 35」「打车 22」「买书 59」「今天发工资 8000」这类话时调用；一句话里有几笔就在 entries 里放几条，一次写入。amount 填正数，用 type 区分支出 expense / 收入 income。支出分类：餐饮、交通、购物、娱乐、旅行、居住、医疗、学习、人情、其他；收入分类：工资、副业、红包、其他。date 只在用户说了「昨天」「上周五」这类日期时才填（YYYY-MM-DD），默认今天。同一笔不要重复记；用户说记错了，先 ledger_delete 再重新记。返回写入的条目（含 id）和今天/本月支出合计。',
    parameters: { type: 'object', properties: { entries: { type: 'array', description: '要记的收支，每笔一条', items: {
      type: 'object', properties: {
        type: { type: 'string', enum: TYPES, description: 'expense 支出（默认）/ income 收入' },
        amount: { type: 'number', description: '金额，正数，单位元，例如 35.5' },
        category: { type: 'string', description: '分类，例如「餐饮」「交通」「旅行」「工资」' },
        note: { type: 'string', description: '备注，用用户的原话，例如「午饭」「打车回家」' },
        date: { type: 'string', description: 'YYYY-MM-DD，不填为今天' },
      }, required: ['amount', 'category'],
    } } }, required: ['entries'] },
  },
  ledger_query: {
    description: '查账本：按日期范围（默认本月 1 号到今天）和可选的分类、收支类型筛选，返回最多 100 条明细（新的在前）和汇总（summary：总支出 totalExpense、总收入 totalIncome、按分类合计 byCategory、按天合计 byDay，汇总覆盖全部匹配记录）。用户问「这个月花了多少」「上周吃饭花了多少」「最近打车花了多少」「今天记了什么」时调用；回答金额以 summary 为准，不要自己累加明细。要删除或更正某笔记录时，也先用它找到 id。',
    parameters: { type: 'object', properties: {
      from: { type: 'string', description: '开始日期 YYYY-MM-DD（含），默认本月 1 号' },
      to: { type: 'string', description: '结束日期 YYYY-MM-DD（含），默认今天' },
      category: { type: 'string', description: '只看这个分类，例如「餐饮」；不填看全部' },
      type: { type: 'string', enum: TYPES, description: '只看支出 expense 或收入 income；不填两种都看' },
    } },
  },
  ledger_delete: {
    description: '按 id 删除账本里的记录。用户说「刚才那笔记错了」「把打车那笔删掉」时调用：id 来自 ledger_add 的返回或先用 ledger_query 查到。改金额或分类 = 删掉旧的再 ledger_add 一条新的。只删用户明确要删的那几笔。',
    parameters: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' }, description: '要删除的记录 id，例如 ["l_mgr3k2xa1b2c3d"]' } }, required: ['ids'] },
  },
  ledger_memory: {
    description: '读写记账记忆 LEDGER.md（用户的预算、固定收支、消费习惯、备注；App 会展示给用户看）。action=read 读取全文；action=update 传完整的新 Markdown 整份替换，必须保留「## 预算」「## 固定收支」「## 消费习惯」「## 备注」四个标题。用户设定或调整预算、提到固定支出或收入（房租、工资日、会员订阅）、你从账本里看出稳定的消费习惯时，先 read 再 update；做月度总结、提醒预算或分析消费前，先 read。',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['read', 'update'] }, content: { type: 'string', description: 'update：完整的新 LEDGER.md 内容（Markdown）' } }, required: ['action'] },
  },
  publish_site: {
    description: '把做好的网页发布出来：用户在 App 聊天里点网站卡片，就能在 App 的内置浏览器里直接看。用户要「网站 / 网页 / 可视化页面 / 导游图 / 攻略页 / 清单页 / H5」时用它，做之前先 skill_view web-page。html 是完整的单文件网页（CSS、JS 都写在里面）；外部资源只能用 https（例如 cdnjs 上的 Leaflet、地图瓦片、https 图片），访问不了 localhost 和内网。要修改已有网站时带上 site_id（先 read_site 读出原来的 HTML 再改），会发布成新版本。发布后不要把 HTML 代码贴在回复里，也不要说「附件」「下载」「用浏览器打开」。',
    parameters: { type: 'object', properties: {
      title: { type: 'string', description: '网站标题，不超过 30 字，例如「首尔医美诊所地图」' },
      html: { type: 'string', description: '完整的 HTML 文档（<!DOCTYPE html> 开头，CSS/JS 内联）' },
      description: { type: 'string', description: '一句话说明网站里有什么（可选）' },
      site_id: { type: 'string', description: '要更新的网站 id（s_ 开头）；新网站不填' },
    }, required: ['title', 'html'] },
  },
  read_site: {
    description: '读一个已发布网站的 HTML 源码和标题。用户要改某个网站时，先用它读出原来的内容，改好后用 publish_site 带同一个 site_id 发布。',
    parameters: { type: 'object', properties: { site_id: { type: 'string', description: '网站 id（s_ 开头）' } }, required: ['site_id'] },
  },
  check_site: {
    description: '在沙箱浏览器里真的打开一个已发布的网站（手机宽度），看它能不能用：返回 JS 报错（带 index.html 行号和那一行代码）、加载失败的资源、弹窗、页面标题和可见文字、页面上能点的按钮，以及首屏截图的本地路径（可以用 vision_analyze 看图）。可以按顺序点几下（例如「开始」→ 第一个选项）再看点完后的报错和画面，用来检查游戏、测验、筛选这类交互。发布或更新网站后、用户说网页打不开 / 点不动 / 有 bug 时，先用它看真实报错再改，不要只读源码猜。',
    parameters: { type: 'object', properties: {
      site_id: { type: 'string', description: '网站 id（s_ 开头）' },
      click: { type: 'array', items: { type: 'string' }, description: '按顺序要点的东西，最多 5 个：按钮上的文字（例如「开始挑战」）或 CSS 选择器（例如 #start、.option-btn）。不填就只看打开后的首屏' },
      viewport: { type: 'string', enum: ['mobile', 'desktop'], description: 'mobile（默认，390px 宽）或 desktop（1280px）' },
    }, required: ['site_id'] },
  },
  phone_call: {
    description: '用美团专线替用户给商家或机构打一通电话，挂断后返回结果：有没有打出去、有没有接通、对话转写、问到的信息、要不要回来问用户、能不能再打。适合预约、问空位和价格、确认、改约、取消、传话。一次打一家，要问几家就调几次。mode=ask 只问不约：不报用户任何信息、不答应任何事。mode=book 要约：只有用户已经点头的任务才能打，details 必须带齐日期、时间、人数（美甲、按摩这类还要项目；球场要时长、场地），App 会检查，缺了不拨。结果里 dialed=false 是没拨（看 result 说为什么）；need_user=true 是店里提了用户没授权的条件，别自己决定，回来问用户；retry 说明能不能再打（soon 可以马上再试一次；later 这次别再打，App 会自动排一次重拨，redial_at 是几点再打；tomorrow/no 别再打）。',
    parameters: { type: 'object', properties: {
      to: { type: 'string', description: '对方电话号码，比如 010-12345678' },
      name: { type: 'string', description: '打给谁：店名或机构名，比如「栗子美甲（和平里店）」' },
      goal: { type: 'string', description: '这通电话要办的事，一句话，比如「问明天下午三点能不能做纯色美甲」' },
      mode: { type: 'string', enum: ['ask', 'book'], description: 'ask 只问不约；book 要约（用户点过头的任务才行）' },
      category: { type: 'string', description: '品类，比如 美甲、餐厅、SPA、网球、物业' },
      details: { type: 'object', description: '预约信息，键用中文：日期、时间、人数、项目、时长、场地……只问不约时写想问的日期时间即可' },
      share: { type: 'string', description: '可以告诉对方的用户信息（只在 mode=book 时用；不写默认报预约人名字）' },
      questions: { type: 'array', items: { type: 'string' }, description: '要问清的事，比如「价格」「付款方式」「要不要提前预约」' },
      ask_user_if: { type: 'array', items: { type: 'string' }, description: '碰到这些情况不答应、回来问用户，比如「只能约别的时间」「要交定金」「要本人通话」' },
    }, required: ['to', 'name', 'goal', 'mode'] },
  },
};

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

const today = () => new Date().toLocaleDateString('sv-SE');
const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const clean = (value) => String(value ?? '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);

function dateOf(value, fallback) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  const days = { 今天: 0, today: 0, 昨天: 1, yesterday: 1, 前天: 2 };
  if (Object.hasOwn(days, text.toLowerCase())) {
    const d = new Date();
    d.setDate(d.getDate() - days[text.toLowerCase()]);
    return d.toLocaleDateString('sv-SE');
  }
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (match) {
    const [year, month, day] = match.slice(1).map(Number);
    const d = new Date(0);
    d.setFullYear(year, month - 1, day);
    if (year >= 1 && d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day) {
      return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  throw new Error(`date 要用 YYYY-MM-DD 格式：${JSON.stringify(text)}`);
}

function amountOf(value) {
  if (typeof value === 'boolean' || value == null) throw new Error('amount 必须是数字');
  const stripped = typeof value === 'string' ? value.replace(/[¥￥元块,，\s]/g, '') : value;
  if (stripped === '' || (typeof stripped !== 'number' && typeof stripped !== 'string')) throw new Error(`amount 不是数字：${JSON.stringify(value)}`);
  const n = Math.abs(Number(stripped));
  if (!Number.isFinite(n) || round(n) <= 0) throw new Error(`amount 必须大于 0：${JSON.stringify(value)}`);
  return round(n);
}

function normalize(item, day, now) {
  if (!isRecord(item)) throw new Error('每笔记录必须是对象');
  const type = String(item.type || 'expense').trim().toLowerCase();
  if (!TYPES.includes(type)) throw new Error(`type 只能是 expense 或 income：${JSON.stringify(type)}`);
  return { id: `l_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`, type, amount: amountOf(item.amount),
    category: String(item.category || '').trim() || '其他', note: String(item.note || '').trim(),
    date: dateOf(item.date, day), createdAt: now, source: 'agent' };
}

function summarize(entries) {
  const totals = { expense: 0, income: 0 };
  const cats = { expense: new Map(), income: new Map() };
  const days = new Map();
  for (const e of entries) {
    if (!TYPES.includes(e.type)) continue;
    const amt = num(e.amount), cat = String(e.category || '其他'), day = String(e.date);
    totals[e.type] += amt;
    cats[e.type].set(cat, (cats[e.type].get(cat) || 0) + amt);
    if (!days.has(day)) days.set(day, { expense: 0, income: 0 });
    days.get(day)[e.type] += amt;
  }
  return { totalExpense: round(totals.expense), totalIncome: round(totals.income), net: round(totals.income - totals.expense),
    byCategory: Object.fromEntries(TYPES.map((type) => [type, Object.fromEntries([...cats[type]].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, round(v)]))])),
    byDay: Object.fromEntries([...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, sums]) => [day, { expense: round(sums.expense), income: round(sums.income) }])) };
}

const expenseBetween = (entries, from, to) => round(entries.reduce((sum, e) => sum + (isRecord(e) && e.type === 'expense' && e.date >= from && e.date <= to ? num(e.amount) : 0), 0));
function rawFile(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

async function loadLedger(file, signal) {
  for (let i = 0; i < 5; i++) {
    signal?.throwIfAborted();
    const raw = rawFile(file);
    try {
      const entries = raw?.trim() ? JSON.parse(raw) : [];
      if (!Array.isArray(entries)) throw new Error('账本顶层不是数组');
      return { raw, entries };
    } catch {
      if (i === 4) throw new Error(`账本文件 ${file} 不是合法的 JSON 数组，没有改动它`);
      await delay(50, undefined, { signal });
    }
  }
}

async function updateLedger(file, mutate, signal) {
  return withFileLock(file, async () => {
    for (let i = 0; i < 20; i++) {
      const { raw, entries } = await loadLedger(file, signal);
      const before = JSON.stringify(entries);
      const result = mutate(entries);
      if (before === JSON.stringify(entries)) return result;
      signal?.throwIfAborted();
      if (rawFile(file) !== raw) continue;
      writeJson(file, entries);
      return result;
    }
    throw new Error('账本正在被频繁改写，稍后再试');
  }, signal);
}

function normalizeHtml(raw, title) {
  let html = clean(raw).trim();
  const fenced = /^```(?:html)?\s*\n([\s\S]*?)\n?```$/i.exec(html);
  if (fenced) html = fenced[1].trim();
  if (!/<!doctype|<html/i.test(html.slice(0, 500))) {
    const escaped = title.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[c]);
    html = `<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escaped}</title>\n</head>\n<body>\n${html}\n</body>\n</html>`;
  }
  return html;
}

export function createBusinessTools(ctx) {
  if (!ctx.home) throw new Error('Business tools require a user home');
  const home = path.resolve(ctx.home);
  const env = ctx.env || {};
  const ledgerFile = path.join(home, 'ledger/entries.json');
  const memoryFile = path.join(home, 'ledger/LEDGER.md');
  const sites = path.join(home, 'sites');
  const taskId = /^task-(t_[a-z0-9]+)$/.exec(String(ctx.sessionId || ''))?.[1];
  const taskHeaders = taskId ? { 'x-cattuan-task': taskId } : {};
  const assertOwned = (file) => {
    const boundary = fs.realpathSync(home);
    let ancestor = file;
    for (;;) {
      try {
        const relative = path.relative(boundary, fs.realpathSync(ancestor));
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('数据文件不属于当前用户');
        return;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw e;
        ancestor = parent;
      }
    }
  };
  const guarded = (prefix, fn) => async (args = {}, signal) => {
    try { signal?.throwIfAborted(); return await fn(args, signal); }
    catch (e) { if (signal?.aborted || e.name === 'AbortError') throw e; return { error: `${prefix}：${e.message}` }; }
  };
  const siteFolder = (id, requireFile = 'index.html') => {
    if (!SITE_ID.test(id)) return null;
    const folder = path.join(sites, id);
    if (!fs.existsSync(path.join(folder, requireFile))) return null;
    // An id in one user's home must never resolve into a different user's files.
    assertOwned(folder);
    assertOwned(path.join(folder, requireFile));
    assertOwned(path.join(folder, 'meta.json'));
    return folder;
  };

  return [
    tool('ledger_add', 'ledger', schemas.ledger_add, guarded('记账失败', async (args, signal) => {
      assertOwned(ledgerFile);
      const items = isRecord(args.entries) ? [args.entries] : args.entries;
      if (!Array.isArray(items) || !items.length) return { error: 'entries 需要是非空数组，例如 [{"amount": 35, "category": "餐饮", "note": "午饭"}]' };
      const day = today(), now = new Date().toISOString(), added = [], details = [];
      items.forEach((item, i) => { try { added.push(normalize(item, day, now)); } catch (e) { details.push(`第 ${i + 1} 笔：${e.message}`); } });
      if (details.length) return { error: '有记录不合法，这一批都没有写入，改好后整批重新调用', details };
      const totals = await updateLedger(ledgerFile, (entries) => {
        entries.push(...added);
        return { todayExpense: expenseBetween(entries, day, day), monthExpense: expenseBetween(entries, `${day.slice(0, 8)}01`, day) };
      }, signal);
      return { ok: true, added, today: day, ...totals };
    })),
    tool('ledger_query', 'ledger', schemas.ledger_query, guarded('查账失败', async (args, signal) => {
      assertOwned(ledgerFile);
      const day = today();
      let from = dateOf(args.from, `${day.slice(0, 8)}01`), to = dateOf(args.to, day);
      if (from > to) [from, to] = [to, from];
      const category = String(args.category || '').trim(), type = String(args.type || '').trim().toLowerCase();
      if (type && !TYPES.includes(type)) return { error: `type 只能是 expense 或 income：${JSON.stringify(type)}` };
      const { entries } = await loadLedger(ledgerFile, signal);
      const matched = entries.filter((e) => isRecord(e) && String(e.date || '') >= from && String(e.date || '') <= to && (!category || e.category === category) && (!type || e.type === type));
      matched.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      return { from, to, today: day, filters: { ...(category ? { category } : {}), ...(type ? { type } : {}) }, count: matched.length,
        entries: matched.slice(0, 100), truncated: matched.length > 100, summary: summarize(matched) };
    })),
    tool('ledger_delete', 'ledger', schemas.ledger_delete, guarded('删除失败', async (args, signal) => {
      assertOwned(ledgerFile);
      let ids = args.ids || args.id || [];
      if (typeof ids === 'string') ids = [ids];
      if (!Array.isArray(ids)) return { error: '需要 ids：要删除的记录 id 数组' };
      const wanted = new Set(ids.map((id) => String(id).trim()).filter(Boolean));
      if (!wanted.size) return { error: '需要 ids：要删除的记录 id 数组' };
      const deleted = await updateLedger(ledgerFile, (entries) => {
        const removed = entries.filter((e) => isRecord(e) && wanted.has(e.id));
        for (let i = entries.length - 1; i >= 0; i--) if (isRecord(entries[i]) && wanted.has(entries[i].id)) entries.splice(i, 1);
        return removed;
      }, signal);
      const found = new Set(deleted.map((e) => e.id)), notFound = [...wanted].filter((id) => !found.has(id)).sort();
      return { ok: true, deleted, ...(notFound.length ? { notFound } : {}) };
    })),
    tool('ledger_memory', 'ledger', schemas.ledger_memory, guarded('记账记忆读写失败', async (args, signal) => {
      assertOwned(memoryFile);
      return withFileLock(memoryFile, () => {
      const action = String(args.action || 'read').trim();
      if (action === 'read') {
        if (!fs.existsSync(memoryFile)) writeText(memoryFile, MEMORY_TEMPLATE);
        return { content: fs.readFileSync(memoryFile, 'utf8') };
      }
      if (action !== 'update') return { error: `未知 action：${action}（只支持 read / update）` };
      if (typeof args.content !== 'string' || !args.content.trim()) return { error: 'update 需要 content：完整的新 LEDGER.md 内容' };
      let content = `${args.content.trim()}\n`;
      const addedSections = SECTIONS.filter((heading) => !content.split(/\r?\n/).some((line) => line.trimEnd() === heading));
      content += addedSections.map((heading) => `\n${heading}\n`).join('');
      writeText(memoryFile, content);
      return { ok: true, content, ...(addedSections.length ? { addedSections } : {}) };
      }, signal);
    })),
    tool('publish_site', 'sites', schemas.publish_site, guarded('发布失败', async (args, signal) => {
      assertOwned(sites);
      const title = [...clean(args.title).trim()].slice(0, 40).join('') || '未命名网站';
      if (!String(args.html || '').trim()) return { error: 'html 不能为空' };
      const html = normalizeHtml(args.html, title);
      if ([...html].length > MAX_HTML) return { error: `网页太大了（${[...html].length} 字符，上限 ${MAX_HTML}），把大段数据精简一下再发` };
      let id = String(args.site_id || '').trim();
      if (id && !siteFolder(id, 'meta.json')) return { error: `没有网站 ${id}；新网站不要填 site_id` };
      if (!id) id = `s_${randomBytes(4).toString('hex')}`;
      const folder = path.join(sites, id), metaFile = path.join(folder, 'meta.json');
      assertOwned(path.join(folder, 'index.html'));
      assertOwned(path.join(folder, 'index.prev.html'));
      fs.mkdirSync(folder, { recursive: true });
      // Validate newly-created parents too, in case an imported home contains links.
      const relative = path.relative(fs.realpathSync(home), fs.realpathSync(folder));
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('网站目录不属于当前用户');
      return withFileLock(metaFile, () => {
        const now = new Date().toISOString();
        const meta = readJson(metaFile, { id, createdAt: now, version: 0 });
        const index = path.join(folder, 'index.html');
        if (fs.existsSync(index)) writeText(path.join(folder, 'index.prev.html'), fs.readFileSync(index, 'utf8'));
        writeText(index, html);
        Object.assign(meta, { id, title, description: [...clean(args.description).trim()].slice(0, 120).join(''), version: (Number(meta.version) || 0) + 1, updatedAt: now });
        writeJson(metaFile, meta);
        return { ok: true, site: { id, title, version: meta.version, url: `${String(env.CATTUAN_SITES_URL || 'http://localhost:3211').replace(/\/$/, '')}/${id}/` },
          note: '已发布。App 会在聊天消息下面放这个网站的卡片，用户点开就能在 App 里看。回复里用两三句说说网站里有什么，不要贴代码，不要说附件或下载。' };
      }, signal);
    })),
    tool('read_site', 'sites', schemas.read_site, guarded('读取网站失败', async (args) => {
      const id = String(args.site_id || '').trim(), folder = siteFolder(id);
      if (!folder) return { error: `没有网站 ${id}` };
      const meta = readJson(path.join(folder, 'meta.json'), {});
      return { site_id: id, title: meta.title || '', version: meta.version ?? 1, html: fs.readFileSync(path.join(folder, 'index.html'), 'utf8') };
    })),
    tool('check_site', 'sites', schemas.check_site, guarded('沙箱不可用', async (args, signal) => {
      const id = String(args.site_id || '').trim(), folder = siteFolder(id);
      if (!folder) return { error: `没有网站 ${id}` };
      const url = new URL('/site/check', env.CATTUAN_SANDBOX_URL || 'http://127.0.0.1:8660');
      url.searchParams.set('id', id);
      const clicks = typeof args.click === 'string' ? [args.click] : (Array.isArray(args.click) ? args.click : []);
      for (const click of clicks.filter((c) => String(c || '').trim()).slice(0, 5)) url.searchParams.append('click', [...clean(click).trim()].slice(0, 100).join(''));
      if (['mobile', 'desktop'].includes(args.viewport)) url.searchParams.set('viewport', args.viewport);
      const data = await fetchJson(url, { headers: taskHeaders, timeoutMs: 130_000, signal });
      if (data.error) return { site_id: id, error: data.message || data.error };
      const meta = readJson(path.join(folder, 'meta.json'), {});
      const issues = (data.issues || []).map((issue) => Object.fromEntries(Object.entries(issue).filter(([k, v]) => !(k === 'count' && v === 1))));
      const snapshots = (data.snapshots || []).map((s) => Object.fromEntries(Object.entries({
        phase: s.phase, click: s.click, url: s.url, title: s.title, text: [...(s.text || '')].slice(0, 800).join(''), textLength: s.textLength,
        canvases: s.canvases?.length ? s.canvases : undefined, clickables: s.clickables, screenshot: s.screenshot, error: s.error,
      }).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length))));
      return { site_id: id, title: meta.title || '', version: meta.version ?? 1, ok: data.ok, summary: data.summary, load: data.load, issues, snapshots,
        hint: issues.length ? '按 issues 里的 where（index.html 的行号）和 code 找到出错的代码改掉；SyntaxError 会让整段 <script> 都不执行（按钮全点不动），常见原因是字符串里有没转义的引号。改完用 publish_site 带同一个 site_id 发布，再 check_site 一次确认没有报错。' : '没发现报错。要确认画面对不对，可以用 vision_analyze 看 screenshot。' };
    })),
    tool('phone_call', 'phone', schemas.phone_call, async (args = {}, signal) => {
      signal?.throwIfAborted();
      if (!env.API_SERVER_KEY) return { dialed: false, result: '打电话的服务没连上：当前用户未配置 API_SERVER_KEY' };
      try {
        return await fetchJson(new URL('/api/agent/call', env.CATTUAN_APP_URL || 'http://127.0.0.1:3210'), {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.API_SERVER_KEY}`, ...taskHeaders },
          body: JSON.stringify({ ...args, session_id: String(ctx.sessionId || '') }), timeoutMs: 300_000, signal,
        });
      } catch (e) {
        if (signal?.aborted || e.name === 'AbortError') throw e;
        return { dialed: false, result: e.status ? `打电话的服务出错了（${e.status}）：${(typeof e.body === 'object' ? JSON.stringify(e.body) : String(e.body || e.message)).slice(0, 300)}` : `打电话的服务没连上：${e.message}` };
      }
    }),
  ];
}
