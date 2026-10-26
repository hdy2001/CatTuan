#!/usr/bin/env node
// 把老版本的数据转成现在的格式（见 app/core/migrate.mjs）。可以重复跑：已经迁移过的原样跳过，不覆盖已经存在的目标。
// 跑之前先停掉 App（本机 pkill -f "node .*app/server.mjs"，线上 systemctl stop cattuan-app），跑之前会先打一个备份包。
//   node scripts/migrate.mjs            迁移
//   node scripts/migrate.mjs --dry-run  只看要改什么，不动文件
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openAccounts } from '../app/accounts.mjs';
import { TEMPLATE, dataDir, userDir, homeOf, syncHome } from '../app/homes.mjs';
import { readJson, writeText, readConfig, writeConfig } from '../app/tools/common.mjs';
import { newId } from '../app/core/util.mjs';
import { migrateState, migrateConfig, migrateEnv } from '../app/core/migrate.mjs';

const dry = process.argv.includes('--dry-run');
const die = (msg) => { console.error(msg); process.exit(1); };
const listening = (port) => new Promise((ok) => {
  const s = net.connect(port, '127.0.0.1', () => { s.destroy(); ok(true); }).on('error', () => ok(false));
});

const DATA = dataDir();
if (!fs.existsSync(path.join(DATA, 'app.db'))) die(`没有找到账号库（${path.join(DATA, 'app.db')}），不用迁移`);
if (fs.existsSync(path.join(DATA, 'state.json'))) die('还有单用户版的数据：先 node scripts/user.mjs adopt <你的名字>');
if (await listening(Number(process.env.PORT || 3210))) die('App 还在跑，先停掉再迁移');

const acc = openAccounts(DATA);
const users = acc.listUsers();
const homes = [...new Set(users.map(homeOf))];

// 备份：数据目录（不含以前的备份）和各人的 agent 主目录（在数据目录外的，比如沿用仓库 agent-home 的管理员）
if (!dry) {
  const backups = path.join(DATA, 'backups');
  fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
  const file = path.join(backups, `migrate-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`);
  const outside = homes.filter((h) => !h.startsWith(DATA + path.sep) && fs.existsSync(h));
  const r = spawnSync('tar', ['-czf', file, '--exclude=./backups', '-C', DATA, '.', ...outside.flatMap((h) => ['-C', path.dirname(h), path.basename(h)])], { stdio: 'inherit' });
  if (r.status !== 0) die('备份失败，没有迁移');
  console.log(`备份好了：${file}`);
}

const done = [];
const write = (file, text, what) => { done.push(what); if (!dry) writeText(file, text); };

for (const u of users) {
  const dir = userDir(u.id);
  const home = homeOf(u);
  // state.json
  const stateFile = path.join(dir, 'state.json');
  const state = readJson(stateFile, null);
  if (state) {
    const { state: next, changed } = migrateState(state, { calls: readJson(path.join(dir, 'calls.json'), []) || [], newId: () => newId('c') });
    if (changed) write(stateFile, JSON.stringify(next), `${u.name}：聊天、任务、目标转成新格式`);
  }
  // 主 agent 的会话：users/<id>/pi-chat/sessions/* → <home>/pi/sessions/*（目录名是会话 id 的哈希，聊天和任务不会撞）
  const oldSessions = path.join(dir, 'pi-chat', 'sessions');
  if (fs.existsSync(oldSessions)) {
    const target = path.join(home, 'pi', 'sessions');
    for (const name of fs.readdirSync(oldSessions)) {
      if (fs.existsSync(path.join(target, name))) { console.warn(`${u.name}：${name} 在新位置已经有了，跳过`); continue; }
      done.push(`${u.name}：聊天会话 ${name.slice(0, 8)} 挪到 agent 主目录`);
      if (!dry) { fs.mkdirSync(target, { recursive: true, mode: 0o700 }); fs.renameSync(path.join(oldSessions, name), path.join(target, name)); }
    }
    if (!dry && !fs.readdirSync(oldSessions).length) fs.rmSync(path.join(dir, 'pi-chat'), { recursive: true, force: true });
  }
}

for (const home of homes) {
  if (!fs.existsSync(home)) continue;
  if (fs.existsSync(path.join(home, 'config.yaml')) && path.resolve(home) !== TEMPLATE) { // 模板的 config.yaml 在仓库里，已经是新的
    const { config, changed } = migrateConfig(readConfig(home));
    if (changed) { done.push(`${home}：config.yaml 换成新的工具开关键名`); if (!dry) writeConfig(home, config); }
  }
  const envFile = path.join(home, '.env');
  if (fs.existsSync(envFile)) {
    const { text, changed } = migrateEnv(fs.readFileSync(envFile, 'utf8'));
    if (changed) {
      if (text.trim()) write(envFile, text, `${home}：.env 去掉 gateway 的端口和 key`);
      else { done.push(`${home}：删掉只剩 gateway 端口和 key 的 .env`); if (!dry) fs.rmSync(envFile); }
    }
  }
  if (!dry) syncHome(home); // 链上新加的提示词文件（MAIN.md、WORKER.md）
}

console.log(done.length ? `${dry ? '要改' : '改了'}：\n- ${done.join('\n- ')}` : '都已经是新格式，不用改');
process.exit(0);
