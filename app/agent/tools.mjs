// 业务工具：按这个人的 home、配置和凭据建好，交给 Pi。工具只有项目显式注册的这些，没有终端和文件工具。
// 每次调用都重新检查开关（config.yaml 改了马上生效），并把取消信号和进度回调（onUpdate）传下去。
// 工具结果里的 attachments（要挂到消息上给用户看的东西）只放进 details 给 App，不进给模型的文字。
import path from 'node:path';
import { readEnv, readConfig, enabledTools } from '../tools/common.mjs';
import { createBusinessTools } from '../tools/business.mjs';
import { createWebTools } from '../tools/web.mjs';
import { createKnowledgeTools, knowledgeContext } from '../tools/knowledge.mjs';
import { createOutputTools } from '../tools/output.mjs';

// user：{ id, name, dir }（上传的图在 dir/uploads）；taskId：后台任务的编号（沙箱直播、通话记录按它归属）；
// services：App 提供给工具的能力（比如打电话）；media：这一轮工具找到的图片，attach 按 id 取
export function createToolContext({ home, user = null, sessionId = '', taskId = null, env = process.env, services = {} } = {}) {
  if (!home) throw new Error('Tool context requires a user home');
  home = path.resolve(home);
  return {
    home, user, sessionId, taskId, services, media: new Map(),
    uploadDir: user?.dir ? path.join(user.dir, 'uploads') : null,
    env: { ...env, ...readEnv(path.join(home, '.env')) },
    config: () => readConfig(home),
  };
}

function result(value) {
  if (Array.isArray(value?.content) && value.content.every((part) => ['text', 'image'].includes(part.type))) return value;
  const { attachments, ...rest } = value && typeof value === 'object' && !Array.isArray(value) ? value : { result: value };
  const text = typeof value === 'string' ? value : JSON.stringify(rest);
  return { content: [{ type: 'text', text }], details: { ...rest, ...(attachments?.length && { attachments }) } };
}

// exclude：这个 profile 不给的工具集或工具（主 agent 不打电话）
export async function createTools(options = {}, { exclude = [], timeoutMs = 330000 } = {}) {
  const { signal } = options;
  signal?.throwIfAborted();
  const ctx = createToolContext(options);
  const skip = new Set(exclude);
  const allowed = (spec) => !skip.has(spec.toolset) && !skip.has(spec.name) && enabledTools(ctx.config())(spec);
  const lifetime = new AbortController();
  const specs = [...createBusinessTools(ctx), ...createWebTools(ctx), ...createKnowledgeTools(ctx), ...createOutputTools(ctx)];
  return {
    systemPrompt: await knowledgeContext(ctx),
    tools: specs.filter(allowed).map((spec) => ({
      name: spec.name, label: spec.label || spec.name, description: spec.description, parameters: spec.parameters,
      describe: spec.describe, usesBrowser: spec.usesBrowser,
      async execute(_id, args, callSignal, onUpdate) {
        const active = AbortSignal.any([lifetime.signal, signal, callSignal, AbortSignal.timeout(spec.timeoutMs || timeoutMs)].filter(Boolean));
        active.throwIfAborted();
        if (!allowed(spec)) throw new Error(`Tool is unavailable or disabled: ${spec.name}`);
        const progress = onUpdate ? (details) => onUpdate({ content: [], details }) : () => {};
        const output = await spec.execute(args || {}, active, progress);
        active.throwIfAborted();
        return result(output);
      },
    })),
    close() { lifetime.abort(new DOMException('Toolset closed', 'AbortError')); },
  };
}
