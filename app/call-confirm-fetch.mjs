// 测试预加载：拦住调度者对 LongCat 的请求，按脚本回 JSON。其它 fetch 一律不发出去，
// 所以 call_go 派出来的任务打不到执行 agent，也不会拨号。
// 用法：node --import ./call-confirm-fetch.mjs server.mjs
//   CATTUAN_LONGCAT_SCRIPT  规则文件（JSON）
//   CATTUAN_LONGCAT_LOG     每次请求追加一行，测试据此核对提示词里有没有待确认的电话
//   CATTUAN_STUB_AGENT=hang 非 LongCat 的请求一直挂起（界面演示用）；默认立即 599
import fs from 'node:fs';

const scriptPath = process.env.CATTUAN_LONGCAT_SCRIPT;
const logPath = process.env.CATTUAN_LONGCAT_LOG;

function log(row) {
  if (logPath) fs.appendFileSync(logPath, `${JSON.stringify(row)}\n`);
}

globalThis.fetch = async (url, opts = {}) => {
  const href = String(url);
  if (!href.includes('api.longcat.chat')) {
    log({ kind: 'blocked', href: href.slice(0, 160) });
    if (process.env.CATTUAN_STUB_AGENT === 'hang') return new Promise(() => {});
    return new Response('stubbed', { status: 599 });
  }
  let body = {};
  try { body = JSON.parse(opts.body || '{}'); } catch {}
  const system = body.messages?.find((m) => m.role === 'system')?.content || '';
  const user = body.messages?.find((m) => m.role === 'user')?.content || '';
  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  if (system.includes('后台任务刚结束')) {
    const content = JSON.stringify(script.completion || { messages: ['（测试）任务没跑成'] });
    log({ kind: 'completion' });
    return jsonResponse(content);
  }
  const rule = (script.rules || []).find((r) => user.includes(r.match));
  log({
    kind: 'dispatch',
    match: rule?.match || null,
    systemHasCallConfirm: system.includes('call_confirm'),
    systemAsksConfirm: system.includes('现在打吗'),
    pendingInPrompt: user.includes('【待确认的电话】'),
    pendingLine: (user.split('\n').find((line) => line.startsWith('【待确认的电话】')) || '').slice(0, 200),
  });
  if (!rule) return new Response(`no mock for ${user.slice(-180)}`, { status: 500 });
  return jsonResponse(JSON.stringify(rule.json));
};

function jsonResponse(content) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
