// 浏览器实时画面：订阅沙箱的 /live，按工具请求带的任务编号推给任务的主人；每个任务存最多 16 张关键帧做回放。
// 沙箱大家共用：没带任务编号的操作（主 agent 自己搜、调试）不记，宁可不显示也不把别人的画面挂到你的任务上。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readSSE } from './util.mjs';

const MAX_KEYFRAMES = 16;

export function createLive({ store, sandboxUrl }) {
  const framesDir = (u, taskId) => path.join(u.dir, 'frames', taskId);
  const setFrames = (on) => fetch(`${sandboxUrl}/live/frames?on=${on ? 1 : 0}`).catch(() => {});

  function findTask(id) {
    if (!id) return null;
    for (const u of store.users.values()) {
      const t = u.state.tasks.find((x) => x.id === id);
      if (t) return t;
    }
    return null;
  }

  function onEvent(ev) {
    const t = findTask(ev.task);
    if (!t) return;
    const u = store.get(t);
    const b = (t.browser ||= { actions: [], frames: [], active: false });
    const at = new Date(ev.at || Date.now()).toISOString();
    if (ev.type === 'start' || ev.type === 'action') {
      if (ev.type === 'start') b.active = true;
      b.actions = [...b.actions, { at, text: ev.text }].slice(-60);
      store.save(u);
      store.broadcast(u, { type: 'browser', taskId: t.id, active: b.active, action: b.actions.at(-1) });
    } else if (ev.type === 'end') {
      b.active = false;
      store.save(u);
      store.broadcast(u, { type: 'browser', taskId: t.id, active: false });
    } else if (ev.type === 'frame' && ev.data) {
      if (ev.key) {
        const dir = framesDir(u, t.id);
        fs.mkdirSync(dir, { recursive: true });
        const name = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}.jpg`;
        fs.writeFileSync(path.join(dir, name), Buffer.from(ev.data, 'base64'));
        b.frames.push({ at, text: ev.text, url: ev.url, src: `/api/frames/${t.id}/${name}` });
        for (const old of b.frames.splice(0, Math.max(0, b.frames.length - MAX_KEYFRAMES))) fs.rmSync(path.join(dir, path.basename(old.src)), { force: true });
        store.save(u);
      }
      if (u.clients.size) store.broadcast(u, { type: 'browser-frame', taskId: t.id, url: ev.url, key: !!ev.key, data: ev.data });
    }
  }

  let stopped = false;
  async function connect() {
    try {
      const res = await fetch(`${sandboxUrl}/live`);
      if (!res.ok) throw new Error(`live ${res.status}`);
      setFrames(store.watching());
      for await (const ev of readSSE(res.body)) onEvent(ev);
    } catch {}
    if (!stopped) setTimeout(connect, 3_000).unref(); // 沙箱重启或还没起来：过几秒再连
  }

  // 清掉已经不在任务列表里的回放帧
  store.onLoad((u) => {
    const keep = new Set(u.state.tasks.map((t) => t.id));
    try { for (const d of fs.readdirSync(path.join(u.dir, 'frames'))) if (!keep.has(d)) fs.rmSync(path.join(u.dir, 'frames', d), { recursive: true, force: true }); } catch {}
  });

  return {
    start: connect,
    stop() { stopped = true; },
    // 有人打开 / 关掉 App：让沙箱推不推连续画面（没人看时只记步骤和关键帧）
    viewersChanged: () => setFrames(store.watching()),
    frameFile: (u, taskId, name) => path.join(framesDir(u, taskId), path.basename(name)),
  };
}
