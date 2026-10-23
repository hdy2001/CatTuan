// 每个账号一个 Pi agent 数据目录；业务工具原生运行于 Node.js。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readEnv } from './tools/common.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATE = path.join(ROOT, 'agent-home');

export const dataDir = () => path.resolve(process.env.CATTUAN_DATA_DIR || path.join(ROOT, 'app/data'));
export const userDir = (id) => path.join(dataDir(), 'users', id);
// agent_home 为空：默认放在这个人的数据目录下；从单用户版升级的管理员沿用仓库的 agent-home（存相对 ROOT 的路径）
export const homeOf = (user) => (user.agent_home ? path.resolve(ROOT, user.agent_home) : path.join(userDir(user.id), 'agent-home'));

export const readEnvFile = readEnv;

// 这个人的 agent 在哪、用什么 key（start-agent.sh 也读同一个 .env）
export function agentOf(home) {
  const env = readEnvFile(path.join(home, '.env'));
  return env.API_SERVER_KEY ? { url: `http://127.0.0.1:${env.API_SERVER_PORT || 8642}`, key: env.API_SERVER_KEY, port: Number(env.API_SERVER_PORT || 8642) } : null;
}

// 软链：已经指对了就不动；指错了重建；那里是真文件 / 真目录就不碰（readlink 报 EINVAL）
function link(target, at) {
  try {
    if (fs.readlinkSync(at) === target) return;
    fs.unlinkSync(at);
  } catch (e) {
    if (e.code !== 'ENOENT') return;
  }
  fs.symlinkSync(target, at);
}

// 把模板里的文件复制过来：没有或模板更新过才复制；跳过 references/（模板里那份是管理员自己的调研资料），不删对方多出来的文件
function syncDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'references') continue;
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) { syncDir(from, to); continue; }
    if (!e.isFile()) continue;
    const s = fs.statSync(from);
    let d = null;
    try { d = fs.statSync(to); } catch {}
    if (!d || s.mtimeMs > d.mtimeMs) {
      fs.copyFileSync(from, to);
      fs.utimesSync(to, s.atime, s.mtime);
    }
  }
}

// 建好 / 补齐一个人的主目录：可以反复调，只补缺的、修坏的软链、同步技能，不动运行时数据。
export function syncHome(home) {
  if (path.resolve(home) === TEMPLATE) return; // 沿用仓库 agent-home 的就是模板本身
  fs.mkdirSync(home, { recursive: true });
  link(path.join(TEMPLATE, 'SOUL.md'), path.join(home, 'SOUL.md'));
  syncDir(path.join(TEMPLATE, 'skills/cattuan'), path.join(home, 'skills/cattuan'));
  if (!fs.existsSync(path.join(home, 'config.yaml'))) fs.copyFileSync(path.join(TEMPLATE, 'config.yaml'), path.join(home, 'config.yaml'));
}

// 新账号的主目录建账号时就建好：agent 守护进程几秒内就会把他的 agent 拉起来，等他登录时已经热了
export function provision(user) {
  const home = homeOf(user);
  syncHome(home);
  ensureAgentEnv(home, user.agent_port);
  fs.mkdirSync(path.join(userDir(user.id), 'uploads'), { recursive: true });
}

// 第一次给这个人分配 agent 的端口和 key（已经有了就沿用）
export function ensureAgentEnv(home, port) {
  const file = path.join(home, '.env');
  const env = readEnvFile(file);
  if (env.API_SERVER_KEY) return agentOf(home);
  fs.mkdirSync(home, { recursive: true });
  const lines = [`API_SERVER_ENABLED=true`, `API_SERVER_HOST=127.0.0.1`, `API_SERVER_PORT=${port}`, `API_SERVER_KEY=${crypto.randomBytes(16).toString('hex')}`];
  fs.appendFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return agentOf(home);
}
