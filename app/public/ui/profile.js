// 喵团档案（侧边栏里）：身份证（按二代证正反面的版式比例重画，可翻面）、简历（Deedy 双栏版式，数字来自 /api/profile），
// 和聊天页里来回爬的像素小猫。都是人设和装饰，和业务无关。
import { $, esc } from './util.js';

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

export function openIdCard() {
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
export async function openResume() {
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
