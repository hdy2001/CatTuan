// 不带工具的单次模型调用（OpenAI 兼容接口）：只给几处要一次性抽取 JSON 的地方用（目标页一句话建目标、模拟外呼编通话）。
// 聊天和后台任务都走 agent/runtime.mjs 的 Pi 会话。
import { wellFormedJson } from './core/util.mjs';

export function createLlm({ id, url, key }) {
  async function complete({ system, user, maxTokens = 600, json = false }) {
    const call = () => fetch(`${url.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: id, max_tokens: maxTokens, thinking: { type: 'disabled' }, ...(json && { response_format: { type: 'json_object' } }),
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }, wellFormedJson),
      signal: AbortSignal.timeout(60_000),
    });
    // 代理/网络偶尔抖一下会直接 "fetch failed"（连接没建立），隔一秒重试一次
    const r = await call().catch(async (e) => {
      if (e.name === 'TimeoutError') throw e;
      await new Promise((ok) => setTimeout(ok, 1000));
      return call();
    });
    if (!r.ok) throw new Error(`model ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const body = await r.json();
    const text = (body.choices?.[0]?.message?.content || '').trim();
    return json ? parseJsonLoose(text) : text;
  }
  return { complete };
}

// 模型偶尔少写一个收尾的 } 或 ]：先按原样解析，不行就补齐没闭合的括号再试。都不行返回 null。
function parseJsonLoose(raw) {
  const text = String(raw || '');
  const start = text.indexOf('{');
  if (start < 0) return null;
  const body = text.slice(start, text.lastIndexOf('}') + 1) || text.slice(start);
  try { return JSON.parse(body); } catch {}
  const stack = [];
  let inStr = false;
  let esc = false;
  let end = start;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') stack.pop();
    if (!inStr && '}]"0123456789eln'.includes(c)) end = i; // 记住最后一个可能结束值的位置
  }
  try { return JSON.parse(text.slice(start, end + 1) + stack.reverse().join('')); } catch { return null; }
}
