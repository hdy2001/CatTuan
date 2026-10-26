// 子 agent 跑一轮：在任务会话 task-<任务 id> 里用 worker profile 跑，工具事件交给任务记成步骤，
// 工具交回的 attachments（附上的图、文档、通话组件）收齐了跟结果一起返回。同一个任务的每一轮都在同一个会话里，后面的修改轮记得前面做过什么。
import { TERMINAL } from './runtime.mjs';
import { taskSession } from './agents.mjs';

export function createWorker({ agents }) {
  const running = new Map(); // 任务 id → { rt, run }

  // → { status: 'completed' | 'failed' | 'cancelled', output, pendingSteer, error, attachments }
  async function run(u, t, input, onEvent = () => {}) {
    let rt, r;
    try {
      rt = await agents.runtimeOf(u);
      r = rt.startRun({ input, sessionId: taskSession(t.id), profile: 'worker' });
    } catch (e) {
      return { status: 'failed', error: e.message, attachments: [] };
    }
    running.set(t.id, { rt, run: r });
    const attachments = [];
    return new Promise((resolve) => {
      const on = (ev) => {
        if (ev.event.startsWith('tool.')) {
          if (ev.event === 'tool.completed' && !ev.error) attachments.push(...(ev.details?.attachments || []));
          onEvent(ev);
        } else if (TERMINAL.has(ev.event)) {
          r.listeners.delete(on);
          running.delete(t.id);
          resolve({ status: ev.event.slice(4), output: ev.output || '', pendingSteer: String(ev.pending_steer || '').trim(), error: ev.error, attachments });
        }
      };
      r.listeners.add(on);
      for (const ev of r.events) { on(ev); if (TERMINAL.has(ev.event)) break; }
    });
  }

  return {
    run,
    // 插话进正在跑的这一轮：收下了返回 true（这一轮已经在收尾就返回 false，由调用方排到下一轮）
    async steer(t, text) {
      const x = running.get(t.id);
      if (!x) return false;
      try { await x.rt.steer(x.run.id, text); return true; } catch { return false; }
    },
    async stop(t) {
      const x = running.get(t.id);
      if (x) await x.rt.stop(x.run.id).catch(() => {});
    },
    isRunning: (t) => running.has(t.id),
  };
}
