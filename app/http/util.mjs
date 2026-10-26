// HTTP 小工具：读请求体、回 JSON、发静态文件、一个按「方法 + 路径模式」分发的路由表。
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json',
};

export const httpError = (status, message) => Object.assign(new Error(message), { status });

// limit：请求体上限。按 Buffer 收齐再解码，免得中文被切在两个 chunk 中间。
export async function readBody(req, limit = 1 << 20) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw httpError(413, '内容太大了');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { throw httpError(400, '请求格式不对'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, '请求格式不对');
  return body;
}

export function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

export function serveFile(res, file, fallback) {
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return fallback ? fallback() : sendJson(res, 404, { error: 'not found' });
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

// 路由表：add('POST', '/api/tasks/:id/:action', handler)。:name 匹配一段 [\w-]，handler(ctx) 里拿 ctx.params。
export function createRouter() {
  const routes = [];
  return {
    add(method, pattern, handler) {
      const keys = [];
      const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([\\w.-]+)'; })}$`);
      routes.push({ method, re, keys, handler });
    },
    // 路径对上但方法不对 → 405；都对不上 → null
    match(method, pathname) {
      let found = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        found = true;
        if (r.method === method || (method === 'HEAD' && r.method === 'GET')) return { handler: r.handler, params: Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]])) };
      }
      return found ? { status: 405 } : null;
    },
  };
}
