// 输入区（微信式：有内容显示「发送」，否则显示「+」）。点「+」弹出工具面板：相册、拍摄；图先缩到 1280px 再发。
import { $ } from './util.js';
import { send } from './chat.js';

const input = $('#input');
let pending = []; // 选好还没发的图（data URL）

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
  input.value = ''; pending = []; renderPending(); autosize(); syncComposer();
  input.placeholder = INPUT_PLACEHOLDER;
  send(text, images);
});

export function togglePanel(open = $('#toolPanel').hidden) {
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
    renderPending();
    if (bad) alert(`有 ${bad} 张图打不开（可能是 HEIC 这类浏览器不认的格式），换成 JPG 或 PNG 再试试`);
  });
}
function renderPending() {
  $('#attachments').innerHTML = pending.map((u, i) => `<div class="att"><img src="${u}" alt=""><button type="button" data-i="${i}" aria-label="移除">×</button></div>`).join('');
  syncComposer();
}
$('#attachments').addEventListener('click', (e) => {
  if (e.target.dataset.i == null) return;
  pending.splice(Number(e.target.dataset.i), 1);
  renderPending();
});

// 提问选项卡点「其他」：不在选项里的，直接在输入框里说
export function askInInput(placeholder = '不在选项里的，直接说就行') {
  input.placeholder = placeholder;
  input.focus();
}
