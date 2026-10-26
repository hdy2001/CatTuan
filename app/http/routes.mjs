// App 的 HTTP 接口。除了健康检查、登录和登录页的静态文件，都要登录；每个接口只碰这个人自己的数据，拿别人的 id 来查一律 404。
// 别的网页不能替用户调 App 的接口：有 Origin 的写请求必须来自 App 自己（在 HTTPS 反代后面时和 PUBLIC_ORIGIN 比）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter, readBody, sendJson, serveFile, httpError } from './util.mjs';
import { saveUpload, uploadPath, uploadsDir, proxyImage } from './media.mjs';
import { chatSession } from '../agent/agents.mjs';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PUBLIC_FILES = new Set(['/style.css', '/longcat-icon.svg', '/manifest.webmanifest']); // 登录页用到的

export function createRoutes({ config, auth, store, chats, tasks, goals, main, calls, live, quota, agents }) {
  const api = createRouter();
  const ok = (res, body = { ok: true }) => sendJson(res, 200, body);
  const must = (x, message = 'not found') => { if (!x) throw httpError(404, message); return x; };

  api.add('GET', '/api/state', ({ res, u }) => {
    const s = u.state;
    ok(res, { me: { name: u.name, role: u.role }, messages: s.messages.filter((m) => m.chatId === s.currentChat).slice(-200),
      chats: chats.list(u), currentChat: s.currentChat, tasks: s.tasks.slice(-50), goals: s.goals, activity: u.activity });
  });

  // SSE：只推给这个人自己开着的页面。有人打开 App 时让沙箱推连续画面
  api.add('GET', '/api/events', ({ req, res, u }) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
    u.clients.add(res);
    live.viewersChanged();
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => { clearInterval(ping); u.clients.delete(res); live.viewersChanged(); });
  });

  // ask：用户在提问选项卡上选完了（{ id: 那条消息, answers }），text 是 App 替他拼好的那句话
  api.add('POST', '/api/message', async ({ req, res, u }) => {
    const { text = '', images = [], ask } = await readBody(req, 10 << 20); // 前端把图缩到 1280px 再传，3 张绰绰有余
    const over = quota.over(u, 'messages');
    if (over) return sendJson(res, 429, { error: over });
    const files = [].concat(images).slice(0, 3).map((img) => saveUpload(u, img)).filter(Boolean);
    const said = String(text).trim();
    if (!said && !files.length) return sendJson(res, 400, { error: 'empty' });
    quota.bump(u, 'messages');
    const chatId = u.state.currentChat; // 主 agent 回复期间切了聊天，回复和任务也留在发消息的那个聊天
    chats.addMessage(u, { role: 'me', text: said, images: files, chatId });
    chats.closeAsk(u, chatId, ask, said);
    main.userMessage(u, chatId, { text: said, images: files.map((f) => uploadPath(u, f)) }).catch((e) => console.error('[main]', e.message));
    ok(res);
  });

  api.add('GET', '/api/calls', ({ res, u }) => ok(res, { line: calls.line, calls: calls.list(u) }));
  api.add('GET', '/api/profile', ({ res, u }) => ok(res, { ...u.state.stats, goals: u.state.goals.length, chats: u.state.chats.length, model: config.models.main.id }));

  // ---- 聊天：新建、切换、删除 ----
  api.add('GET', '/api/chats', ({ res, u, url }) => ok(res, { chats: chats.list(u, url.searchParams.get('q') || ''), currentChat: u.state.currentChat }));
  api.add('POST', '/api/chats', ({ res, u }) => ok(res, { chat: chats.open(u) }));
  api.add('POST', '/api/chats/:id/open', ({ res, u, params }) => {
    chats.select(u, must(chats.find(u, params.id), '这个聊天不在了'));
    ok(res, { currentChat: u.state.currentChat });
  });
  api.add('DELETE', '/api/chats/:id', ({ res, u, params }) => {
    const chat = must(chats.find(u, params.id), '这个聊天不在了');
    chats.remove(u, chat);
    // 主 agent 在这个聊天里的 Pi 会话一起删掉
    main.forget(u, chat.id).catch(() => {}).finally(() => agents.dropSession(u, chatSession(chat.id)));
    ok(res, { currentChat: u.state.currentChat });
  });

  // ---- 任务：停止、重试（失败 / 停了的点「重试」）、修改 ----
  api.add('POST', '/api/tasks/:id/stop', ({ res, u, params }) => {
    const t = must(tasks.find(u, params.id));
    if (!tasks.stop(t)) return sendJson(res, 409, { error: '这个任务已经结束了' });
    if (t.kind !== 'goal') chats.addMessage(u, { role: 'bot', text: `好，「${t.title}」先停了～`, taskId: t.id, round: t.round || 1, ...(t.chatId && { chatId: t.chatId }) });
    ok(res);
  });
  api.add('POST', '/api/tasks/:id/retry', ({ res, u, params }) => {
    const t = must(tasks.find(u, params.id));
    const error = tasks.retry(t);
    if (error) return sendJson(res, t.status === 'failed' || t.status === 'stopped' ? 429 : 409, { error });
    if (t.kind !== 'goal') chats.addMessage(u, { role: 'bot', text: `重新去办：${t.title}～`, taskId: t.id, round: t.round || 1, ...(t.chatId && { chatId: t.chatId }) });
    ok(res);
  });
  api.add('POST', '/api/tasks/:id/steer', async ({ req, res, u, params }) => {
    const rev = await tasks.steer(must(tasks.find(u, params.id)), (await readBody(req)).text);
    rev ? ok(res, rev) : sendJson(res, 400, { error: '改不了这个任务' });
  });

  // ---- 目标 ----
  api.add('POST', '/api/goals', async ({ req, res, u }) => {
    const text = String((await readBody(req)).text || '').trim();
    if (!text) return sendJson(res, 400, { error: '说说想让喵团盯着什么' });
    const over = quota.goalLimit(u);
    if (over) return sendJson(res, 429, { error: over });
    ok(res, await goals.fromText(u, text));
  });
  api.add('POST', '/api/goals/:id/run', ({ res, u, params }) => ok(res, { task: goals.run(must(goals.find(u, params.id))) }));
  api.add('PATCH', '/api/goals/:id', async ({ req, res, u, params }) => {
    const g = must(goals.find(u, params.id));
    const body = await readBody(req);
    if ('done' in body) goals.setDone(g, !!body.done, '你标记的');
    else if ('enabled' in body) goals.setEnabled(g, !!body.enabled);
    ok(res, g);
  });
  api.add('DELETE', '/api/goals/:id', ({ res, u, params }) => { goals.remove(u, must(goals.find(u, params.id))); ok(res); });

  // ---- 文件：回放帧、上传的图、外部图片代理 ----
  api.add('GET', '/api/frames/:task/:file', ({ res, u, params }) => serveFile(res, live.frameFile(u, params.task, params.file)));
  api.add('GET', '/api/uploads/:name', ({ res, u, params }) => serveFile(res, path.join(uploadsDir(u), path.basename(params.name))));
  api.add('GET', '/api/img', ({ res, url }) => proxyImage(res, url.searchParams.get('u') || ''));

  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin && req.headers.origin !== (config.publicOrigin || `http://${req.headers.host}`)) {
      return sendJson(res, 403, { error: 'forbidden origin' });
    }
    try {
      // 健康检查（不用登录）：只给几个计数，scripts/restart.sh 据此判断忙不忙
      if (url.pathname === '/api/health') {
        const all = store.all().flatMap((x) => x.state.tasks);
        return ok(res, { ok: true, executorRuntime: 'pi', users: store.users.size, running: all.filter((t) => t.status === 'running').length, queued: all.filter((t) => t.status === 'queued').length });
      }
      if (url.pathname.startsWith('/api/auth/')) return await auth.route(req, res, url);
      if (url.pathname === '/login') return serveFile(res, path.join(PUBLIC_DIR, 'login.html'));
      if (PUBLIC_FILES.has(url.pathname)) return serveFile(res, path.join(PUBLIC_DIR, url.pathname));

      const me = auth.userOf(req);
      if (!me) {
        if (url.pathname.startsWith('/api/')) return sendJson(res, 401, { error: '请先登录' });
        res.writeHead(302, { Location: '/login' });
        return res.end();
      }
      const u = store.load(me);
      if (url.pathname.startsWith('/api/')) {
        const route = api.match(req.method, url.pathname);
        if (!route) return sendJson(res, 404, { error: 'not found' });
        if (route.status) return sendJson(res, route.status, { error: 'method not allowed' });
        return await route.handler({ req, res, url, u, params: route.params });
      }
      const file = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
      if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) return sendJson(res, 403, { error: 'forbidden' });
      return serveFile(res, file, () => serveFile(res, path.join(PUBLIC_DIR, 'index.html')));
    } catch (e) {
      if (!e.status) console.error(e);
      if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message });
      else res.end();
    }
  };
}
