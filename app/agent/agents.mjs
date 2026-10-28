// 每个账号一个 Pi runtime，两种 profile：
//   main   主 agent（聊天里的喵团）：快、回复短；只留一两步能办完的工具（不打电话、不读网页），再加聊天专用工具（main-tools.mjs）
//   worker 子 agent（后台任务、目标检查）：多做几步，工具全套
// 会话都在这个人的 <home>/pi/sessions 下：chat-<聊天 id> / task-<任务 id>。派子 agent 时把聊天会话复制一份当任务会话。
import fs from 'node:fs';
import path from 'node:path';
import { TEMPLATE } from '../homes.mjs';
import { createRuntime, forkSession, sessionDir } from './runtime.mjs';
import { createTools } from './tools.mjs';

export const chatSession = (chatId) => `chat-${chatId}`;
export const taskSession = (taskId) => `task-${taskId}`;
export const taskIdOf = (sessionId) => /^task-(.+)$/.exec(String(sessionId || ''))?.[1] || null;
export const agentDir = (home) => path.join(home, 'pi');

// agent-home 里的提示词文件：这个人的主目录里有就用他的（建号时链到模板），没有用模板。
// SOUL.md 是两种 agent 共用的人设和做事原则；MAIN.md / WORKER.md 是各自的规矩；后面接上记忆和技能列表
function readPrompt(home, name) {
  for (const dir of [home, TEMPLATE]) {
    try { return fs.readFileSync(path.join(dir, name), 'utf8').trim(); } catch {}
  }
  return '';
}

/**
 * config：config.mjs 的配置（models、env）
 * services(u, taskId) → 给工具用的 App 能力（打电话……）
 */
export function createAgents({ config, services = () => ({}), createRuntime: make = createRuntime }) {
  const runtimes = new Map();
  const extensions = { main: [], worker: [] }; // (u, ctx) → 额外的工具（主 agent 的聊天工具）

  function profilesFor(u) {
    const user = { id: u.id, name: u.name, dir: u.dir };
    const toolsFor = (profile, exclude) => async (ctx) => {
      const taskId = taskIdOf(ctx.sessionId);
      const base = await createTools({ home: u.home, user, sessionId: ctx.sessionId, taskId, env: config.env, services: services(u, taskId), signal: ctx.signal }, { exclude });
      const extra = (await Promise.all(extensions[profile].map((fn) => fn(u, ctx)))).flat();
      return { ...base, tools: [...base.tools, ...extra] };
    };
    return {
      main: {
        // 打电话、读网页都要好几步或好几分钟，这段时间主 agent 回不了消息：交给子 agent
        model: config.models.main, tools: toolsFor('main', ['phone', 'web_fetch', 'read_webpage']),
        instructions: (bridge) => [readPrompt(u.home, 'SOUL.md'), readPrompt(u.home, 'MAIN.md'), bridge.systemPrompt].filter(Boolean).join('\n\n'),
      },
      worker: {
        model: config.models.worker, tools: toolsFor('worker', []),
        instructions: (bridge) => [readPrompt(u.home, 'SOUL.md'), readPrompt(u.home, 'WORKER.md'), bridge.systemPrompt].filter(Boolean).join('\n\n'),
      },
    };
  }

  function runtimeOf(u) {
    let p = runtimes.get(u.id);
    if (!p) {
      p = Promise.resolve().then(() => make({ home: u.home, agentDir: agentDir(u.home), profiles: profilesFor(u) }));
      p.catch(() => runtimes.delete(u.id)); // 建失败（比如没配 key）下次再试
      runtimes.set(u.id, p);
    }
    return p;
  }

  return {
    runtimeOf,
    extend(profile, fn) { extensions[profile].push(fn); },
    // 把这个聊天到现在的会话复制成任务会话：子 agent 接着这段对话做事。聊天还没有会话时返回 false
    fork(u, chatId, taskId) {
      return forkSession({ home: u.home, fromDir: sessionDir(agentDir(u.home), chatSession(chatId)), toDir: sessionDir(agentDir(u.home), taskSession(taskId)) });
    },
    dropSession(u, sessionId) { fs.rmSync(sessionDir(agentDir(u.home), sessionId), { recursive: true, force: true }); },
    async close() { await Promise.allSettled([...runtimes.values()].map(async (p) => (await p).close())); },
  };
}
