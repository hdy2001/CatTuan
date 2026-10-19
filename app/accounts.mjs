// 账号：用户、登录会话、邀请链接、每日用量，存在 <数据目录>/app.db（Node 自带的 node:sqlite，App 仍然零依赖）。
// 只能邀请，不开放注册：管理员用 scripts/user.mjs 建账号、发一次性邀请链接，同事打开后自己设密码。
// 密码用 scrypt 加盐；登录会话的 token 和邀请码在库里都只存 SHA-256，库泄露了也拿不到能用的 token。
// App 和 scripts/user.mjs 两个进程会同时开这个库：WAL + busy_timeout，互不阻塞。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 << 20 };
const SESSION_DAYS = 30;
const INVITE_DAYS = 7;
export const AGENT_PORT_BASE = 8701; // 每人的 agent 从这里往上排（单用户版的 8650 留给沿用老数据的管理员）
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
      hermes_home TEXT,
      agent_port INTEGER UNIQUE,
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
    CREATE TABLE IF NOT EXISTS invites (
      code_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS usage_daily (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      kind TEXT NOT NULL,
      n INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day, kind)
    );
  `);
  const q = (sql) => db.prepare(sql);
  const USER_COLS = 'id, name, role, status, hermes_home, agent_port, created_at, last_login_at';

  const api = {
    db,
    getUser: (id) => q(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id) || null,
    findUser: (name) => q(`SELECT ${USER_COLS} FROM users WHERE name = ?`).get(String(name || '').trim()) || null,
    listUsers: () => q(`SELECT ${USER_COLS} FROM users ORDER BY created_at`).all(),
    activeUsers: () => q(`SELECT ${USER_COLS} FROM users WHERE status != 'disabled' ORDER BY created_at`).all(),

    nextAgentPort() {
      const row = q('SELECT MAX(agent_port) AS p FROM users WHERE agent_port >= ?').get(AGENT_PORT_BASE);
      return Math.max(AGENT_PORT_BASE, (row?.p || 0) + 1);
    },

    createUser({ name, role = 'member', hermesHome = null, agentPort }) {
      name = String(name || '').trim();
      if (!NAME_RE.test(name)) throw new Error('名字只能用中英文、数字和 _ . -，最多 20 个字');
      if (api.findUser(name)) throw new Error(`已经有叫「${name}」的账号了`);
      const id = `u_${crypto.randomBytes(5).toString('hex')}`;
      q(`INSERT INTO users (id, name, role, status, hermes_home, agent_port, created_at) VALUES (?, ?, ?, 'invited', ?, ?, ?)`)
        .run(id, name, role, hermesHome, agentPort ?? api.nextAgentPort(), isoNow());
      return api.getUser(id);
    },

    update(id, fields) {
      const keys = Object.keys(fields).filter((k) => ['role', 'status', 'hermes_home', 'agent_port'].includes(k));
      if (keys.length) q(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
      if (fields.status === 'disabled') q('DELETE FROM auth_sessions WHERE user_id = ?').run(id); // 停用立刻下线
      return api.getUser(id);
    },

    // 邀请码只在这里出现一次（明文），库里存哈希；同一个人再发一次，之前没用的就作废（用来重置密码）。
    createInvite(userId) {
      const code = crypto.randomBytes(18).toString('base64url');
      q('DELETE FROM invites WHERE user_id = ? AND used_at IS NULL').run(userId);
      q('INSERT INTO invites (code_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(code), userId, isoNow(), inDays(INVITE_DAYS));
      return code;
    },

    peekInvite(code) {
      const row = q(`SELECT u.id, u.name, u.status FROM invites i JOIN users u ON u.id = i.user_id
        WHERE i.code_hash = ? AND i.used_at IS NULL AND i.expires_at > ?`).get(sha256(code), isoNow());
      return row && row.status !== 'disabled' ? row : null;
    },

    // 用邀请链接设密码：激活账号；以前的登录全部作废（重置密码时把别处登着的踢下线）
    async acceptInvite(code, password) {
      const inv = api.peekInvite(code);
      if (!inv) throw new Error('邀请链接无效或已过期，找管理员重新发一个');
      if (String(password || '').length < MIN_PASSWORD) throw new Error(`密码至少 ${MIN_PASSWORD} 位`);
      const hash = await hashPassword(String(password));
      db.exec('BEGIN');
      try {
        q(`UPDATE users SET password_hash = ?, status = 'active' WHERE id = ?`).run(hash, inv.id);
        q('UPDATE invites SET used_at = ? WHERE code_hash = ?').run(isoNow(), sha256(code));
        q('DELETE FROM auth_sessions WHERE user_id = ?').run(inv.id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return api.getUser(inv.id);
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
