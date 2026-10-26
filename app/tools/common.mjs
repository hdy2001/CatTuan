import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parse, stringify } from 'yaml';

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function writeJson(file, value) { writeText(file, `${JSON.stringify(value, null, 2)}\n`); }

export const writeConfig = (home, config) => writeText(path.join(home, 'config.yaml'), stringify(config));

export function readConfig(home) {
  try {
    const value = parse(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

// 工具开关（每个人 home 里的 config.yaml）：toolsets 里列的工具集才启用，disabled_tools 再单独关掉某个工具或工具集；
// core（attach）总是开着。返回 spec → 是否可用。
const DEFAULT_TOOLSETS = ['images', 'vision', 'memory', 'session_search', 'skills', 'web', 'phone'];
export const nameSet = (value) => new Set(Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(',').map((v) => v.trim()).filter(Boolean) : []);
export function enabledTools(config) {
  const on = nameSet(config.toolsets ?? DEFAULT_TOOLSETS);
  const off = nameSet(config.disabled_tools);
  return (spec) => (spec.toolset === 'core' || on.has(spec.toolset)) && !off.has(spec.name) && !off.has(spec.toolset)
    && (spec.name !== 'memory' || config.memory?.memory_enabled !== false || config.memory?.user_profile_enabled !== false);
}

export function readEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    result[match[1]] = value;
  }
  return result;
}

export async function withFileLock(file, fn, signal) {
  const lock = `${file}.lock.d`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 30000;
  for (;;) {
    signal?.throwIfAborted();
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      writeJson(path.join(lock, 'owner.json'), { pid: process.pid });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = readJson(path.join(lock, 'owner.json'));
        if (owner?.pid) {
          try { process.kill(owner.pid, 0); }
          catch (gone) { if (gone.code === 'ESRCH') { fs.rmSync(lock, { recursive: true, force: true }); continue; } }
        }
      } catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
      if (Date.now() > deadline) throw new Error('等待数据文件锁超时');
      await delay(20, undefined, { signal });
    }
  }
  try { signal?.throwIfAborted(); return await fn(); }
  finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

// label：给人看的工具名；describe(args) → { act, detail, done(out) }：这一步在做什么、做完怎么写（任务轨迹和顶栏状态用）
// usesBrowser：会用沙箱浏览器（任务轨迹里这一步挂浏览器画面和回放）
export function tool(name, toolset, { label, description, parameters, describe, usesBrowser }, execute) {
  return { name, toolset, label, description, parameters, describe, usesBrowser, execute };
}
