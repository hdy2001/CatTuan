// 账号：用户、登录会话、每日用量，存在 <数据目录>/app.db（Node 自带的 node:sqlite，App 仍然零依赖）。
// 名字 + 密码登录：管理员用 scripts/user.mjs 建账号、改密码；调试时也可以走 App 的 /api/auth/register 注册成员账号。
// 密码用 scrypt 加盐；登录会话的 token 在库里只存 SHA-256，库泄露了也拿不到能用的 token。
// App 和 scripts/user.mjs 两个进程会同时开这个库：WAL + busy_timeout，互不阻塞。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 << 20 };
const SESSION_DAYS = 30;
export const NAME_RE = /^[\p{L}\p{N}_.-]{1,20}$/u; // 登录名：中英文、数字、_ . -，最多 20 个字
export const MIN_PASSWORD = 8;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const isoNow = () => new Date().toISOString();
const inDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString();
export const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD（本地时区，线上 TZ=Asia/Shanghai）

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function checkPassword(password, stored) {
  const [kind, N, r, p, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(password, Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(want, got);
}

export function openAccounts(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'app.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
      status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
      password_hash TEXT,
      agent_home TEXT,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      ip TEXT,
      ua TEXT
    );
    CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id);
    DROP TABLE IF EXISTS invites;
    CREATE TABLE IF NOT EXISTS usage_daily (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      kind TEXT NOT NULL,
      n INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day, kind)
    );
  `);
  const q = (sql) => db.prepare(sql);
  const USER_COLS = 'id, name, role, status, agent_home, created_at, last_login_at';

  const api = {
    db,
    getUser: (id) => q(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id) || null,
    findUser: (name) => q(`SELECT ${USER_COLS} FROM users WHERE name = ?`).get(String(name || '').trim()) || null,
    listUsers: () => q(`SELECT ${USER_COLS} FROM users ORDER BY created_at`).all(),
    activeUsers: () => q(`SELECT ${USER_COLS} FROM users WHERE status != 'disabled' ORDER BY created_at`).all(),

    // 建账号时就设好密码，直接是可以登录的状态（status 里的 'invited' 只剩老库里没设过密码的账号）
    async createUser({ name, password, role = 'member', agentHome = null }) {
      name = String(name || '').trim();
      if (!NAME_RE.test(name)) throw new Error('名字只能用中英文、数字和 _ . -，最多 20 个字');
      if (String(password || '').length < MIN_PASSWORD) throw new Error(`密码至少 ${MIN_PASSWORD} 位`);
      if (api.findUser(name)) throw new Error(`已经有叫「${name}」的账号了`);
      const hash = await hashPassword(String(password));
      const id = `u_${crypto.randomBytes(5).toString('hex')}`;
      q(`INSERT INTO users (id, name, role, status, password_hash, agent_home, created_at) VALUES (?, ?, ?, 'active', ?, ?, ?)`)
        .run(id, name, role, hash, agentHome, isoNow());
      return api.getUser(id);
    },

    update(id, fields) {
      const keys = Object.keys(fields).filter((k) => ['role', 'status', 'agent_home'].includes(k));
      if (keys.length) q(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
      if (fields.status === 'disabled') q('DELETE FROM auth_sessions WHERE user_id = ?').run(id); // 停用立刻下线
      return api.getUser(id);
    },

    // 改密码（管理员重置）：停用的账号保持停用，其余变成可登录；以前的登录全部作废，别处登着的踢下线
    async setPassword(id, password) {
      if (String(password || '').length < MIN_PASSWORD) throw new Error(`密码至少 ${MIN_PASSWORD} 位`);
      const hash = await hashPassword(String(password));
      db.exec('BEGIN');
      try {
        q(`UPDATE users SET password_hash = ?, status = CASE status WHEN 'disabled' THEN 'disabled' ELSE 'active' END WHERE id = ?`).run(hash, id);
        q('DELETE FROM auth_sessions WHERE user_id = ?').run(id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return api.getUser(id);
    },

    async verifyPassword(name, password) {
      const row = q(`SELECT id, password_hash FROM users WHERE name = ? AND status = 'active'`).get(String(name || '').trim());
      // 没这个人也照样算一遍哈希，免得从响应时间看出账号存不存在
      const ok = await checkPassword(String(password || ''), row?.password_hash || 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
      return ok && row ? api.getUser(row.id) : null;
    },

    createSession(userId, { ip = '', ua = '' } = {}) {
      const token = crypto.randomBytes(32).toString('base64url');
      const at = isoNow();
      q('INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at, seen_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(sha256(token), userId, at, inDays(SESSION_DAYS), at, String(ip).slice(0, 64), String(ua).slice(0, 200));
      q('UPDATE users SET last_login_at = ? WHERE id = ?').run(at, userId);
      return token;
    },

    // 带 cookie 的请求 → 是谁（账号停用、会话过期都算没登录）。滑动续期：最多每小时写一次库。
    sessionUser(token) {
      if (!token) return null;
      const h = sha256(token);
      const row = q(`SELECT s.seen_at, u.id FROM auth_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'`).get(h, isoNow());
      if (!row) return null;
      if (Date.now() - Date.parse(row.seen_at) > 3600_000) q('UPDATE auth_sessions SET seen_at = ?, expires_at = ? WHERE token_hash = ?').run(isoNow(), inDays(SESSION_DAYS), h);
      return api.getUser(row.id);
    },

    deleteSession: (token) => token && q('DELETE FROM auth_sessions WHERE token_hash = ?').run(sha256(token)),

    // 每日用量（消息、后台任务、目标检查……），按本地日期算
    usage: (userId, kind) => q('SELECT n FROM usage_daily WHERE user_id = ? AND day = ? AND kind = ?').get(userId, today(), kind)?.n || 0,
    bumpUsage(userId, kind, n = 1) {
      q(`INSERT INTO usage_daily (user_id, day, kind, n) VALUES (?, ?, ?, ?)
        ON CONFLICT (user_id, day, kind) DO UPDATE SET n = n + excluded.n`).run(userId, today(), kind, n);
      return api.usage(userId, kind);
    },
  };
  return api;
}
