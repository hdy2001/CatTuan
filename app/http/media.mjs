// 上传的图（存在各人自己的 uploads/）和外部图片代理（图墙的大图，补 UA；配了代理时能取被墙的图床）。
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import { Readable } from 'node:stream';
import { isPublicAddress } from '../tools/web.mjs';
import { newId } from '../core/util.mjs';
import { sendJson } from './util.mjs';

const MAX_UPLOAD = 8 << 20; // 单张图最大 8 MB
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export const uploadsDir = (u) => path.join(u.dir, 'uploads');

// data URL → 存成文件，返回 App 里引用它的地址；不是图或太大返回 null
export function saveUpload(u, dataUrl) {
  const m = /^data:image\/[\w+.-]+;base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (!buf.length || buf.length > MAX_UPLOAD) return null;
  const name = `${newId('u')}.jpg`;
  fs.mkdirSync(uploadsDir(u), { recursive: true });
  fs.writeFileSync(path.join(uploadsDir(u), name), buf);
  return `/api/uploads/${name}`;
}

// App 里的上传地址 → 本地文件路径（给 agent 用 vision_analyze 看）
export const uploadPath = (u, src) => path.join(uploadsDir(u), path.basename(src));

// 手动跟重定向，每一跳都查是不是内网 / 本机地址：不然一个公网图片地址重定向一下，就能打到本机的服务。
export async function proxyImage(res, raw) {
  let url;
  try { url = new URL(raw); } catch { return sendJson(res, 400, { error: 'bad url' }); }
  let upstream;
  for (let hop = 0; ; hop++) {
    if (!['http:', 'https:'].includes(url.protocol)) return sendJson(res, 400, { error: 'bad url' });
    const addresses = await dns.lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true }).catch(() => []);
    if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) return sendJson(res, 403, { error: 'forbidden' });
    upstream = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'image/*' }, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    const next = upstream.status >= 300 && upstream.status < 400 && upstream.headers.get('location');
    if (!next) break;
    upstream.body?.cancel().catch(() => {});
    if (hop >= 4) return sendJson(res, 502, { error: 'too many redirects' });
    url = new URL(next, url);
  }
  const type = upstream.headers.get('content-type') || '';
  if (!upstream.ok || !type.startsWith('image/')) return sendJson(res, 502, { error: `upstream ${upstream.status}` });
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' });
  Readable.fromWeb(upstream.body).pipe(res);
}
