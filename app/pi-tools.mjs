// Project-owned business tools run directly in the Pi process.
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { readEnv, readConfig } from './tools/common.mjs';
import { createBusinessTools } from './tools/business.mjs';
import { createWebTools } from './tools/web.mjs';
import { createKnowledgeTools, knowledgeContext } from './tools/knowledge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TOOLSETS = ['idol', 'vision', 'memory', 'session_search', 'skills', 'skillstore', 'deepsearch', 'phone'];
const names = (value) => new Set(Array.isArray(value) ? value : typeof value === 'string' ? value.split(',').map((v) => v.trim()) : []);

export function createToolContext({ home, sessionId = '', env = process.env, root = ROOT } = {}) {
  if (!home) throw new Error('Tool context requires a user home');
  home = path.resolve(home);
  root = path.resolve(root);
  const dataDir = path.resolve(env.CATTUAN_DATA_DIR || path.join(root, 'app/data'));
  let uploadDir;
  // An adopted administrator keeps the template home, but uploads live with
  // their account. Resolve the owner using the current account schema.
  const database = path.join(dataDir, 'app.db');
  if (home === path.join(root, 'agent-home') && fs.existsSync(database)) {
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      const owner = db.prepare('SELECT id, agent_home FROM users').all().find((user) => user.agent_home && path.resolve(root, user.agent_home) === home);
      if (owner) uploadDir = path.join(dataDir, 'users', owner.id, 'uploads');
    } finally { db.close(); }
  }
  const shared = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('API_SERVER_')));
  return { home, sessionId, root, dataDir, uploadDir,
    env: { ...shared, ...readEnv(path.join(home, '.env')), CATTUAN_HOME: home, PI_HOME: home }, config: () => readConfig(home) };
}

function allowed(ctx, spec) {
  const config = ctx.config();
  const enabled = names(config.platform_toolsets?.api_server ?? DEFAULT_TOOLSETS);
  const disabled = new Set([...names(config.agent?.disabled_toolsets), ...names(config.agent?.disabled_tools), ...names(config.tools?.api_server?.disabled)]);
  if (!enabled.has(spec.toolset) || disabled.has(spec.name) || disabled.has(spec.toolset)) return false;
  return spec.name !== 'memory' || config.memory?.memory_enabled !== false || config.memory?.user_profile_enabled !== false;
}

function result(value) {
  if (Array.isArray(value?.content) && value.content.every((part) => ['text', 'image'].includes(part.type))) return value;
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  let details;
  try { details = JSON.parse(text); } catch { details = { result: text }; }
  return { content: [{ type: 'text', text }], details };
}

export async function createPiTools({ home, sessionId, signal, env, timeoutMs = 330000 } = {}) {
  if (!sessionId) throw new Error('Tools require a task session');
  signal?.throwIfAborted();
  const ctx = createToolContext({ home, sessionId, env });
  const lifetime = new AbortController();
  const specs = [...await createBusinessTools(ctx), ...await createWebTools(ctx), ...await createKnowledgeTools(ctx)];
  return {
    systemPrompt: await knowledgeContext(ctx),
    tools: specs.filter((spec) => allowed(ctx, spec)).map((spec) => ({
      name: spec.name, label: spec.name, description: spec.description, parameters: spec.parameters,
      async execute(_id, args, callSignal) {
        const active = AbortSignal.any([lifetime.signal, signal, callSignal, AbortSignal.timeout(timeoutMs)].filter(Boolean));
        active.throwIfAborted();
        if (!allowed(ctx, spec)) throw new Error(`Tool is unavailable or disabled: ${spec.name}`);
        const output = await spec.execute(args || {}, active);
        active.throwIfAborted();
        return result(output);
      },
    })),
    close() { lifetime.abort(new DOMException('Toolset closed', 'AbortError')); },
  };
}
