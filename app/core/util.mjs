// App 里到处用的小函数：id、时间、截断、SSE 读取。
import crypto from 'node:crypto';

export const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
export const isoNow = () => new Date().toISOString();
export const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));
// JS 的 .slice() 按 UTF-16 截，可能把 emoji 切成半个；发给模型或存盘前换掉孤立代理项
export const wellFormed = (s) => String(s ?? '').toWellFormed();
export const wellFormedJson = (_key, v) => (typeof v === 'string' ? v.toWellFormed() : v);

// 压成一行再截到 n 个字；clipLines 保留换行
export const clip = (s, n) => { const x = String(s ?? '').replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n)}…` : x; };
export const clipLines = (s, n) => clip(String(s ?? '').replace(/\s*\n\s*/g, '\u0001'), n).replace(/\u0001/g, '\n');
export const hostOf = (url) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return clip(url, 40); } };

export const hhmm = (iso) => new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
// 给模型看的「现在」：要带年月日，模型才知道自己的知识可能过时、算得出「明早」是哪天
export const nowText = (d = new Date()) => d.toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
export function agoText(ms) {
  const m = Math.round(ms / 60_000);
  return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`;
}

// 读 SSE 响应体：逐个产出 data 行拼起来的 JSON
export async function* readSSE(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      buf = buf.slice(i + 2);
      if (data) { try { yield JSON.parse(data); } catch { /* 不是 JSON 的心跳 */ } }
    }
  }
}
