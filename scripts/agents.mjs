#!/usr/bin/env node
// 执行 agent 守护进程：给每个没停用的账号跑一个 Hermes gateway（各自的 HERMES_HOME、端口和 key，见 app/homes.mjs），
// 挂了自动拉起（一启动就挂的退避 2s、4s … 最多 60s）；账号停用了就把它的 gateway 停掉。
// 每 15 秒对一遍账号库，新邀请的人不用重启就会有 agent。
// 线上由 systemd 的 cattuan-agents 管；本机由 scripts/start.sh 起。收到 SIGTERM / Ctrl+C 时先挨个停掉 gateway 再退出。
// 每个 gateway 的输出在它主目录的 gateway.out。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { openAccounts } from '../app/accounts.mjs';
import { ROOT, dataDir, homeOf, syncHome, ensureAgentEnv } from '../app/homes.mjs';

const START = path.join(ROOT, 'scripts/start-agent.sh');
const PORT = Number(process.env.PORT || 3210);
const acc = openAccounts(dataDir());
const procs = new Map(); // 用户 id → { child, name, home, startedAt, backoff, restartAt, stopping }
let quitting = false;
const log = (msg) => console.log(`[agents ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`);

function start(u) {
  const home = homeOf(u);
  syncHome(home); // 模板里新加的插件、改过的喵团技能，重启 agent 时带上
  const agent = ensureAgentEnv(home, u.agent_port);
  const out = fs.openSync(path.join(home, 'gateway.out'), 'a');
  // 端口和 key 只认这个人主目录的 .env：继承来的 API_SERVER_* 会盖掉它（大家挤到同一个端口上）
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('API_SERVER_')));
  const child = spawn(START, [home], {
    stdio: ['ignore', out, out],
    env: {
      ...inherited, HERMES_HOME: home,
      CATTUAN_APP_URL: process.env.CATTUAN_APP_URL || `http://127.0.0.1:${PORT}`, // cattuan-bridge 把工具调用明细推给 App
      CATTUAN_SITES_URL: process.env.SITES_ORIGIN || process.env.CATTUAN_SITES_URL || 'http://localhost:3211', // publish_site 返回的网址
    },
  });
  fs.closeSync(out);
  const p = procs.get(u.id) || { backoff: 2000 };
  Object.assign(p, { child, name: u.name, home, startedAt: Date.now(), stopping: false });
  procs.set(u.id, p);
  log(`${u.name}：agent 启动（:${agent.port}，pid ${child.pid}）`);
  child.on('exit', (code, sig) => {
    if (p.child !== child) return;
    p.child = null;
    if (p.stopping || quitting) { procs.delete(u.id); return log(`${u.name}：agent 已停`); }
    p.backoff = Date.now() - p.startedAt > 60_000 ? 2000 : Math.min(p.backoff * 2, 60_000);
    p.restartAt = Date.now() + p.backoff;
    log(`${u.name}：agent 退出了（${sig || code}），${Math.round(p.backoff / 1000)} 秒后重启，日志在 ${path.join(home, 'gateway.out')}`);
  });
}

function stop(uid) {
  const p = procs.get(uid);
  if (!p?.child) { procs.delete(uid); return; }
  p.stopping = true;
  const child = p.child;
  child.kill('SIGTERM');
  setTimeout(() => { if (p.child === child) child.kill('SIGKILL'); }, 20_000).unref();
}

function reconcile() {
  if (quitting) return;
  let want;
  try { want = new Map(acc.activeUsers().map((u) => [u.id, u])); } catch (e) { return log(`读账号库失败：${e.message}`); }
  for (const uid of procs.keys()) if (!want.has(uid)) { log(`${procs.get(uid).name}：账号停用了，停掉 agent`); stop(uid); }
  for (const u of want.values()) {
    const p = procs.get(u.id);
    if (p && (p.child || p.stopping || Date.now() < p.restartAt)) continue;
    try { start(u); } catch (e) { log(`${u.name}：agent 起不来：${e.message}`); }
  }
}

function quit(sig) {
  if (quitting) return;
  quitting = true;
  log(`收到 ${sig}，停掉所有 agent…`);
  for (const p of procs.values()) p.child?.kill('SIGTERM');
  const deadline = Date.now() + 25_000;
  const wait = setInterval(() => {
    const left = [...procs.values()].filter((p) => p.child);
    if (!left.length || Date.now() > deadline) {
      for (const p of left) p.child.kill('SIGKILL');
      clearInterval(wait);
      process.exit(0);
    }
  }, 200);
}
process.on('SIGTERM', () => quit('SIGTERM'));
process.on('SIGINT', () => quit('SIGINT'));

const n = acc.activeUsers().length;
log(n ? `${n} 个账号，给每人起一个 agent` : '还没有账号：node scripts/user.mjs invite <名字> --admin（或从单用户版升级：adopt <名字>）');
reconcile();
setInterval(reconcile, 15_000);
