// Pi 会话的运行时：每个账号一个，主 agent（聊天）和子 agent（后台任务、目标检查）都在这里跑，只是 profile 不同。
// 一个 run = 在某个会话（chat-<聊天 id> / task-<任务 id>）里跑一轮：startRun 开始，listeners 收事件，steer 插话，stop 停止。
// 事件：message.completed（模型说完一段话）· tool.started / tool.updated / tool.completed（带工具自己写的展示文字）· run.completed / run.failed / run.cancelled
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { clip, clipLines } from '../core/util.mjs';

export class RuntimeError extends Error {
  constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; }
}

export const TERMINAL = new Set(['run.completed', 'run.failed', 'run.cancelled']);

/** Directory holding the Pi session files of one CatTuan session id. */
export const sessionDir = (agentDir, sessionId) => path.join(path.resolve(agentDir), 'sessions', createHash('sha256').update(sessionId).digest('hex'));

/**
 * Copy the latest Pi session in fromDir into toDir as a new forked session, so
 * a run opened on toDir continues from the same history. Returns false when
 * fromDir has no persisted conversation yet.
 */
export function forkSession({ home, fromDir, toDir }) {
  if (!existsSync(fromDir)) return false;
  const file = SessionManager.continueRecent(path.resolve(home), fromDir).getSessionFile();
  if (!file || !existsSync(file)) return false;
  mkdirSync(toDir, { recursive: true, mode: 0o700 });
  SessionManager.forkFrom(file, path.resolve(home), toDir);
  return true;
}

// The host owns all resources. Pi must not discover shell tools, extensions, or
// instructions from the checkout or the user's global Pi installation.
function resourceLoader(systemPrompt) {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function toolText(result) {
  if (typeof result === 'string') return result;
  if (Array.isArray(result?.content)) return result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  return JSON.stringify(result ?? null);
}

// 工具结果 → 对象：优先用工具给的 details，其次把文字当 JSON 解析；出错的记成 { error }
function outcome(result, isError) {
  const text = toolText(result);
  let o = result?.details && typeof result.details === 'object' && !Array.isArray(result.details) ? result.details : null;
  if (!o) { try { o = JSON.parse(text); } catch {} }
  if (!o || typeof o !== 'object' || Array.isArray(o)) o = { text };
  if (isError && !o.error) o = { ...o, error: clip(o.text || o.message || text || '工具报错', 200) };
  return o;
}

// 这一步怎么写给人看：工具自己的 describe(args) → { act, detail, done(out) }，没写就用「工具名 + 最像对象的那个参数」
function display(tool, args, out) {
  const a = args && typeof args === 'object' ? args : {};
  let spec;
  try { spec = tool?.describe?.(a); } catch {}
  if (!spec) {
    const key = ['query', 'q', 'name', 'title', 'url', 'content', 'text'].map((k) => a[k]).find((v) => typeof v === 'string' && v.trim());
    spec = { act: `${tool?.label || tool?.name || '用工具'}${key ? `「${clip(key, 24)}」` : ''}`,
      detail: Object.entries(a).slice(0, 3).map(([k, v]) => `${k}：${clip(typeof v === 'string' ? v : JSON.stringify(v), 60)}`).join('\n') };
  }
  if (out === undefined) return { title: `正在${spec.act}`, detail: clipLines(spec.detail, 300) };
  if (out.error) return { title: `${spec.act}，没成功`, detail: clipLines(out.error, 300), ok: false };
  let d = {};
  try { d = spec.done?.(out) || {}; } catch {}
  return { title: clip(d.title || spec.act, 60), detail: clipLines(d.detail ?? spec.detail, 300), ok: d.ok !== false };
}

/**
 * profiles：{ 名字: { model: { id, url, key, maxTokens, contextWindow, maxTurns }, tools(ctx) → { tools, systemPrompt, close }, instructions(bridge) → string } }
 * 同一个 profile 的模型按 url + key 注册成一个 provider；modelRuntime 只给测试替换。
 */
export async function createRuntime({ home, agentDir, profiles, modelRuntime: suppliedModels, createSession = createAgentSession, now = Date.now }) {
  if (!home) throw new Error('Pi runtime requires a user home');
  home = path.resolve(home);
  agentDir = path.resolve(agentDir || path.join(home, 'pi'));
  await mkdir(path.join(agentDir, 'sessions'), { recursive: true, mode: 0o700 });
  for (const [name, p] of Object.entries(profiles)) {
    if (!(p.model.maxTokens < p.model.contextWindow)) throw new Error(`${name}: max tokens must be smaller than the context window`);
    if (!suppliedModels && !p.model.key) throw new Error('LONGCAT_API_KEY is required');
  }
  const models = suppliedModels || await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: path.join(agentDir, 'models-cache.json'),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  if (!suppliedModels) {
    for (const [name, { model: m }] of Object.entries(profiles)) {
      models.registerProvider(name, {
        baseUrl: m.url, api: 'openai-completions', apiKey: m.key, authHeader: true,
        models: [{
          id: m.id, name: m.id, reasoning: false, input: ['text', 'image'], contextWindow: m.contextWindow, maxTokens: m.maxTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          samplingParams: { thinking: { type: 'disabled' } },
          compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens' },
        }],
      });
    }
  }
  const runs = new Map();
  const active = new Map();
  let closing = false;

  function emit(run, event) {
    const item = { seq: run.events.length, ...event };
    run.events.push(item);
    if (TERMINAL.has(item.event)) { run.status = item.event.slice(4); run.endedAt = now(); }
    for (const listener of run.listeners) {
      try { listener(item); } catch { run.listeners.delete(listener); }
    }
  }

  async function execute(run) {
    const profile = profiles[run.profile];
    const { maxTurns, maxTokens } = profile.model;
    let session, bridge, unsubscribe, terminal, prompt;
    try {
      const model = models.getModel(run.profile, profile.model.id);
      if (!model) throw new Error(`Pi model unavailable: ${run.profile}/${profile.model.id}`);
      bridge = await profile.tools({ sessionId: run.sessionId, signal: run.controller.signal });
      if (run.controller.signal.aborted) throw run.controller.signal.reason;
      const dir = sessionDir(agentDir, run.sessionId);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      // session_search 凭它认出这个会话是哪个聊天 / 任务
      await writeFile(path.join(dir, 'task.json'), JSON.stringify({ task_session_id: run.sessionId }) + '\n', { mode: 0o600 });
      const settingsManager = SettingsManager.inMemory({
        cacheWarming: 'off', enableAnalytics: false, enableInstallTelemetry: false,
        retry: { enabled: false, provider: { maxRetries: 0 } },
        defaultProvider: run.profile, defaultModel: profile.model.id, defaultThinkingLevel: 'off',
      });
      ({ session } = await createSession({
        cwd: home, agentDir, modelRuntime: models, model, thinkingLevel: 'off',
        // An explicit allowlist keeps every built-in filesystem/shell tool off,
        // even if a Pi version changes its default tool selection.
        noTools: 'builtin', tools: bridge.tools.map((tool) => tool.name), customTools: bridge.tools,
        resourceLoader: resourceLoader(await profile.instructions(bridge)),
        sessionManager: SessionManager.continueRecent(home, dir), settingsManager,
      }));
      run.session = session;
      if (run.controller.signal.aborted) { await session.abort(); throw run.controller.signal.reason; }
      const byName = new Map(bridge.tools.map((tool) => [tool.name, tool]));
      const toolArgs = new Map();
      const step = (event) => ({ tool_call_id: `${run.id}:${event.toolCallId}`, tool: event.toolName, label: byName.get(event.toolName)?.label || event.toolName,
        ...(byName.get(event.toolName)?.usesBrowser && { browser: true }) });
      unsubscribe = session.subscribe((event) => {
        if (event.type === 'turn_start' && ++run.turns > maxTurns) {
          run.limitReached = true;
          // abort() signals synchronously; its promise settles after the loop.
          // Do not await it from a Pi event listener, which is inside that loop.
          void session.abort().catch(() => {});
        } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
          const content = Array.isArray(event.message.content) ? event.message.content : [];
          const text = content.filter((block) => block.type === 'text').map((block) => block.text).join('').trim();
          const toolCalls = content.filter((block) => block.type === 'toolCall').length;
          if (text || toolCalls) emit(run, { event: 'message.completed', text, tool_calls: toolCalls });
        } else if (event.type === 'tool_execution_start') {
          toolArgs.set(event.toolCallId, event.args);
          emit(run, { event: 'tool.started', ...step(event), args: event.args, ...display(byName.get(event.toolName), event.args) });
        } else if (event.type === 'tool_execution_update') {
          emit(run, { event: 'tool.updated', ...step(event), progress: event.partialResult?.details ?? null });
        } else if (event.type === 'tool_execution_end') {
          const args = toolArgs.get(event.toolCallId);
          toolArgs.delete(event.toolCallId);
          const out = outcome(event.result, event.isError === true);
          emit(run, { event: 'tool.completed', ...step(event), args, result: toolText(event.result), details: out, error: event.isError === true,
            ...display(byName.get(event.toolName), args, out) });
        }
      });
      const messageOffset = session.messages.length;
      run.promptStarted = true;
      prompt = session.prompt(run.input, { expandPromptTemplates: false, source: 'rpc' });
      // Messages received while session setup was underway enter the same Pi run.
      for (const text of run.waitingSteers.splice(0)) await session.steer(text, undefined, { source: 'rpc' });
      await prompt;
      run.acceptingInput = false;
      // Pi's steer() has asynchronous input preparation. A request accepted just
      // before the final answer must be queued before we snapshot pending input.
      await Promise.allSettled([...run.steersInFlight]);
      const lastAssistant = session.messages.slice(messageOffset).findLast((message) => message.role === 'assistant');
      if (run.limitReached) {
        terminal = { event: 'run.failed', error: `Pi exceeded the ${maxTurns} turn limit` };
      } else if (run.controller.signal.aborted || lastAssistant?.stopReason === 'aborted') {
        terminal = { event: 'run.cancelled' };
      } else if (lastAssistant?.stopReason === 'error') {
        terminal = { event: 'run.failed', error: lastAssistant.errorMessage || 'Pi model request failed' };
      } else if (lastAssistant?.stopReason === 'length') {
        terminal = { event: 'run.failed', error: `Pi response exceeded the ${maxTokens} output token limit` };
      } else if (!lastAssistant) {
        terminal = { event: 'run.failed', error: 'Pi finished without an assistant response' };
      } else {
        terminal = { event: 'run.completed', output: session.getLastAssistantText() || '',
          pending_steer: [...run.waitingSteers, ...session.getSteeringMessages()].join('\n\n') };
      }
    } catch (error) {
      // If preparing an early steering message failed, prompt() may still be
      // running. Settle the real Pi loop before disposing its tools or session.
      try { await session?.abort(); } catch { /* Keep the original run error. */ }
      try { await prompt; } catch { /* prompt's error is reported below. */ }
      terminal = run.limitReached ? { event: 'run.failed', error: `Pi exceeded the ${maxTurns} turn limit` }
        : run.controller.signal.aborted ? { event: 'run.cancelled' }
        : { event: 'run.failed', error: error?.message || String(error) };
    } finally {
      run.acceptingInput = false;
      unsubscribe?.();
      try { session?.dispose(); } catch { /* Always release the business bridge too. */ }
      try { await bridge?.close(); }
      catch (error) { if (terminal?.event === 'run.completed') terminal = { event: 'run.failed', error: `Tool bridge cleanup failed: ${error.message}` }; }
      run.session = undefined;
      active.delete(run.sessionId);
      if (run.controller.signal.aborted && terminal?.event === 'run.completed') terminal = { event: 'run.cancelled' };
      emit(run, terminal || { event: 'run.failed', error: 'Pi run ended unexpectedly' });
    }
  }

  return {
    startRun({ input, sessionId = randomUUID(), profile = 'worker' } = {}) {
      if (closing) throw new RuntimeError('Pi runtime is shutting down', 503);
      if (!profiles[profile]) throw new RuntimeError(`Unknown profile: ${profile}`);
      if (typeof input !== 'string' || !input.trim()) throw new RuntimeError('input must be a non-empty string');
      if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 512) throw new RuntimeError('session id must be a non-empty string of at most 512 characters');
      if (active.has(sessionId)) throw new RuntimeError('A run is already active for this session', 409);
      for (const [id, saved] of runs) {
        if (saved.endedAt && now() - saved.endedAt > 3600_000) runs.delete(id);
      }
      const run = { id: randomUUID(), sessionId, profile, input, status: 'running', events: [], listeners: new Set(),
        waitingSteers: [], steersInFlight: new Set(), acceptingInput: true, turns: 0, controller: new AbortController() };
      runs.set(run.id, run);
      active.set(sessionId, run);
      // Register before scheduling execution, so stop/steer work during setup.
      run.done = Promise.resolve().then(() => execute(run));
      return run;
    },
    getRun(id) { return runs.get(id); },
    async steer(id, input) {
      const run = runs.get(id);
      if (!run) throw new RuntimeError('Run not found', 404);
      if (!run.acceptingInput || run.status !== 'running' || run.controller.signal.aborted) throw new RuntimeError('Run is no longer accepting input', 409);
      if (typeof input !== 'string' || !input.trim()) throw new RuntimeError('input must be a non-empty string');
      if (run.session && run.promptStarted) {
        const queued = run.session.steer(input, undefined, { source: 'rpc' });
        run.steersInFlight.add(queued);
        try { await queued; } finally { run.steersInFlight.delete(queued); }
      } else run.waitingSteers.push(input);
      return { status: 'accepted' };
    },
    async stop(id) {
      const run = runs.get(id);
      if (!run) throw new RuntimeError('Run not found', 404);
      if (run.status !== 'running') return { status: run.status };
      run.controller.abort(new Error('Run stopped'));
      await run.session?.abort();
      return { status: 'stopping' };
    },
    async close() {
      closing = true;
      await Promise.allSettled([...active.values()].map(async (run) => {
        run.controller.abort(new Error('Runtime shutting down'));
        await run.session?.abort();
        await run.done;
      }));
    },
  };
}
