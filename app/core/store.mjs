// 每个人的状态（服务端持久化）：<数据目录>/users/<id>/state.json。聊天、消息、任务、目标、统计都按人分开存。
// 任务、目标上记着 uid（只在内存里），后台流程凭它找回是谁的。SSE 只推给这个人自己开着的页面。
import fs from 'node:fs';
import path from 'node:path';
import { userDir, homeOf, syncHome } from '../homes.mjs';
import { readJson, writeText } from '../tools/common.mjs';

export function createStore({ accounts }) {
  const users = new Map(); // 用户 id → { id, name, role, status, dir, home, state, clients, activity, saveTimer }
  const loaders = []; // 各模块在一个人第一次载入时要做的事（续跑任务、补聊天……）
  const disablers = []; // 账号被停用时要做的事（停掉他正在跑的任务）

  function writeState(u) {
    clearTimeout(u.saveTimer);
    u.saveTimer = null;
    const s = u.state;
    writeText(path.join(u.dir, 'state.json'), JSON.stringify({
      // 每个聊天最多留最近 300 条；任务只留最近 80 个
      messages: s.chats.flatMap((c) => s.messages.filter((m) => m.chatId === c.id).slice(-300)),
      chats: s.chats, currentChat: s.currentChat, stats: s.stats,
      tasks: s.tasks.slice(-80), goals: s.goals,
    }, (k, v) => (k === 'uid' ? undefined : v)));
  }

  const store = {
    users,
    get: (x) => users.get(typeof x === 'string' ? x : x?.uid),
    active: (u) => u?.status !== 'disabled',
    all: () => [...users.values()],
    onLoad(fn) { loaders.push(fn); },
    onDisable(fn) { disablers.push(fn); },

    // 第一次用到时从磁盘读，之后一直是内存里这一份（账号信息变了就跟着更新）
    load(row) {
      const known = users.get(row.id);
      if (known) return Object.assign(known, { name: row.name, role: row.role, status: row.status });
      const dir = userDir(row.id);
      const home = homeOf(row);
      fs.mkdirSync(dir, { recursive: true });
      syncHome(home); // 模板里改过的人设和技能，载入时带上
      const saved = readJson(path.join(dir, 'state.json'), {}) || {};
      const state = { messages: [], tasks: [], goals: [], chats: [], stats: { tasksDone: 0, reports: 0, since: new Date().toISOString() }, ...saved };
      const u = { id: row.id, name: row.name, role: row.role, status: row.status, dir, home, state, clients: new Set(), activity: [], saveTimer: null };
      for (const x of [...state.tasks, ...state.goals]) x.uid = u.id;
      users.set(u.id, u);
      for (const fn of loaders) fn(u);
      store.save(u);
      return u;
    },

    // 先写临时文件再换名，200ms 内的多次改动合成一次写
    save(u) {
      clearTimeout(u.saveTimer);
      u.saveTimer = setTimeout(() => writeState(u), 200);
    },
    flush() { for (const u of users.values()) if (u.saveTimer) writeState(u); },

    broadcast(u, ev) {
      const frame = `data: ${JSON.stringify(ev)}\n\n`;
      for (const res of u.clients) res.write(frame);
    },
    watching: () => [...users.values()].some((u) => u.clients.size > 0),

    // 账号库是 App 和 scripts/user.mjs 共用的：停用的人马上断开他开着的页面；新建的人载进来（他的目标、任务才会跑）
    refresh() {
      const rows = new Map(accounts.listUsers().map((r) => [r.id, r]));
      for (const u of users.values()) {
        if (u.status === 'disabled' || (rows.get(u.id)?.status || 'disabled') !== 'disabled') continue;
        u.status = 'disabled';
        for (const res of u.clients) res.end();
        u.clients.clear();
        for (const fn of disablers) fn(u);
      }
      for (const row of rows.values()) if (row.status !== 'disabled') store.load(row);
    },
  };
  return store;
}
