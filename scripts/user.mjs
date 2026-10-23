#!/usr/bin/env node
// 喵团账号管理（只能邀请，不开放注册）。线上用 App 的运行用户跑：cd /srv/cattuan && sudo -u cattuan node scripts/user.mjs …
//   invite <名字> [--admin]   新建账号，打印邀请链接（7 天有效，打开后自己设密码）；账号已存在就重发一个（= 重置密码）
//   list                      列出所有账号
//   disable <名字>            停用：立刻下线，他的 agent 也会停掉；数据保留
//   enable <名字>             恢复停用的账号
//   adopt <名字>              从单用户版升级：把本机原来的数据（app/data 里的聊天、任务、目标、上传的图、回放，
//                             以及仓库 agent-home 里 agent 的记忆、会话）归到这个账号下，设成管理员。
//                             只在升级时跑一次，跑之前先停掉 App 和 agent。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { openAccounts } from '../app/accounts.mjs';
import { ROOT, TEMPLATE, dataDir, userDir, homeOf, readEnvFile, syncHome, ensureAgentEnv, agentOf } from '../app/homes.mjs';

// 线上的配置在 /etc/cattuan/cattuan.env（systemd 读）；手动跑脚本时环境里没有，补读一下
for (const [k, v] of Object.entries(readEnvFile('/etc/cattuan/cattuan.env'))) process.env[k] ??= v;
const ORIGIN = (process.env.PUBLIC_ORIGIN || `http://localhost:${process.env.PORT || 3210}`).replace(/\/+$/, '');

const [cmd, name, ...flags] = process.argv.slice(2);
const acc = openAccounts(dataDir());
const die = (msg) => { console.error(msg); process.exit(1); };
const need = () => acc.findUser(name) || die(`没有叫「${name}」的账号（node scripts/user.mjs list 看看）`);
const inviteLink = (u) => `${ORIGIN}/login#invite=${acc.createInvite(u.id)}`;
const listening = (port) => new Promise((ok) => {
  const s = net.connect(port, '127.0.0.1', () => { s.destroy(); ok(true); }).on('error', () => ok(false));
});

// 新账号的主目录现在就建好：agent 守护进程几秒内就会把他的 agent 拉起来，等他打开链接时已经热了
function provision(u) {
  const home = homeOf(u);
  syncHome(home);
  ensureAgentEnv(home, u.agent_port);
  fs.mkdirSync(path.join(userDir(u.id), 'uploads'), { recursive: true });
}

process.on('uncaughtException', (e) => die(e.message)); // 名字不合规、重名这类：只打印原因，不打堆栈

if (cmd === 'invite') {
  if (!name) die('用法：node scripts/user.mjs invite <名字> [--admin]');
  let u = acc.findUser(name);
  if (u?.status === 'disabled') die(`「${u.name}」已停用，先 enable`);
  if (!u) {
    u = acc.createUser({ name, role: flags.includes('--admin') ? 'admin' : 'member' });
    provision(u);
    console.log(`建好了账号「${u.name}」（${u.role === 'admin' ? '管理员' : '成员'}，agent 端口 ${u.agent_port}）`);
  } else if (flags.includes('--admin') && u.role !== 'admin') {
    u = acc.update(u.id, { role: 'admin' });
    console.log(`「${u.name}」改成了管理员`);
  }
  console.log(`\n把这个链接发给 ${u.name}（7 天内有效，只能用一次${u.status === 'active' ? '；用了以后旧密码作废、其他地方的登录会下线' : ''}）：\n\n  ${inviteLink(u)}\n`);
} else if (cmd === 'list') {
  const rows = acc.listUsers();
  if (!rows.length) console.log('还没有账号。先建管理员：node scripts/user.mjs invite <你的名字> --admin');
  for (const u of rows) {
    const st = { invited: '待接受邀请', active: '正常', disabled: '已停用' }[u.status];
    console.log(`${u.name.padEnd(12)} ${u.role === 'admin' ? '管理员' : '成员  '}  ${st.padEnd(6)}  agent :${agentOf(homeOf(u))?.port || u.agent_port}  最近登录 ${u.last_login_at?.slice(0, 16).replace('T', ' ') || '—'}  ${u.id}`);
  }
} else if (cmd === 'disable' || cmd === 'enable') {
  const u = need();
  acc.update(u.id, { status: cmd === 'disable' ? 'disabled' : acc.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(u.id)?.password_hash ? 'active' : 'invited' });
  console.log(cmd === 'disable' ? `「${u.name}」已停用：已下线，agent 会在半分钟内停掉，数据都还在` : `「${u.name}」恢复了`);
} else if (cmd === 'adopt') {
  if (!name) die('用法：node scripts/user.mjs adopt <你的名字>');
  const legacyState = path.join(dataDir(), 'state.json');
  if (!fs.existsSync(legacyState)) die(`没找到单用户版的数据（${legacyState}），不用 adopt：直接 invite <名字> --admin`);
  const legacy = readEnvFile(path.join(TEMPLATE, '.env'));
  const port = Number(legacy.API_SERVER_PORT || 8650);
  if (await listening(Number(process.env.PORT || 3210))) die('App 还在跑，先停掉（本机：pkill -f "node .*app/server.mjs"）');
  if (await listening(port)) die(`agent 还在跑（:${port}），先停掉（本机：pkill -f "node .*app/pi-gateway.mjs"）`);
  let u = acc.findUser(name);
  if (u && u.agent_home !== 'agent-home') die(`已经有叫「${name}」的账号了，换个名字`);
  u ||= acc.createUser({ name, role: 'admin', agentHome: path.relative(ROOT, TEMPLATE), agentPort: port });
  const dir = userDir(u.id);
  if (fs.existsSync(path.join(dir, 'state.json'))) die(`${dir} 里已经有数据了，不覆盖`);
  fs.mkdirSync(dir, { recursive: true });
  for (const sub of ['uploads', 'frames']) {
    const from = path.join(dataDir(), sub);
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
    if (fs.existsSync(from)) for (const f of fs.readdirSync(from)) fs.renameSync(path.join(from, f), path.join(dir, sub, f));
  }
  fs.renameSync(legacyState, path.join(dir, 'state.json'));
  if (!legacy.API_SERVER_KEY) ensureAgentEnv(TEMPLATE, port);
  console.log(`原来的聊天、任务、目标、上传的图和回放都归到了「${u.name}」（管理员）下：${dir}`);
  console.log(`agent 沿用仓库的 agent-home（记忆、会话都在原地），端口 :${port}`);
  console.log(`\n打开这个链接设密码（7 天内有效）：\n\n  ${inviteLink(u)}\n`);
} else {
  const lines = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1);
  console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(cmd ? 1 : 0);
}
