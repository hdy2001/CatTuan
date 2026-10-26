// 主 agent 读到的 App 状态：每轮开头的状态块，和后台任务做完时交给它的那段话。
import { clip, nowText, isoNow, agoText } from '../core/util.mjs';
import { describeAttachment } from '../core/tasks.mjs';
import { scheduleLabel } from '../core/goals.mjs';

const ATTACHED = { document: (a) => `文档「${a.title}」`, images: (a) => `${a.items.length} 张图`, calls: (a) => `${a.calls.length} 个通话记录` };

export function createContext({ store, tasks }) {
  const agentSaid = new Set(); // 主 agent 自己发的消息 id（只在内存里：App 重启后最多把它上一轮的话当成新增再看一遍）

  // 每轮开头的状态块（用户画像、记忆在系统提示里）。聊天历史在它自己的 Pi 会话里，这里只补它看不到的：最新状态，以及上一轮之后
  // 聊天里新增、但不是它说的消息（点「停止」的回复……）。这个聊天第一次走 Pi 会话（会话丢了）时带上最近 15 条。
  // 【后台任务】只列这个聊天派的和目标检查：别的聊天派的（它没见过那段对话）列出来，会被当成这次的请求。
  // 结束了的带上结果：只有说明时，模型会把「已完成」当成办成了。
  function chatContext(u, chatId) {
    const state = u.state;
    const chat = state.chats.find((c) => c.id === chatId);
    const list = state.tasks.filter((t) => t.kind === 'goal' || !t.chatId || t.chatId === chatId).slice(-8).map((t) => {
      const step = t.steps?.at(-1)?.label;
      const when = t.status === 'running' ? `（已 ${Math.round((Date.now() - Date.parse(t.startedAt)) / 1000)} 秒${step ? `，在${step}` : ''}）`
        : t.endedAt ? `（${agoText(Date.now() - Date.parse(t.endedAt))}结束）` : '';
      const said = t.history?.findLast((h) => h.round === (t.round || 1))?.said?.text;
      const result = t.status === 'done' ? said || clip(t.result?.text, 80) : t.status === 'failed' ? t.error : '';
      return `- ${t.id} [${tasks.statusLabel(t)}${t.kind === 'goal' ? '·目标检查' : ''}${t.round > 1 ? `·第 ${t.round} 轮` : ''}] ${t.title}${when}：${t.brief.replace(/\s+/g, ' ').slice(0, 60)}`
        + (result ? `\n  结果：${clip(result, 80)}` : '');
    }).join('\n');
    const goals = state.goals.filter((g) => !g.done).map((g) => `- ${g.id} ${g.title}（${scheduleLabel(g.schedule)}${g.enabled ? '' : '，已暂停'}）：${g.status?.text || ''}`).join('\n');
    const since = chat?.syncedAt;
    const fresh = state.messages.filter((m) => m.chatId === chatId && !agentSaid.has(m.id) && (since ? m.at > since && m.role !== 'me' : true)).slice(since ? -10 : -15);
    if (!since) while (fresh.at(-1)?.role === 'me') fresh.pop(); // 用户刚发的那几条在【用户】里，别再算成「之前的聊天」
    const line = (m) => `${m.role === 'me' ? '用户' : '喵团'}：${m.text || ''}` + (m.images?.length ? '（发了图片）' : '')
      + (m.attachments?.length ? `（附了${m.attachments.map((a) => ATTACHED[a.type]?.(a)).filter(Boolean).join('、')}）` : '');
    if (chat) { chat.syncedAt = isoNow(); store.save(u); }
    return `【现在】${nowText()}\n【目标】\n${goals || '（无）'}\n【后台任务】\n${list || '（无）'}`
      + (fresh.length ? `\n【${since ? '聊天里新增的消息（不是你说的）' : '之前的聊天'}】\n${fresh.map(line).join('\n')}` : '');
  }

  // 后台任务结束 → 交给主 agent 的那段话 + 要挂在它回复后面的东西
  function deliveryOf(t) {
    const atts = t.result?.attachments || [];
    // 中途插话或做完后改过要求：以修改后的为准（任务标题还是最初那个）
    const asks = (t.revisions || []).filter((v) => v.round === (t.round || 1) && ['delivered', 'round'].includes(v.state)).map((v) => v.text);
    const redo = asks.length ? `（用户${t.round > 1 ? `看了结果后要求修改，这是第 ${t.round} 轮` : '中途改了要求'}：${asks.join('；')}。以修改后的要求为准，标题里的旧说法不算）` : '';
    const text = String(t.result?.text || '').trim();
    const extra = atts.map((a) => (a.type === 'document' ? `【附上的文档】「${a.title}」会附在你的回复后面（全文用 read_task_result 看）` : describeAttachment(a))).filter(Boolean).join('\n');
    const input = t.status === 'done'
      ? `【后台任务结果】任务 ${t.id}「${t.title}」${t.round > 1 ? `第 ${t.round} 轮` : ''}做完了${redo}\n结果：\n${text.slice(0, 6000) || '（没有文字）'}${text.length > 6000 ? '\n（后面还有，用 read_task_result 看全文）' : ''}${extra ? `\n${extra}` : ''}`
      : `【后台任务结果】任务 ${t.id}「${t.title}」失败了，原因：${t.error}${extra ? `\n${extra}` : ''}`;
    return {
      task: t, title: `转述「${t.title}」的结果`, input, attachments: atts,
      fallback: t.status === 'done' ? clip(text.split('\n').find((l) => l.trim()) || '弄好了', 80) : '这次没弄成，等下再试试？',
      last: { taskId: t.id, round: t.round || 1, took: tasks.roundSecs(t) },
    };
  }

  return { chatContext, deliveryOf, markSaid: (m) => agentSaid.add(m.id) };
}
