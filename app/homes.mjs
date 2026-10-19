// 每个用户一个 HERMES_HOME（执行 agent 的主目录）：Hermes 一个主目录里没有「用户」这个维度，记忆每轮都注入
// system prompt、session_search 搜整个会话库、账本 / 关注 / 网站也都在主目录下，所以每人一份，各跑一个 gateway。
//   代码：插件、SOUL.md 软链到仓库的 hermes-home（模板），大家用同一份；agent 没有写文件的工具，改不了它们。
//   喵团技能（skills/cattuan）每人复制一份：agent 会往技能目录里写调研资料（references/），共用就串了。
//   config.yaml 每人一份：技能商店装内置技能时会改它的 skills.disabled。只在没有时从模板复制。
//   .env：自己的 API_SERVER_PORT / API_SERVER_KEY；LongCat key 用模板 .env 里那一份（scripts/start-agent.sh 读）。
// App、用户管理脚本（scripts/user.mjs）、agent 守护进程（scripts/agents.mjs）共用这里的函数。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATE = path.join(ROOT, 'hermes-home');
// 带 Python 依赖的官方插件：装上以后 Hermes 会给每个主目录各建一份托管 Python 环境（几百 MB），多人版先不给用户的 agent 用
const SKIP_PLUGINS = new Set(['langfuse']);

export const dataDir = () => path.resolve(process.env.CATTUAN_DATA_DIR || path.join(ROOT, 'app/data'));
export const userDir = (id) => path.join(dataDir(), 'users', id);
// hermes_home 为空：默认放在这个人的数据目录下；从单用户版升级的管理员沿用仓库的 hermes-home（存相对 ROOT 的路径）
export const homeOf = (user) => (user.hermes_home ? path.resolve(ROOT, user.hermes_home) : path.join(userDir(user.id), 'hermes-home'));

export function readEnvFile(file) {
  try {
    return Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]));
  } catch { return {}; }
}

// 这个人的 agent 在哪、用什么 key（start-agent.sh 和 cattuan-bridge 插件也读同一个 .env）
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
  if (path.resolve(home) === TEMPLATE) return; // 沿用仓库 hermes-home 的就是模板本身
  fs.mkdirSync(path.join(home, 'plugins'), { recursive: true });
  link(path.join(TEMPLATE, 'SOUL.md'), path.join(home, 'SOUL.md'));
  for (const p of fs.readdirSync(path.join(TEMPLATE, 'plugins'), { withFileTypes: true })) {
    if (p.isDirectory() && !p.name.startsWith('.') && !SKIP_PLUGINS.has(p.name)) link(path.join(TEMPLATE, 'plugins', p.name), path.join(home, 'plugins', p.name));
  }
  syncDir(path.join(TEMPLATE, 'skills/cattuan'), path.join(home, 'skills/cattuan'));
  if (!fs.existsSync(path.join(home, 'config.yaml'))) fs.copyFileSync(path.join(TEMPLATE, 'config.yaml'), path.join(home, 'config.yaml'));
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
