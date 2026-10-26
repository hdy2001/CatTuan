// 前端的共享状态：服务端的全量数据 S（/api/state 拉、/api/events 推增量），演示模式开关，还在等回复的消息数。
export const MOCK = new URLSearchParams(location.search).get('mock'); // 演示模式（?mock=booking）：用 mock/ 下的脚本和假数据，不连服务端

export let S = { messages: [], tasks: [], goals: [], chats: [], activity: [] };
export function setState(next) { S = next; }

// 发出去还没等到回复的消息数（可以连着发，喵团一条条回）
export let waitingReply = 0;
export function setWaiting(n) { waitingReply = Math.max(0, n); }

export const isAdmin = () => S.me?.role === 'admin';
export const taskById = (id) => S.tasks.find((t) => t.id === id);
export const isActive = (t) => t.status === 'running' || t.status === 'queued';
