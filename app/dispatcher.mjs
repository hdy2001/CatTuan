// 主 agent（聊天里的喵团，仿 Muse 的 main agent）：每个聊天一个 Pi 会话 chat-<聊天 id>，在 App 进程里跑。
// 它自己干活（workTools：和子 agent 同一套搜索、读网页、搜图、看图、记忆……工具，只是不打电话），再加 dispatcher-tools.mjs 的
// 聊天专用工具。复杂的事（打电话、深度调研、要好几分钟的）用 subagent 工具派子 agent：子 agent 是它的分身，带着这个会话的拷贝，
// 在后台执行 agent 里跑。跨轮的上下文由 Pi 会话自己记着（会自动压缩）。
//
// 一个聊天同时只跑一轮：
//   - 这一轮还在跑时又来一条消息（或一个任务结果）→ 插话进这一轮（Pi steer），连发的几条合成一次回复，不会各派各的任务；
//   - 这一轮已经在收尾、收不了插话 → 排队，这一轮结束后合起来再跑一轮；插话没赶上（pending_steer）的也接着跑一轮。
// 回复：模型每说完一段话（message.completed）就发出去。同一段话后面跟着要挂东西的工具（派子 agent、提问卡）时，等工具做完再发，
// 好把任务 id、提问卡这些挂在这条回复上；跟着的是干活的工具就先把「我查查」发出去。
// 子 agent 的结果也送进同一个会话，由它接着说（卡片、图、通话组件由 App 挂在它的回复后面）。

import { createDispatcherTools } from './dispatcher-tools.mjs';

const TERMINAL = new Set(['run.completed', 'run.failed', 'run.cancelled']);
const ATTACH = new Set(['subagent', 'confirm_call', 'steer_task', 'stop_task', 'ask_user', 'create_goal']); // 结果要挂在这段话上的工具
const FALLBACK = '我这边网络有点卡，等下再说一次？';
// JS 的 .slice() 可能把 emoji 切成半个；发给模型前清掉孤立代理项
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const clean = (s) => String(s ?? '').replace(LONE_SURROGATE, '');

const newTurn = () => ({ userText: '', users: 0, attach: {}, search: null, did: [],
  spoke: false, posted: false, buffer: [], waitTools: 0, deliveries: [], firstText: '' });

/**
 * createRuntime(u, createPiTools) → Promise<Pi runtime>（pi-runtime.mjs，emitMessages 打开）
 * workTools({ home, sessionId, signal, env }) → { systemPrompt, tools, close }：主 agent 干活的工具（pi-tools.mjs 那套，这里去掉打电话）
 * actions：dispatcher-tools 用的 App 函数
 * context(u, chatId) → 每轮开头的状态块（时间、目标、任务、新增的消息）
 * post(u, chatId, items) → 依次发消息；activity.start/step/end → 顶栏状态；stepLabel(tool, args) → 那一步怎么写
 * delivered(task, text) → 记下转述了什么
 */
export function createDispatcher({ createRuntime, workTools = async () => ({ systemPrompt: '', tools: [], close() {} }), actions, context, post, activity,
  stepLabel = (name) => name, delivered = () => {}, log = console.error }) {
  const chats = new Map();
  const runtimes = new Map();
  const key = (u, chatId) => `${u.id}/${chatId}`;
  const chatOf = (u, chatId) => {
    const k = key(u, chatId);
    if (!chats.has(k)) chats.set(k, { run: null, turn: null, busy: false, queue: [], chain: Promise.resolve() });
    return chats.get(k);
  };

  function runtimeOf(u) {
    let p = runtimes.get(u.id);
    if (!p) {
      p = Promise.resolve().then(() => createRuntime(u, async (ctx) => {
        const chatId = String(ctx.sessionId).replace(/^chat-/, '');
        const turn = chats.get(key(u, chatId))?.turn || newTurn();
        const work = await workTools(ctx);
        const tools = work.tools.filter((t) => t.name !== 'phone_call'); // 电话交给子 agent 打：打的那几分钟主 agent 回不了消息
        return { systemPrompt: work.systemPrompt, tools: [...tools, ...createDispatcherTools({ u, chatId, turn, actions })], close: () => work.close() };
      }));
      p.catch(() => runtimes.delete(u.id)); // 建失败（比如没配 key）下次再试
      runtimes.set(u.id, p);
    }
    return p;
  }

  // images：上传图片的本地路径，主 agent 用 vision_analyze 看（子 agent 复制会话后也看得到这些路径）
  const bodyOf = (e) => clean(e.kind === 'user'
    ? `【用户】${e.text || '（只发了图）'}${e.images?.length ? `\n（附带 ${e.images.length} 张图片，用 vision_analyze 看，image_url 填路径：\n${e.images.join('\n')}）` : ''}`
    : e.kind === 'delivery' ? e.delivery.input : e.body);

  function absorb(turn, e, steered = false) {
    if (e.kind === 'user') { turn.users++; turn.userText = [turn.userText, e.text].filter(Boolean).join('\n').slice(0, 300); }
    if (e.kind === 'delivery') turn.deliveries.push({ ...e.delivery, steered });
    for (const d of e.deliveries || []) turn.deliveries.push(d);
  }

  async function submit(u, chatId, entry) {
    const c = chatOf(u, chatId);
    if (c.run?.status === 'running' && c.run.acceptingInput) {
      try {
        const rt = await runtimeOf(u);
        await rt.steer(c.run.id, bodyOf(entry));
        absorb(c.turn, entry, true);
        return;
      } catch { /* 这一轮刚好收尾了：排队 */ }
    }
    if (c.busy) { c.queue.push(entry); return; }
    start(u, chatId, [entry]);
  }

  async function start(u, chatId, entries) {
    const c = chatOf(u, chatId);
    c.busy = true;
    const turn = newTurn();
    entries.forEach((e) => absorb(turn, e));
    c.turn = turn;
    const first = entries.find((e) => e.kind === 'user');
    turn.act = activity.start(u, chatId, first ? first.text || `看你发的 ${first.images?.length || 0} 张图` : entries[0].delivery?.title || '接着聊');
    let end;
    try {
      const rt = await runtimeOf(u);
      const run = rt.startRun({ input: clean(`${context(u, chatId)}\n\n${entries.map(bodyOf).join('\n\n')}`), session_id: `chat-${chatId}` });
      c.run = run;
      end = await follow(u, chatId, turn, run);
    } catch (e) {
      end = { event: 'run.failed', error: e.message };
    }
    if (end.event === 'run.failed') log('[dispatcher]', end.error);
    c.run = null;
    const carry = await finish(u, chatId, turn, end).catch((e) => { log('[dispatcher]', e.message); return []; });
    c.busy = false;
    const next = [...carry, ...c.queue.splice(0)];
    if (next.length && chats.get(key(u, chatId)) === c) start(u, chatId, next);
  }

  function follow(u, chatId, turn, run) {
    return new Promise((resolve) => {
      const on = (ev) => {
        if (ev.event === 'message.completed') {
          if (ev.text) { turn.spoke = true; turn.buffer.push(ev.text); }
          turn.waitTools = ev.tool_calls || 0;
          if (!turn.waitTools) flush(u, chatId, turn);
        } else if (ev.event === 'tool.started') {
          activity.step(turn.act, stepLabel(ev.tool, ev.args || {}));
          if (!ATTACH.has(ev.tool)) flush(u, chatId, turn);
        } else if (ev.event === 'tool.completed') {
          if (ev.tool === 'deep_web_search') noteSearch(turn, ev);
          if (--turn.waitTools <= 0) flush(u, chatId, turn);
        } else if (TERMINAL.has(ev.event)) {
          run.listeners.delete(on);
          resolve(ev);
        }
      };
      run.listeners.add(on);
      for (const ev of run.events) { on(ev); if (TERMINAL.has(ev.event)) break; }
    });
  }

  // 搜过什么、前几条来源：挂在这一轮的回复下面
  function noteSearch(turn, ev) {
    let out;
    try { out = JSON.parse(ev.result); } catch { return; }
    if (!Array.isArray(out?.results)) return;
    turn.search ||= { queries: [], sources: [] };
    turn.search.queries.push(String(out.query || ev.args?.query || ''));
    turn.search.sources.push(...out.results.slice(0, 5).map(({ title, url }) => ({ title, url })));
    turn.did.push(`搜了「${out.query || ev.args?.query || ''}」`);
  }

  // 把攒下的话发出去，挂上这一轮办事工具留下的东西；final：这一轮结束了，没发的任务结果也一起发（模型没提就用兜底的一句）
  function flush(u, chatId, turn, final = false) {
    const parts = turn.buffer.splice(0).flatMap((s) => s.split(/\n{2,}/)).map((s) => s.trim()).filter(Boolean).slice(0, 4);
    const ready = turn.deliveries.filter((d) => !d.posted);
    const pending = Object.keys(turn.attach).length > 0;
    if (!parts.length && !(final && (ready.length || pending))) return;
    if (!parts.length && pending && !ready.length) parts.push('好嘞～');
    turn.firstText ||= parts[0] || '';
    const items = [];
    let texts = parts.map((text) => ({ text, ...(turn.search && { search: turn.search }) }));
    if (texts.length) Object.assign(texts.at(-1), turn.attach);
    else if (pending && ready.length) Object.assign(ready[0].last, turn.attach); // 任务卡片那条带上
    turn.attach = {};
    if (turn.search && texts.length) turn.search = null;
    // 任务结果：第一份用模型这段话，后面的（几个任务同时做完）各用自己的兜底一句
    for (const d of (texts.length || final ? ready : [])) {
      d.posted = true;
      const group = texts.length ? texts : [{ text: d.fallback }];
      texts = [];
      group.forEach((it) => Object.assign(it, d.all));
      if (d.report) group.push({ ...d.report, ...d.all });
      else Object.assign(group.at(-1), d.attach);
      Object.assign(group.at(-1), d.last);
      items.push(...group);
      const said = group.map((it) => it.text).filter(Boolean).join(' ');
      turn.chain = (turn.chain || Promise.resolve()).then(() => delivered(d.task, said));
    }
    items.unshift(...texts);
    if (!items.length) return;
    turn.posted = true;
    const c = chatOf(u, chatId);
    c.chain = c.chain.then(() => post(u, chatId, items)).catch((e) => log('[dispatcher] post', e.message));
  }

  async function finish(u, chatId, turn, end) {
    const ok = end.event === 'run.completed';
    const late = ok && String(end.pending_steer || '').trim();
    let carry = [];
    if (late) { // 插话没赶上：没看到的任务结果跟着进下一轮
      const missed = turn.deliveries.filter((d) => !d.posted && d.steered);
      turn.deliveries = turn.deliveries.filter((d) => !missed.includes(d));
      carry = [{ kind: 'raw', body: late, deliveries: missed }];
    }
    if (!ok && !turn.posted && turn.users) turn.buffer.push(FALLBACK);
    flush(u, chatId, turn, true);
    await chatOf(u, chatId).chain;
    await turn.chain;
    const status = ok || end.event === 'run.cancelled' ? 'done' : 'failed';
    activity.end(turn.act, turn.did.join('；') || (turn.firstText ? `回复：${turn.firstText}` : ok ? '没说话' : '网络卡了，没想出来'), status);
    return carry;
  }

  return {
    userMessage: (u, chatId, { text = '', images = [] } = {}) => submit(u, chatId, { kind: 'user', text, images }),
    // delivery：{ task, title, input, fallback, report, attach, all, last }（server.mjs 的 deliveryOf）
    taskFinished: (u, chatId, delivery) => submit(u, chatId, { kind: 'delivery', delivery }),
    busy: (u, chatId) => !!chats.get(key(u, chatId))?.busy,
    // 删聊天：停掉这个聊天正在跑的那一轮，之后的事件不再发消息
    async forget(u, chatId) {
      const c = chats.get(key(u, chatId));
      chats.delete(key(u, chatId));
      if (c?.run?.status === 'running') await (await runtimeOf(u)).stop(c.run.id).catch(() => {});
    },
    async close() {
      await Promise.allSettled([...runtimes.values()].map(async (p) => (await p).close()));
    },
  };
}
