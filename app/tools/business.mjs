// 要 App 配合的业务工具：打电话。拨号、通话记录由 App 的 calls 服务做（ctx.services.phone），工具只管参数和结果；
// 这个人的配置和凭据（ctx.env）一起交过去，外呼平台按它拨。
import { tool } from './common.mjs';
import { clip } from '../core/util.mjs';

const schemas = {
  phone_call: {
    label: '打电话',
    describe: (a) => {
      const act = `给「${clip(a.name, 20)}」打电话`;
      return { act, detail: a.goal, done: (o) => (o.dialed === false ? { title: `没打出去：${clip(o.result, 24)}`, detail: o.retry_hint, ok: false }
        : !o.connected ? { title: `${act}，${clip(o.result, 20)}`, detail: [a.goal, o.retry_hint].filter(Boolean).join('\n'), ok: false }
          : { title: `打完给「${clip(a.name, 20)}」的电话`, detail: [o.summary, a.goal].filter(Boolean).join('\n') }) };
    },
    description: '用美团专线替用户给商家或机构打一通电话（电话由外呼平台的 AI 按这里给的要求去谈），挂断后返回结果：有没有打出去、有没有接通、对话转写、问到的信息、要不要回来问用户、能不能再打。一次打一家，要问几家就调几次；怎么准备、怎么看结果见 phone-call 技能。mode=ask 只问不约：不报用户任何信息、不答应任何事。mode=book 要约：任务说明写了可以直接约才用，details 要带齐预约信息。结果里 dialed=false 是没拨（看 result 说为什么）；need_user=true 是店里提了用户没授权的条件，别自己决定，回来问用户；outcome=result_pending 是电话打出去了、平台还没给结果，别重拨；retry 说明能不能再打（soon 可以马上再试一次；later 这次别再打，过一阵可以再打；rewrite 把参数补齐、改好再打；no 别再打这个号码）。',
    parameters: { type: 'object', properties: {
      to: { type: 'string', description: '对方电话号码，比如 010-12345678' },
      name: { type: 'string', description: '打给谁：店名或机构名，比如「栗子美甲（和平里店）」' },
      goal: { type: 'string', description: '这通电话要办的事，一句话，比如「预约网球场地」「问明天下午三点能不能做纯色美甲」' },
      mode: { type: 'string', enum: ['ask', 'book'], description: 'ask 只问不约；book 要约（任务说明写了可以直接约才用）' },
      category: { type: 'string', description: '品类，比如 美甲、餐厅、SPA、网球、物业' },
      details: { type: 'object', description: '用户的需求，键用中文：日期、时间、时长、人数、项目、场地、数量、付款方式……只问不约时写想问的日期时间即可' },
      rejected_terms: { type: 'array', items: { type: 'string' }, description: '对方提出就直接拒绝的条件，比如「其他时间」「室外场」「预付款、定金、最低消费」「更换门店」' },
      ask_user_if: { type: 'array', items: { type: 'string' }, description: '碰到这些情况先不答应、暂停回来问用户，比如「只能约别的时间」「要本人通话」；没有就不写' },
      share: { type: 'string', description: '可以告诉对方的用户信息（只在 mode=book 时用），写成「仅可提供：顾客称呼：…；手机尾号：…。禁止提供：完整手机号、微信、其他个人信息」；不写默认只报预约人称呼' },
      questions: { type: 'array', items: { type: 'string' }, description: '要问清的事，比如「是否有符合要求的场地」「单价及计费方式」「付款方式」「是否已登记成功」' },
    }, required: ['to', 'name', 'goal', 'mode', 'category'] },
    timeoutMs: 15 * 60_000, // 拨号、通话、等平台出话单，最长要十来分钟
  },
};

export function createBusinessTools(ctx) {
  if (!ctx.home) throw new Error('Business tools require a user home');
  return [
    tool('phone_call', 'phone', schemas.phone_call, async (args = {}, signal, progress) => {
      signal?.throwIfAborted();
      if (!ctx.services?.phone) return { dialed: false, result: '这里不能打电话' };
      return ctx.services.phone(args, { signal, progress, env: ctx.env });
    }),
  ];
}
