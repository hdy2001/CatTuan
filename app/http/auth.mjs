// 登录：名字 + 密码，登录会话存在账号库（只存 token 的哈希）。
// 网页用 HttpOnly cookie；原生 App 登录时带 "token": true，之后用 Authorization: Bearer。两种查的是同一张会话表。
// 线上走 HTTPS 时 cookie 加 Secure 和 __Host- 前缀：同一主域名下别的子域名没法种一个同名 cookie 来冒充。
import { provision } from '../homes.mjs';
import { readBody, sendJson } from './util.mjs';

const LOCK_MS = 15 * 60_000;

export function createAuth({ accounts, config, onLogin }) {
  const cookieName = config.secure ? '__Host-cattuan' : 'cattuan_sid';
  const cookie = (token, maxAge = 30 * 86400) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.secure ? '; Secure' : ''}`;

  function tokenOf(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || '').trim());
    if (m) return m[1];
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === cookieName) return part.slice(i + 1).trim();
    }
    return '';
  }

  // 真实的客户端 IP：在 Caddy 后面时请求都来自本机，用它加的 X-Forwarded-For（最后一个是 Caddy 看到的地址）
  function clientIp(req) {
    const peer = req.socket.remoteAddress || '';
    const xff = req.headers['x-forwarded-for'];
    return xff && /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(peer) ? String(xff).split(',').at(-1).trim() : peer;
  }

  // 失败限流：同一个名字 15 分钟里错到 10 次、同一个 IP 错到 50 次（办公室出口 IP 是共用的）就先锁 15 分钟；注册同一个 IP 最多 10 个
  const fails = new Map(); // 'ip:…' / 'name:…' / 'reg:…' → { n, at }
  const locked = (keys) => keys.some((k) => { const f = fails.get(k); return f && f.n >= (k.startsWith('ip:') ? 50 : 10) && Date.now() - f.at < LOCK_MS; });
  const failed = (keys) => {
    for (const k of keys) {
      const f = fails.get(k);
      fails.set(k, { n: f && Date.now() - f.at < LOCK_MS ? f.n + 1 : 1, at: Date.now() });
    }
  };
  setInterval(() => { for (const [k, f] of fails) if (Date.now() - f.at > LOCK_MS) fails.delete(k); }, 600_000).unref();

  function startSession(req, res, user, asToken) {
    onLogin(user);
    const token = accounts.createSession(user.id, { ip: clientIp(req), ua: req.headers['user-agent'] });
    if (asToken) return sendJson(res, 200, { ok: true, name: user.name, role: user.role, token });
    res.setHeader('Set-Cookie', cookie(token));
    return sendJson(res, 200, { ok: true, name: user.name });
  }

  async function route(req, res, url) {
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      const { name = '', password = '', token: asToken = false } = await readBody(req);
      const keys = [`ip:${clientIp(req)}`, `name:${String(name).trim().toLowerCase()}`];
      if (locked(keys)) return sendJson(res, 429, { error: '试错太多次了，15 分钟后再试' });
      const user = await accounts.verifyPassword(name, password);
      if (!user) { failed(keys); return sendJson(res, 401, { error: '名字或密码不对' }); }
      for (const k of keys) fails.delete(k);
      return startSession(req, res, user, asToken === true);
    }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      accounts.deleteSession(tokenOf(req));
      res.setHeader('Set-Cookie', cookie('', 0));
      return sendJson(res, 200, { ok: true });
    }
    // 现在是谁：没登录 / 过期了是 401（App 的实时连接断了会来问一下，401 就回登录页）
    if (url.pathname === '/api/auth/me') {
      const me = accounts.sessionUser(tokenOf(req));
      return me ? sendJson(res, 200, { name: me.name, role: me.role }) : sendJson(res, 401, { error: '请先登录' });
    }
    if (url.pathname === '/api/auth/register' && req.method === 'POST' && config.allowRegister) {
      const { name = '', password = '', token: asToken = false } = await readBody(req);
      const keys = [`reg:${clientIp(req)}`];
      if (locked(keys)) return sendJson(res, 429, { error: '注册太频繁了，15 分钟后再试' });
      let user;
      try { user = await accounts.createUser({ name, password }); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      failed(keys);
      provision(user);
      return startSession(req, res, user, asToken === true);
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  return { route, userOf: (req) => accounts.sessionUser(tokenOf(req)) };
}
