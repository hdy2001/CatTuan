// User-scoped business tools. Pi invokes these functions directly in Node.
import { fetchJson, tool } from './common.mjs';

const schemas = {
  phone_call: {
    description: '用美团专线替用户给商家或机构打一通电话，挂断后返回结果：有没有打出去、有没有接通、对话转写、问到的信息、要不要回来问用户、能不能再打。适合预约、问空位和价格、确认、改约、取消、传话。一次打一家，要问几家就调几次。mode=ask 只问不约：不报用户任何信息、不答应任何事。mode=book 要约：任务说明写了可以直接约才用，details 必须带齐日期、时间、人数（美甲、按摩这类还要项目；球场要时长、场地），App 会检查，缺了不拨。结果里 dialed=false 是没拨（看 result 说为什么）；need_user=true 是店里提了用户没授权的条件，别自己决定，回来问用户；retry 说明能不能再打（soon 可以马上再试一次；later 这次别再打，App 会自动排一次重拨，redial_at 是几点再打；tomorrow/no 别再打）。',
    parameters: { type: 'object', properties: {
      to: { type: 'string', description: '对方电话号码，比如 010-12345678' },
      name: { type: 'string', description: '打给谁：店名或机构名，比如「栗子美甲（和平里店）」' },
      goal: { type: 'string', description: '这通电话要办的事，一句话，比如「问明天下午三点能不能做纯色美甲」' },
      mode: { type: 'string', enum: ['ask', 'book'], description: 'ask 只问不约；book 要约（任务说明写了可以直接约才用）' },
      category: { type: 'string', description: '品类，比如 美甲、餐厅、SPA、网球、物业' },
      details: { type: 'object', description: '预约信息，键用中文：日期、时间、人数、项目、时长、场地……只问不约时写想问的日期时间即可' },
      share: { type: 'string', description: '可以告诉对方的用户信息（只在 mode=book 时用；不写默认报预约人名字）' },
      questions: { type: 'array', items: { type: 'string' }, description: '要问清的事，比如「价格」「付款方式」「要不要提前预约」' },
      ask_user_if: { type: 'array', items: { type: 'string' }, description: '碰到这些情况不答应、回来问用户，比如「只能约别的时间」「要交定金」「要本人通话」' },
    }, required: ['to', 'name', 'goal', 'mode'] },
  },
};

export function createBusinessTools(ctx) {
  if (!ctx.home) throw new Error('Business tools require a user home');
  const env = ctx.env || {};
  const taskId = /^task-(t_[a-z0-9]+)$/.exec(String(ctx.sessionId || ''))?.[1];
  const taskHeaders = taskId ? { 'x-cattuan-task': taskId } : {};
  return [
    tool('phone_call', 'phone', schemas.phone_call, async (args = {}, signal) => {
      signal?.throwIfAborted();
      if (!env.API_SERVER_KEY) return { dialed: false, result: '打电话的服务没连上：当前用户未配置 API_SERVER_KEY' };
      try {
        return await fetchJson(new URL('/api/agent/call', env.CATTUAN_APP_URL || 'http://127.0.0.1:3210'), {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.API_SERVER_KEY}`, ...taskHeaders },
          body: JSON.stringify({ ...args, session_id: String(ctx.sessionId || '') }), timeoutMs: 300_000, signal,
        });
      } catch (e) {
        if (signal?.aborted || e.name === 'AbortError') throw e;
        return { dialed: false, result: e.status ? `打电话的服务出错了（${e.status}）：${(typeof e.body === 'object' ? JSON.stringify(e.body) : String(e.body || e.message)).slice(0, 300)}` : `打电话的服务没连上：${e.message}` };
      }
    }),
  ];
}
