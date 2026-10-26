import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'yaml';

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

export function writeJson(file, value) { writeText(file, `${JSON.stringify(value, null, 2)}\n`); }

export function readConfig(home) {
  try {
    const value = parse(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
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

export async function fetchJson(url, { timeoutMs = 120000, signal, ...options } = {}) {
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, { ...options, signal: combined });
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw new Error('接口返回内容过大');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  let value;
  try { value = raw ? JSON.parse(raw) : {}; }
  catch { throw Object.assign(new Error(`接口返回了无效 JSON（${response.status}）`), { status: response.status }); }
  if (!response.ok) throw Object.assign(new Error(value.message || value.error || `接口返回 ${response.status}`), { status: response.status, body: value });
  return value;
}

export function tool(name, toolset, schema, execute) {
  return { name, toolset, description: schema.description, parameters: schema.parameters, execute };
}
