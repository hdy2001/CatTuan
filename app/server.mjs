// 喵团 App：Muse 式「主 agent + 子 agent + 目标」。这里只把各模块接起来、起 HTTP 服务。
//   agent/   主 agent（main.mjs，每个聊天一个 Pi 会话）、子 agent（worker.mjs）、共用的 runtime 和工具
//   core/    每个人的状态、聊天、后台任务、目标、额度、浏览器实时画面
//   calls/   打电话（Mock 外呼平台 + 通话记录）
//   http/    登录、接口、上传和图片代理
// 场景上的做法（怎么说话、什么时候派子 agent、怎么打电话、怎么写报告）都在 agent-home 的提示词和技能里。
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { openAccounts } from './accounts.mjs';
import { createLlm } from './llm.mjs';
import { createStore } from './core/store.mjs';
import { createChats } from './core/chats.mjs';
import { createQuota } from './core/quota.mjs';
import { createTasks } from './core/tasks.mjs';
import { createGoals, scheduleLabel } from './core/goals.mjs';
import { createLive } from './core/live.mjs';
import { createCalls } from './calls/calls.mjs';
import { createAgents } from './agent/agents.mjs';
import { createWorker } from './agent/worker.mjs';
import { createMain } from './agent/main.mjs';
import { createContext } from './agent/context.mjs';
import { GOAL_SCHEMA } from './agent/main-tools.mjs';
import { createAuth } from './http/auth.mjs';
import { createRoutes } from './http/routes.mjs';
import { uploadPath } from './http/media.mjs';

export async function startApp({ config = loadConfig() } = {}) {
  const accounts = openAccounts(config.dataDir);
  const store = createStore({ accounts });
  const quota = createQuota({ accounts, limits: config.quota });
  const chats = createChats({ store });
  const llm = createLlm(config.models.main);
  const calls = createCalls({ llm });
  // 给工具用的 App 能力：打电话（记在发起它的任务上）
  const agents = createAgents({ config, services: (u, taskId) => ({
    phone: (args, { progress }) => calls.place(u, u.state.tasks.find((t) => t.id === taskId), args, progress),
  }) });
  const worker = createWorker({ agents });
  let main, goals;

  // 子 agent 做完 → 结果送进派它的那个聊天的主 agent 会话，由主 agent 接着说；目标检查交给目标（有新进展才说）
  function deliver(t) {
    if (t.kind === 'goal') return goals.finished(t);
    const u = store.get(t);
    const chatId = t.chatId || u.state.currentChat;
    if (!u.state.chats.some((c) => c.id === chatId)) return; // 那个聊天删了：结果在「任务」里还能看
    u.state.stats.reports += (t.result?.attachments || []).filter((a) => a.type === 'document').length;
    return main.taskFinished(u, chatId, context.deliveryOf(t));
  }
  const tasks = createTasks({ store, quota, worker, fork: agents.fork, imagePath: uploadPath,
    onFinished: (t) => Promise.resolve().then(() => deliver(t)).catch((e) => console.error('[deliver]', e.message)) });
  const context = createContext({ store, tasks });

  main = createMain({
    agents,
    actions: {
      tasks: (u) => u.state.tasks, goals: (u) => u.state.goals,
      createTask: tasks.create, steerTask: tasks.steer, stopTask: tasks.stop, taskResult: tasks.resultText,
      overQuota: quota.over, goalLimit: quota.goalLimit, scheduleLabel,
      createGoal: (u, g) => goals.create(u, g),
      setGoalDone: (g) => goals.setDone(g, true, '你在聊天里说不用再盯了'),
    },
    context: context.chatContext,
    post: async (u, chatId, items) => { for (const m of await chats.postParts(u, chatId, items)) context.markSaid(m); },
    activity: {
      start: (u, chatId, title) => { const a = chats.activity.start(u, { title, chatId, replyIn: chatId }); chats.activity.step(a, '想想怎么回'); return a; },
      step: chats.activity.step,
      end: chats.activity.end,
    },
    delivered: (t, text) => tasks.noteSaid(t, text),
  });
  goals = createGoals({ store, quota, tasks, agents, llm, goalSchema: GOAL_SCHEMA, deliver: (u, chatId, d) => main.taskFinished(u, chatId, d) });
  const live = createLive({ store, sandboxUrl: config.sandboxUrl });
  const auth = createAuth({ accounts, config, onLogin: (row) => store.load(row) });
  const handle = createRoutes({ config, auth, store, chats, tasks, goals, main, calls, live, quota, agents });

  // 把没停用的账号都载进来：没跑完的任务接着跑、目标接着盯
  for (const row of accounts.activeUsers()) store.load(row);
  if (!accounts.listUsers().length) console.log('还没有账号：node scripts/user.mjs add <名字> --admin');

  const server = http.createServer(handle);
  server.requestTimeout = 0;
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(config.port, config.host, ok); });
  const resumed = store.all().flatMap((u) => u.state.tasks).filter((t) => t.status === 'queued').length;
  console.log(`CatTuan app → ${config.publicOrigin || `http://localhost:${config.port}`}  (${store.users.size} 个账号${resumed ? `，续跑 ${resumed} 个任务` : ''})`);
  live.start();
  goals.start();
  tasks.pump();

  // systemd 重启（每次发版）时：正在跑的任务保持「进行中」（重启后接着做），没落盘的状态写完再退
  async function close() {
    tasks.close();
    goals.stop();
    live.stop();
    server.close();
    for (const u of store.all()) for (const res of u.clients) res.end();
    await agents.close();
    store.flush();
    accounts.db.close();
  }
  return { server, close, config };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const app = await startApp();
  let closing = false;
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      if (closing) return;
      closing = true;
      app.close().catch((e) => console.error(e)).finally(() => process.exit(0));
    });
  }
}
