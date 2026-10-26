// 聊天和消息：可以开新聊天、删旧聊天；后台任务、目标是所有聊天共用的。
// 外加「喵团手上的事」（activity）：主 agent 回一条消息、转述一个结果都是一件事，顶栏状态显示正在做的那一步。只在内存里，做完就丢。
import { newId, isoNow, pause } from './util.mjs';

const WELCOME = '嗨～我是喵团，你的私人助理 🐱 查资料、找图、打电话问问、帮你盯着关心的事，都可以交给我～';
const NEW_CHAT_TITLE = '新聊天';
const flat = (t) => String(t || '').replace(/\s+/g, ' ');

export function createChats({ store }) {
  // 消息默认进当前聊天；带 chatId 的回到那个聊天。那个聊天已经删了就不发，返回 null。
  function addMessage(u, m) {
    const s = u.state;
    const msg = { id: newId('m'), at: isoNow(), chatId: s.currentChat, ...m };
    const chat = s.chats.find((c) => c.id === msg.chatId);
    if (!chat) return null;
    s.messages.push(msg);
    chat.updatedAt = msg.at;
    if (chat.title === NEW_CHAT_TITLE && msg.role === 'me' && msg.text) chat.title = flat(msg.text).slice(0, 20);
    store.save(u);
    store.broadcast(u, { type: 'message', message: msg });
    return msg;
  }

  // 一条一条发，中间停一下像在打字
  async function postParts(u, chatId, items) {
    const posted = [];
    for (const [i, it] of items.entries()) {
      if (i) await pause(it.text ? 500 + Math.min(1500, it.text.length * 45) : 400);
      const m = addMessage(u, { role: 'bot', ...it, chatId });
      if (m) posted.push(m);
    }
    return posted;
  }

  function updateMessage(u, m, patch) {
    Object.assign(m, patch);
    store.save(u);
    store.broadcast(u, { type: 'message', message: m });
  }

  // 用户回了（在选项卡上选完，或者直接打字）：这个聊天里还开着的提问选项卡收起来，记下答案
  function closeAsk(u, chatId, picked, text) {
    const open = (m) => m.attachments?.find((a) => a.type === 'ask' && !a.answered);
    const m = u.state.messages.findLast((x) => x.chatId === chatId && x.role === 'bot' && open(x));
    if (!m) return;
    const answers = picked?.id === m.id && picked.answers && typeof picked.answers === 'object' ? picked.answers : null;
    Object.assign(open(m), answers ? { answers, answered: true } : { answered: true, typed: String(text).slice(0, 80) });
    updateMessage(u, m, {});
  }

  function newChat(u) {
    const at = isoNow();
    const chat = { id: newId('c'), title: NEW_CHAT_TITLE, createdAt: at, updatedAt: at };
    u.state.chats.push(chat);
    u.state.currentChat = chat.id;
    addMessage(u, { role: 'bot', text: WELCOME });
    return chat;
  }

  // 聊天列表：最近用过的在前，带最后一条消息预览。q：搜标题和所有消息内容，预览换成命中的那句话。
  function list(u, q = '') {
    const needle = String(q).trim().toLowerCase();
    return u.state.chats.map((c) => {
      const msgs = u.state.messages.filter((m) => m.chatId === c.id);
      const last = msgs.at(-1);
      let preview = flat(last?.text || (last?.attachments?.some((a) => a.type === 'images') ? '[图片]' : '')).slice(0, 40);
      if (needle) {
        const hit = msgs.findLast((m) => flat(m.text).toLowerCase().includes(needle));
        if (!hit && !c.title.toLowerCase().includes(needle)) return null;
        if (hit) { const t = flat(hit.text); const i = t.toLowerCase().indexOf(needle); preview = `${i > 12 ? '…' : ''}${t.slice(Math.max(0, i - 12), i + needle.length + 28)}`; }
      }
      return { ...c, count: msgs.filter((m) => m.role === 'me').length, preview };
    }).filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  function changed(u) {
    store.save(u);
    store.broadcast(u, { type: 'chats', currentChat: u.state.currentChat });
  }

  // 当前聊天还一句话没说过，就不再开一个空的
  function open(u) {
    const s = u.state;
    const cur = s.chats.find((c) => c.id === s.currentChat);
    const chat = cur && !s.messages.some((m) => m.chatId === cur.id && m.role === 'me') ? cur : newChat(u);
    changed(u);
    return chat;
  }

  function select(u, chat) {
    u.state.currentChat = chat.id;
    changed(u);
  }

  function remove(u, chat) {
    const s = u.state;
    s.chats = s.chats.filter((c) => c.id !== chat.id);
    s.messages = s.messages.filter((m) => m.chatId !== chat.id);
    if (s.currentChat === chat.id) {
      if (s.chats.length) s.currentChat = list(u)[0].id; else newChat(u);
    }
    changed(u);
  }

  // ---------- activity：replyIn 是做完会往哪个聊天发消息，App 在那个聊天里显示「…」 ----------
  const pushActivity = (a) => store.broadcast(store.get(a), { type: 'activity', activity: a });
  const activity = {
    start(u, { title, kind = 'message', chatId, replyIn, taskId, goalId }) {
      const a = { id: newId('a'), uid: u.id, kind, title: flat(title).slice(0, 40), chatId, replyIn, taskId, goalId, status: 'running', step: '' };
      u.activity.push(a);
      return a;
    },
    step(a, text) {
      if (a?.status !== 'running') return;
      a.step = String(text).slice(0, 40);
      pushActivity(a);
    },
    end(a, outcome, status = 'done') {
      if (a?.status !== 'running') return;
      Object.assign(a, { status, step: '', outcome: flat(outcome).slice(0, 80) });
      const u = store.get(a);
      u.activity = u.activity.filter((x) => x !== a);
      pushActivity(a);
    },
  };

  // 没有聊天的人（新账号）先给一个；当前聊天没了就切到最近的那个
  store.onLoad((u) => {
    const s = u.state;
    if (!s.chats.some((c) => c.id === s.currentChat)) {
      if (s.chats.length) s.currentChat = list(u)[0].id; else newChat(u);
    }
  });

  return { addMessage, postParts, updateMessage, closeAsk, list, open, select, remove, activity,
    find: (u, id) => u.state.chats.find((c) => c.id === id) };
}
