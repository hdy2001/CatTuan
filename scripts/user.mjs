#!/usr/bin/env node
// 喵团账号管理（名字 + 密码登录）。线上用 App 的运行用户跑：cd /srv/cattuan && sudo -u cattuan node scripts/user.mjs …
// 密码在终端里输入（不回显）；用管道喂进来时按行读：printf '密码\n密码\n' | node scripts/user.mjs add 小王
//   add <名字> [--admin]      新建账号并设密码
//   passwd <名字>             改密码：旧密码作废，其他地方的登录会下线
//   list                      列出所有账号
//   disable <名字>            停用：立刻下线，他的后台任务和目标停下；数据保留
//   enable <名字>             恢复停用的账号
//   adopt <名字>              从单用户版升级：把本机原来的数据（app/data 里的聊天、任务、目标、上传的图、回放，
//                             以及仓库 agent-home 里 agent 的记忆、会话）归到这个账号下，设成管理员，并设密码。
//                             只在升级时跑一次，跑之前先停掉 App。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { openAccounts } from '../app/accounts.mjs';
import { ROOT, TEMPLATE, dataDir, userDir, provision } from '../app/homes.mjs';

const [cmd, name, ...flags] = process.argv.slice(2);
const acc = openAccounts(dataDir());
const die = (msg) => { console.error(msg); process.exit(1); };
const need = () => acc.findUser(name) || die(`没有叫「${name}」的账号（node scripts/user.mjs list 看看）`);
const listening = (port) => new Promise((ok) => {
  const s = net.connect(port, '127.0.0.1', () => { s.destroy(); ok(true); }).on('error', () => ok(false));
});

// 读一行：终端里不回显（密码），管道里按行读
let piped;
function ask(prompt) {
  if (!process.stdin.isTTY) {
    piped ||= readline.createInterface({ input: process.stdin })[Symbol.asyncIterator]();
    return piped.next().then((r) => r.value ?? '');
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  return new Promise((ok) => {
    let s = '';
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\u0003') { process.stdout.write('\n'); process.exit(130); } // Ctrl+C
        if (c === '\r' || c === '\n') {
          process.stdin.off('data', onData);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write('\n');
          return ok(s);
        }
        s = c === '\u007f' || c === '\b' ? s.slice(0, -1) : s + c;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function askPassword(who) {
  const p = await ask(`给「${who}」设密码（至少 8 位）：`);
  if (p !== (await ask('再输一遍：'))) die('两次输入的密码不一样');
  return p;
}

process.on('uncaughtException', (e) => die(e.message)); // 名字不合规、重名这类：只打印原因，不打堆栈

if (cmd === 'add') {
  if (!name) die('用法：node scripts/user.mjs add <名字> [--admin]');
  if (acc.findUser(name)) die(`已经有叫「${name}」的账号了（改密码用 passwd）`);
  const u = await acc.createUser({ name, password: await askPassword(name), role: flags.includes('--admin') ? 'admin' : 'member' });
  provision(u);
  console.log(`建好了账号「${u.name}」（${u.role === 'admin' ? '管理员' : '成员'}），用名字和密码登录`);
} else if (cmd === 'passwd') {
  if (!name) die('用法：node scripts/user.mjs passwd <名字>');
  const u = need();
  await acc.setPassword(u.id, await askPassword(u.name));
  console.log(`「${u.name}」的密码改好了，其他地方的登录已下线${u.status === 'disabled' ? '（账号仍是停用状态，要用先 enable）' : ''}`);
} else if (cmd === 'list') {
  const rows = acc.listUsers();
  if (!rows.length) console.log('还没有账号。先建管理员：node scripts/user.mjs add <你的名字> --admin');
  for (const u of rows) {
    const st = { invited: '没设密码', active: '正常', disabled: '已停用' }[u.status];
    console.log(`${u.name.padEnd(12)} ${u.role === 'admin' ? '管理员' : '成员  '}  ${st.padEnd(6)}  最近登录 ${u.last_login_at?.slice(0, 16).replace('T', ' ') || '—'}  ${u.id}`);
  }
} else if (cmd === 'disable' || cmd === 'enable') {
  const u = need();
  acc.update(u.id, { status: cmd === 'disable' ? 'disabled' : acc.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(u.id)?.password_hash ? 'active' : 'invited' });
  console.log(cmd === 'disable' ? `「${u.name}」已停用：已下线，半分钟内不再跑他的任务和目标，数据都还在` : `「${u.name}」恢复了`);
} else if (cmd === 'adopt') {
  if (!name) die('用法：node scripts/user.mjs adopt <你的名字>');
  const legacyState = path.join(dataDir(), 'state.json');
  if (!fs.existsSync(legacyState)) die(`没找到单用户版的数据（${legacyState}），不用 adopt：直接 add <名字> --admin`);
  if (await listening(Number(process.env.PORT || 3210))) die('App 还在跑，先停掉（本机：pkill -f "node .*app/server.mjs"）');
  let u = acc.findUser(name);
  if (u && u.agent_home !== 'agent-home') die(`已经有叫「${name}」的账号了，换个名字`);
  if (u && fs.existsSync(path.join(userDir(u.id), 'state.json'))) die(`${userDir(u.id)} 里已经有数据了，不覆盖`);
  const password = await askPassword(name);
  if (u) await acc.setPassword(u.id, password);
  else u = await acc.createUser({ name, password, role: 'admin', agentHome: path.relative(ROOT, TEMPLATE) });
  const dir = userDir(u.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const sub of ['uploads', 'frames']) {
    const from = path.join(dataDir(), sub);
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
    if (fs.existsSync(from)) for (const f of fs.readdirSync(from)) fs.renameSync(path.join(from, f), path.join(dir, sub, f));
  }
  fs.renameSync(legacyState, path.join(dir, 'state.json'));
  provision(u);
  console.log(`原来的聊天、任务、目标、上传的图和回放都归到了「${u.name}」（管理员）下：${dir}`);
  console.log('agent 沿用仓库的 agent-home（记忆、会话都在原地）。再跑一次 node scripts/migrate.mjs 把老数据转成新格式');
  console.log(`用名字「${u.name}」和刚设的密码登录`);
} else {
  const lines = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1);
  console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(cmd ? 1 : 0);
}
process.exit(0); // 用管道喂密码时 stdin 可能还开着，别挂在那儿
