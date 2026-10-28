// 主 agent（聊天里的喵团，仿 Muse 的 main agent）：每个聊天一个 Pi 会话 chat-<聊天 id>，用 main profile 跑（agents.mjs）。
// 它自己干活（和子 agent 同一套工具，只是不打电话），再加 main-tools.mjs 的聊天专用工具。复杂的事用 subagent 工具派子 agent：
// 子 agent 是它的分身，带着这个会话的拷贝在后台跑。跨轮的上下文由 Pi 会话自己记着（会自动压缩）。
//
// 一个聊天同时只跑一轮：
//   - 这一轮还在跑时又来一条消息（或一个任务结果）→ 插话进这一轮（Pi steer），连发的几条合成一次回复，不会各派各的任务；
//   - 这一轮已经在收尾、收不了插话 → 排队，这一轮结束后合起来再跑一轮；插话没赶上（pending_steer）的也接着跑一轮。
// 回复：模型每说完一段话（message.completed）就发出去。同一段话后面跟着要挂东西的工具（attachToReply：派子 agent、提问卡）时，
// 等工具做完再发，好把任务 id、提问卡这些挂在这条回复上；跟着的是干活的工具就先把「我查查」发出去。
// 子 agent 的结果也送进同一个会话，由它接着说（卡片、图、通话组件由 App 挂在它的回复后面）。
import { TERMINAL } from './runtime.mjs';
import { chatSession } from './agents.mjs';
import { createMainTools } from './main-tools.mjs';
import { wellFormed } from '../core/util.mjs';

const FALLBACK = '我这边网络有点卡，等下再说一次？';

// 往一条消息上挂东西：attachments 接在后面，其余字段（任务 id……）直接写上
function attach(item, { attachments = [], ...fields }) {
  Object.assign(item, fields);
  if (attachments.length) item.attachments = [...(item.attachments || []), ...attachments];
  return item;
}

const newTurn = () => ({ userText: '', users: 0, attach: {}, attachments: [], did: [], attachTools: new Set(),
  spoke: false, posted: false, buffer: [], waitTools: 0, deliveries: [], firstText: '' });

/**
 * agents：agents.mjs（runtimeOf、extend）
 * actions：main-tools 用的 App 函数
 * context(u, chatId) → 每轮开头的状态块（时间、目标、任务、新增的消息）
 * post(u, chatId, items) → 依次发消息；activity.start/step/end → 顶栏状态
 * delivered(task, text) → 记下转述了什么
 */
export function createMain({ agents, actions, context, post, activity, delivered = () => {}, log = console.error }) {
  const chats = new Map();
  const key = (u, chatId) => `${u.id}/${chatId}`;
  const chatOf = (u, chatId) => {
    const k = key(u, chatId);
    if (!chats.has(k)) chats.set(k, { run: null, turn: null, busy: false, queue: [], chain: Promise.resolve() });
    return chats.get(k);
  };

  // 主 agent 的聊天工具：每一轮开跑时按这个聊天当前的 turn 建
  agents.extend('main', (u, ctx) => {
    const chatId = String(ctx.sessionId).replace(/^chat-/, '');
    const turn = chats.get(key(u, chatId))?.turn || newTurn();
    const tools = createMainTools({ u, chatId, turn, actions });
    turn.attachTools = new Set(tools.filter((t) => t.attachToReply).map((t) => t.name));
    return tools;
  });

  // images：上传图片的本地路径，主 agent 用 vision_analyze 看（子 agent 复制会话后也看得到这些路径）
  const bodyOf = (e) => wellFormed(e.kind === 'user'
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
        const rt = await agents.runtimeOf(u);
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
      const rt = await agents.runtimeOf(u);
      const run = rt.startRun({ input: wellFormed(`${context(u, chatId)}\n\n${entries.map(bodyOf).join('\n\n')}`), sessionId: chatSession(chatId), profile: 'main' });
      c.run = run;
      end = await follow(u, chatId, turn, run);
    } catch (e) {
      end = { event: 'run.failed', error: e.message };
    }
    if (end.event === 'run.failed') log('[main]', end.error);
    c.run = null;
    const carry = await finish(u, chatId, turn, end).catch((e) => { log('[main]', e.message); return []; });
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
          activity.step(turn.act, ev.title || ev.label);
          if (!turn.attachTools.has(ev.tool)) flush(u, chatId, turn);
        } else if (ev.event === 'tool.completed') {
          if (ev.ok !== false && ev.title) turn.did.push(ev.title);
          if (!ev.error) turn.attachments.push(...(ev.details?.attachments || []));
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

  // 把攒下的话发出去，挂上这一轮工具留下的东西（任务 id、提问卡、附上的图和文档）；
  // final：这一轮结束了，没发的任务结果也一起发（模型没提就用兜底的一句）
  function flush(u, chatId, turn, final = false) {
    const parts = turn.buffer.splice(0).flatMap((s) => s.split(/\n{2,}/)).map((s) => s.trim()).filter(Boolean).slice(0, 4);
    const ready = turn.deliveries.filter((d) => !d.posted);
    const pending = Object.keys(turn.attach).length > 0 || turn.attachments.length > 0;
    if (!parts.length && !(final && (ready.length || pending))) return;
    if (!parts.length && pending && !ready.length) parts.push('好嘞～');
    turn.firstText ||= parts[0] || '';
    const items = [];
    let texts = parts.map((text) => ({ text }));
    const own = { ...turn.attach, attachments: turn.attachments.splice(0) };
    turn.attach = {};
    if (texts.length) attach(texts.at(-1), own);
    else if (ready.length) attach(ready[0].last ||= {}, own); // 任务结果那条带上
    // 任务结果：第一份用模型这段话，后面的（几个任务同时做完）各用自己的兜底一句
    for (const d of (texts.length || final ? ready : [])) {
      d.posted = true;
      const group = texts.length ? texts : [{ text: d.fallback }];
      texts = [];
      group.forEach((it) => { it.partOf = d.task.id; });
      attach(group.at(-1), { ...d.last, attachments: [...(d.last?.attachments || []), ...(d.attachments || [])] });
      items.push(...group);
      const said = group.map((it) => it.text).filter(Boolean).join(' ');
      turn.chain = (turn.chain || Promise.resolve()).then(() => delivered(d.task, said));
    }
    items.unshift(...texts);
    if (!items.length) return;
    turn.posted = true;
    const c = chatOf(u, chatId);
    c.chain = c.chain.then(() => post(u, chatId, items)).catch((e) => log('[main] post', e.message));
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
    // 失败了说一声（哪怕已经说过「我查查」）；停掉的（删聊天、App 关了）不道歉
    if (end.event === 'run.failed' && turn.users) turn.buffer.push(FALLBACK);
    flush(u, chatId, turn, true);
    await chatOf(u, chatId).chain;
    await turn.chain;
    const status = ok || end.event === 'run.cancelled' ? 'done' : 'failed';
    activity.end(turn.act, turn.did.join('；') || (turn.firstText ? `回复：${turn.firstText}` : ok ? '没说话' : '网络卡了，没想出来'), status);
    return carry;
  }

  return {
    userMessage: (u, chatId, { text = '', images = [] } = {}) => submit(u, chatId, { kind: 'user', text, images }),
    // delivery：{ task, title, input, fallback, attachments, last }（agent/context.mjs 的 deliveryOf；last 是挂在最后一条上的字段）
    taskFinished: (u, chatId, delivery) => submit(u, chatId, { kind: 'delivery', delivery }),
    // 删聊天：停掉这个聊天正在跑的那一轮，之后的事件不再发消息
    async forget(u, chatId) {
      const c = chats.get(key(u, chatId));
      chats.delete(key(u, chatId));
      if (c?.run?.status === 'running') await (await agents.runtimeOf(u)).stop(c.run.id).catch(() => {});
    },
  };
}
