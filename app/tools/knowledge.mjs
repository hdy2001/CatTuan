import { readFile, rename, mkdir, readdir, stat, lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { fetchPublic } from './web.mjs';
import { withFileLock as locked, writeText as atomicText } from './common.mjs';

const DELIMITER = '\n§\n';
const MAX_FILE = 256 * 1024;
const MAX_IMAGE = 10 * 1024 * 1024;
const EXCLUDED = new Set(['node_modules', 'venv', '__pycache__', 'site-packages']);
const SUPPORT = new Set(['references', 'templates', 'assets', 'scripts']);
const TERMINAL = /```(?:bash|sh|shell|zsh|console)|\b(?:brew|pip|npm|apt|curl|wget|python3?)\s+[\w-]/i;
const INJECTION = /(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|safety)\s+(?:instructions|rules|prompts)|(?:upload|send|exfiltrate|reveal)\s+(?:all\s+)?(?:secrets?|credentials?|api[ _-]?keys?|passwords?|\.env)|<\/?(?:system|developer)>/i;
const names = value => new Set(Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(',').map(v => v.trim()).filter(Boolean) : []);
const errorResult = error => ({ success: false, error: error.message || String(error) });
const configuration = ctx => typeof ctx.config === 'function' ? ctx.config() || {} : ctx.config || {};
const isWithin = (root, file) => file === root || file.startsWith(root + path.sep);
const charLength = value => [...value].length;

async function optionalText(file) {
  try { return await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
async function jsonAt(file, fallback = {}) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return fallback; throw error; }
}
function relativeName(value, label = '路径') {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || path.isAbsolute(value) || value.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) throw new Error(`${label}必须是目录内的相对路径`);
  return value;
}
async function confined(root, relative) {
  relativeName(relative);
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  if (!isWithin(base, target)) throw new Error('路径超出允许的目录');
  let cursor = target;
  for (;;) {
    try {
      const resolved = await realpath(cursor);
      if (!isWithin(base, resolved)) throw new Error('符号链接指向了其他目录');
      return target;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (cursor === base) return target;
      cursor = path.dirname(cursor);
    }
  }
}
async function skillsRoot(ctx) {
  const home = await realpath(ctx.home);
  const root = path.join(home, 'skills');
  try { if (!isWithin(home, await realpath(root))) throw new Error('技能目录不能指向用户目录以外'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return root;
}
async function walk(root, callback, { maxFiles = 2000, maxDepth = 12 } = {}) {
  let count = 0;
  async function visit(dir, depth) {
    if (depth > maxDepth || count >= maxFiles) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const skillRoot = entries.some(e => e.name === 'SKILL.md' && e.isFile());
    for (const entry of entries) {
      if (count >= maxFiles) break;
      if (entry.name.startsWith('.') || EXCLUDED.has(entry.name) || entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && !(skillRoot && SUPPORT.has(entry.name))) await visit(file, depth + 1);
      else if (entry.isFile()) { count++; await callback(file); }
    }
  }
  await visit(root, 0);
}

export function parseFrontmatter(input) {
  const text = String(input).replace(/^\uFEFF/, '');
  const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:[ \t]*\r?\n|[ \t]*$)/);
  if (!match) return { metadata: {}, body: text };
  let metadata = {};
  try { const result = parseYaml(match[1], { maxAliasCount: 30 }); if (result && typeof result === 'object' && !Array.isArray(result)) metadata = result; }
  catch { /* A malformed installed skill remains visible for the user to repair. */ }
  return { metadata, body: text.slice(match[0].length) };
}

export async function scanSkills(ctx, { includeDisabled = false } = {}) {
  const root = await skillsRoot(ctx);
  const config = configuration(ctx);
  const disabled = new Set([...names(config.skills?.disabled), ...names(config.skills?.platform_disabled?.api_server)]);
  const usage = await jsonAt(path.join(root, '.usage.json'));
  const installs = await jsonAt(path.join(root, '.cattuan_installs.json'), []);
  const installMap = new Map((Array.isArray(installs) ? installs : []).map(row => [row.name, row]));
  const result = [];
  await walk(root, async file => {
    if (path.basename(file) !== 'SKILL.md' || (await stat(file)).size > MAX_FILE) return;
    const content = await readFile(file, 'utf8');
    const { metadata } = parseFrontmatter(content);
    const local = path.relative(root, path.dirname(file)).split(path.sep).join('/');
    const parts = local.split('/');
    const name = String(metadata.name || parts.at(-1));
    const category = parts.length > 1 ? parts[0] : '';
    const platforms = metadata.platforms ? [...names(metadata.platforms)] : [];
    const matchesPlatform = !platforms.length || platforms.some(p => process.platform.startsWith(({ macos: 'darwin', windows: 'win32' })[p.toLowerCase()] || p.toLowerCase()));
    const enabled = !disabled.has(name) && !disabled.has(local) && matchesPlatform;
    if (!includeDisabled && !enabled) return;
    const u = usage[name] || {};
    const install = installMap.get(name);
    const agentMade = u.created_by === 'agent' || u.agent_created === true;
    const origin = install ? 'store' : agentMade ? 'agent' : category === 'cattuan' ? 'cattuan' : 'user';
    result.push({ name, description: String(metadata.description || '').slice(0, 1024), category, local_name: local, path: local, dir: path.dirname(file), file, content, metadata, enabled, matchesPlatform, origin, essential: false, lastUsedAt: u.last_used_at || null, createdAt: u.created_at || null, installReason: install?.reason || null, installedAt: install?.at || null, installSource: install?.source || null });
  });
  return result;
}

export async function loadSkill(ctx, name, { includeDisabled = false, filePath } = {}) {
  relativeName(name, '技能名');
  const skill = (await scanSkills(ctx, { includeDisabled })).find(s => s.name === name || s.local_name === name);
  if (!skill) return null;
  if (filePath) {
    const file = await confined(skill.dir, filePath);
    if (!(await stat(file)).isFile() || (await stat(file)).size > MAX_FILE) throw new Error('链接文件不存在或过大');
    return { ...skill, content: await readFile(file, 'utf8') };
  }
  return skill;
}

export async function setSkillEnabled(ctx, name, enabled) {
  const skill = await loadSkill(ctx, name, { includeDisabled: true });
  if (!skill) throw new Error(`没有这个技能：${name}`);
  if (enabled && !skill.matchesPlatform) throw new Error('此技能不支持当前操作系统');
  const file = path.join(ctx.home, 'config.yaml');
  await locked(file, async () => {
    const config = parseYaml(await optionalText(file)) || {};
    config.skills ||= {};
    const disabled = names(config.skills.disabled);
    if (enabled) { disabled.delete(skill.name); disabled.delete(skill.local_name); }
    else disabled.add(skill.name);
    config.skills.disabled = [...disabled].sort();
    if (enabled && config.skills.platform_disabled?.api_server) config.skills.platform_disabled.api_server = [...names(config.skills.platform_disabled.api_server)].filter(n => n !== skill.name && n !== skill.local_name);
    await atomicText(file, stringifyYaml(config));
  });
  return { ok: true, name: skill.name, enabled };
}

export async function deleteSkill(ctx, name) {
  const root = await skillsRoot(ctx);
  return locked(path.join(root, '.knowledge'), async () => {
    const skill = await loadSkill(ctx, name, { includeDisabled: true });
    if (!skill) throw new Error(`没有这个技能：${name}`);
    if (skill.origin === 'cattuan') throw new Error('内置技能不能删，可以停用');
    await confined(root, skill.local_name);
    await rm(skill.dir, { recursive: true });
    return { ok: true, name: skill.name };
  });
}

async function usageUpdate(ctx, name, update) {
  const root = await skillsRoot(ctx);
  const file = path.join(root, '.usage.json');
  await locked(file, async () => {
    const data = await jsonAt(file);
    data[name] = update(data[name] || {});
    await atomicText(file, JSON.stringify(data, null, 2));
  });
}

function memoryOptions(ctx, target) {
  if (!['memory', 'user'].includes(target)) throw new Error('target 只能是 memory 或 user');
  const config = configuration(ctx).memory || {};
  if (config[target === 'user' ? 'user_profile_enabled' : 'memory_enabled'] === false) throw new Error('此记忆目标已停用');
  const configured = Number(config[target === 'user' ? 'user_char_limit' : 'memory_char_limit']);
  const limit = Number.isFinite(configured) && configured >= 0 ? Math.min(100000, Math.floor(configured)) : target === 'user' ? 1375 : 2200;
  return { file: path.join(ctx.home, 'memories', target === 'user' ? 'USER.md' : 'MEMORY.md'), limit };
}
async function memoryTool(ctx, args, signal) {
  const target = args.target || 'memory';
  const { file, limit } = memoryOptions(ctx, target);
  const home = await realpath(ctx.home);
  await confined(home, path.relative(path.resolve(ctx.home), file));
  return locked(file, async () => {
    let entries = (await optionalText(file)).split(DELIMITER).map(s => s.trim()).filter(Boolean);
    const usage = () => `${charLength(entries.join(DELIMITER))}/${limit}`;
    if (args.action === 'read' || args.action === 'list') return { success: true, target, entries, current_entries: entries, usage: usage() };
    const operations = args.operations ?? [args];
    if (!Array.isArray(operations) || !operations.length || operations.length > 50) throw new Error('operations 必须包含 1 至 50 个操作');
    for (const op of operations) {
      if (!op || typeof op !== 'object') throw new Error('每个记忆操作必须是对象');
      const content = String(op.content ?? op.new_text ?? '').trim();
      if (content.includes(DELIMITER) || INJECTION.test(content)) throw new Error('记忆内容包含不允许的分隔符或指令覆盖内容');
      if (op.action === 'add') {
        if (!content) throw new Error('add 需要 content');
        if (!entries.includes(content)) entries.push(content);
      } else if (['patch', 'remove'].includes(op.action)) {
        const old = op.old_text;
        if (typeof old !== 'string' || !old) return { success: false, error: `${op.action} 需要 old_text`, current_entries: entries, usage: usage() };
        const matches = entries.map((entry, i) => entry.includes(old) ? i : -1).filter(i => i >= 0);
        if (matches.length !== 1) return { success: false, error: matches.length ? 'old_text 匹配了多条记忆，请提供更精确的原文' : '没有找到 old_text', current_entries: entries, usage: usage() };
        const index = matches[0];
        if (op.action === 'remove') entries.splice(index, 1);
        else {
          if (!content) throw new Error('patch 需要非空 content，删除整条请用 remove');
          if (entries[index].split(old).length !== 2) throw new Error('old_text 在此条记忆中出现多次，请提供更精确的原文');
          entries[index] = entries[index].replace(old, () => content);
        }
      } else throw new Error('action 只能是 add、patch、remove、read');
    }
    if (charLength(entries.join(DELIMITER)) > limit) return { success: false, error: '记忆已超出字符预算，请先压缩或删除旧记忆', current_entries: (await optionalText(file)).split(DELIMITER).filter(Boolean), usage: `${charLength(entries.join(DELIMITER))}/${limit}` };
    await atomicText(file, entries.join(DELIMITER));
    return { success: true, target, entries, current_entries: entries, usage: usage() };
  }, signal);
}

function validateSkillContent(content) {
  if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > MAX_FILE) throw new Error('技能内容不能为空，且不能超过 256 KiB');
  const { metadata } = parseFrontmatter(content);
  if (!metadata.name || !metadata.description) throw new Error('SKILL.md 必须包含 name 和 description 的 YAML frontmatter');
  if (INJECTION.test(content)) throw new Error('技能内容包含指令覆盖或凭据外传内容');
  return metadata;
}
async function linkedFiles(root) {
  const files = [];
  async function visit(dir, depth = 0) {
    if (depth > 10 || files.length >= 200) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink() || EXCLUDED.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file, depth + 1);
      else if (entry.isFile() && file !== path.join(root, 'SKILL.md')) files.push(path.relative(root, file).split(path.sep).join('/'));
    }
  }
  await visit(root);
  return files;
}
async function manageSkills(ctx, args, signal) {
  const operations = args.operations ?? [args];
  if (!Array.isArray(operations) || !operations.length || operations.length > 30) throw new Error('operations 必须包含 1 至 30 个操作');
  const root = await skillsRoot(ctx);
  return locked(path.join(root, '.knowledge'), async () => {
    // Validate and stage the complete batch before making any file changes.
    const skills = await scanSkills(ctx, { includeDisabled: true });
    const staged = new Map();
    const deleted = new Set();
    const created = new Set();
    const results = [];
    for (const op of operations) {
      signal?.throwIfAborted();
      if (!op || typeof op !== 'object') throw new Error('每个技能操作必须是对象');
      relativeName(op.name, '技能名');
      let skill = skills.find(s => [s.name, s.local_name].includes(op.name));
      let relative = skill?.local_name || (op.category ? `${relativeName(op.category, '分类')}/${op.name}` : op.name);
      if (op.action === 'create') {
        if (!relative.split('/').every(p => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(p))) throw new Error('技能目录名只能使用小写字母、数字、短横线和下划线');
        if (skill || created.has(relative)) throw new Error(`技能已存在：${op.name}`);
        const metadata = validateSkillContent(op.content);
        if (skills.some(s => s.name === String(metadata.name))) throw new Error('技能名称已被其他目录使用');
        skill = { name: String(metadata.name), local_name: relative, dir: await confined(root, relative), origin: 'agent' };
        try { await lstat(skill.dir); throw new Error('目标目录已经存在'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        skills.push(skill); created.add(relative);
        staged.set(path.join(skill.dir, 'SKILL.md'), op.content);
      } else {
        if (!skill || deleted.has(skill.local_name)) throw new Error(`技能不存在：${op.name}`);
        relative = skill.local_name;
        await confined(root, relative);
        if (op.action === 'delete') {
          if (skill.origin === 'cattuan') throw new Error('内置技能不能删除，可以停用');
          deleted.add(relative);
        } else {
          const support = ['write_file', 'remove_file'].includes(op.action);
          const filename = op.file_path || 'SKILL.md';
          if (support && (!op.file_path || filename === 'SKILL.md')) throw new Error('支持文件操作需要 file_path，修改主文件请用 edit 或 patch');
          const file = await confined(skill.dir, filename);
          if (op.action === 'write_file') {
            if (typeof op.file_content !== 'string' || Buffer.byteLength(op.file_content) > MAX_FILE || INJECTION.test(op.file_content)) throw new Error('file_content 无效、过大或包含不安全指令');
            staged.set(file, op.file_content);
          } else if (op.action === 'remove_file') {
            if (!staged.has(file) && !(await stat(file)).isFile()) throw new Error('支持文件不存在');
            staged.set(file, null);
          } else if (op.action === 'edit' || (op.action === 'patch' && op.content != null)) {
            if (filename !== 'SKILL.md') throw new Error('edit 只修改 SKILL.md');
            validateSkillContent(op.content); staged.set(file, op.content);
          } else if (op.action === 'patch') {
            if (typeof op.old_string !== 'string' || !op.old_string || typeof op.new_string !== 'string') throw new Error('patch 需要 old_string 和 new_string');
            const old = staged.has(file) ? staged.get(file) : await readFile(file, 'utf8');
            if (old == null || !old.includes(op.old_string)) throw new Error('没有找到 old_string');
            if (!op.replace_all && old.split(op.old_string).length !== 2) throw new Error('old_string 出现多次，需要精确匹配或 replace_all=true');
            const content = op.replace_all ? old.split(op.old_string).join(op.new_string) : old.replace(op.old_string, () => op.new_string);
            if (filename === 'SKILL.md') validateSkillContent(content);
            if (Buffer.byteLength(content) > MAX_FILE || INJECTION.test(content)) throw new Error('修改后文件过大或包含不安全指令');
            staged.set(file, content);
          } else throw new Error(`未知技能操作：${op.action}`);
        }
      }
      results.push({ success: true, action: op.action, name: skill.name });
    }
    for (const [file, content] of staged) {
      if ([...deleted].some(relative => isWithin(path.join(root, relative), file))) continue;
      await confined(root, path.relative(root, file));
      if (content === null) await rm(file, { force: true });
      else await atomicText(file, content);
    }
    for (const relative of deleted) await rm(await confined(root, relative), { recursive: true, force: true });
    for (const skill of skills.filter(s => created.has(s.local_name) && !deleted.has(s.local_name))) await usageUpdate(ctx, skill.name, u => ({ ...u, created_by: 'agent', agent_created: true, created_at: new Date().toISOString(), created_session_id: ctx.sessionId }));
    return { success: true, results };
  }, signal);
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  return Array.isArray(message?.content) ? message.content.filter(p => p?.type === 'text').map(p => p.text || '').join('\n') : '';
}
async function sessionSearch(ctx, args) {
  const query = String(args.query || '').trim().toLocaleLowerCase();
  const wanted = String(args.session_id || '').trim();
  const limit = Math.max(1, Math.min(20, Number(args.limit) || 3));
  const files = [];
  const root = path.join(ctx.home, 'pi', 'sessions');
  await confined(await realpath(ctx.home), 'pi/sessions');
  await walk(root, async file => { if (file.endsWith('.jsonl')) files.push({ file, mtime: (await stat(file)).mtimeMs }); }, { maxFiles: 5000 });
  files.sort((a, b) => b.mtime - a.mtime);
  const sessions = [];
  for (const { file } of files) {
    if (sessions.length >= limit) break;
    if ((await stat(file)).size > 16 * 1024 * 1024) continue;
    let rows;
    try { rows = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { continue; }
    const header = rows.find(row => row.type === 'session') || {};
    const sessionId = header.id || path.basename(file, '.jsonl');
    const taskId = (await jsonAt(path.join(path.dirname(file), 'task.json'))).task_session_id;
    if (wanted ? ![sessionId, taskId].includes(wanted) : taskId === ctx.sessionId || sessionId === ctx.sessionId) continue;
    const messages = rows.filter(row => row.type === 'message' && ['user', 'assistant'].includes(row.message?.role) && (!args.role_filter || row.message.role === args.role_filter)).map(row => ({ id: row.id, role: row.message.role, content: messageText(row.message) })).filter(m => m.content);
    const matching = query ? messages.filter(m => m.content.toLocaleLowerCase().includes(query)) : messages;
    if (!matching.length) continue;
    const selected = wanted ? messages.length > 20 ? [...messages.slice(0, 10), ...messages.slice(-10)] : messages : matching.slice(0, 4);
    sessions.push({ session_id: sessionId, task_session_id: taskId || null, when: header.timestamp, messages: selected.map(m => ({ ...m, content: m.content.slice(0, 4000) })) });
  }
  return { success: true, sessions };
}

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.subarray(0, 6).toString().match(/^GIF8[79]a$/)) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw new Error('只支持 PNG、JPEG、GIF 或 WebP 图片');
}
async function visionAnalyze(ctx, args, signal) {
  const source = String(args.image_url || '');
  let bytes;
  if (source.startsWith('data:')) {
    if (source.length > Math.ceil(MAX_IMAGE * 1.4)) throw new Error('图片不能超过 10 MiB');
    const match = source.match(/^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/=\r\n]+)$/);
    if (!match) throw new Error('data URL 必须为支持图片格式的 base64');
    bytes = Buffer.from(match[1], 'base64');
  } else if (/^https:\/\//i.test(source)) {
    const response = await fetchPublic(source, { signal, maxBytes: MAX_IMAGE, binary: true });
    if (response.status !== 200) throw new Error(`图片下载失败：HTTP ${response.status}`);
    bytes = Buffer.from(response.bytes);
  } else {
    if (/^[a-z]+:\/\//i.test(source) && !source.startsWith('file://')) throw new Error('远程图片只支持公开 HTTPS 地址');
    const file = await realpath(source.startsWith('file://') ? new URL(source) : path.resolve(source));
    const roots = [await realpath(ctx.home), path.resolve(ctx.home, '..', 'uploads')];
    if (ctx.uploadDir) roots.push(path.resolve(ctx.uploadDir));
    if (path.resolve(ctx.home) === path.resolve(ctx.root, 'agent-home')) roots.push(path.resolve(ctx.dataDir || path.join(ctx.root, 'app/data'), 'uploads'));
    const sites = path.join(ctx.home, 'sites');
    try { for (const entry of await readdir(sites, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink() && /^[a-zA-Z0-9_-]+$/.test(entry.name)) roots.push(path.resolve(ctx.root, 'sandbox/shots', entry.name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const resolvedRoots = [];
    for (const root of roots) { try { resolvedRoots.push(await realpath(root)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    if (!resolvedRoots.some(root => isWithin(root, file))) throw new Error('只能读取此用户上传的图片、自己的文件或网站检查截图');
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_IMAGE) throw new Error('图片不存在或超过 10 MiB');
    bytes = await readFile(file);
  }
  signal?.throwIfAborted();
  if (!bytes.length || bytes.length > MAX_IMAGE) throw new Error('图片为空或超过 10 MiB');
  const mimeType = imageType(bytes);
  let question = String(args.question || '请分析这张图片。').slice(0, 4000);
  if (args.region) {
    const r = args.region;
    if (![r.x, r.y, r.width, r.height].every(v => typeof v === 'number' && Number.isFinite(v)) || r.x < 0 || r.y < 0 || r.width <= 0 || r.height <= 0) throw new Error('region 需要有效的 x、y、width、height');
    question += `\n请重点观察区域 x=${r.x}, y=${r.y}, width=${r.width}, height=${r.height}。提供的是完整原图。`;
  }
  return { content: [{ type: 'text', text: question }, { type: 'image', data: bytes.toString('base64'), mimeType }], details: { success: true, native_image: true, mime_type: mimeType } };
}

async function logInstall(ctx, skill, identifier, source, reason) {
  const file = path.join(await skillsRoot(ctx), '.cattuan_installs.json');
  await locked(file, async () => {
    const prior = await jsonAt(file, []);
    const entries = (Array.isArray(prior) ? prior : []).filter(entry => entry.name !== skill.name);
    entries.push({ name: skill.name, identifier, source, reason: reason.slice(0, 120), at: new Date().toISOString() });
    await atomicText(file, JSON.stringify(entries, null, 2));
  });
}
async function publicJson(url, signal) {
  const response = await fetchPublic(url, { signal, maxBytes: 2 * 1024 * 1024 });
  if (response.status !== 200) throw new Error(`技能库返回 HTTP ${response.status}`);
  return JSON.parse(response.text);
}
async function storeTool(ctx, args, signal) {
  const root = await skillsRoot(ctx);
  if (args.action === 'list') return { installed: await jsonAt(path.join(root, '.cattuan_installs.json'), []) };
  if (args.action === 'search') {
    const query = String(args.query || '').trim().slice(0, 200);
    if (!query) throw new Error('search 需要 query');
    const words = query.toLowerCase().split(/[\s,，、]+/).filter(Boolean);
    const local = (await scanSkills(ctx, { includeDisabled: true })).filter(s => !s.enabled && s.matchesPlatform && words.some(w => `${s.name} ${s.description}`.toLowerCase().includes(w))).map(s => ({ identifier: `local/${s.name}`, name: s.name, description: s.description.slice(0, 160), source: '本地内置', needs_terminal: TERMINAL.test(s.content) }));
    let online = [], warning;
    try {
      const payload = await publicJson(`https://skills.sh/api/search?q=${encodeURIComponent(query)}&limit=8`, signal);
      const rows = Array.isArray(payload) ? payload : payload.skills || payload.results || [];
      online = rows.slice(0, 8).flatMap(row => {
        const source = row.source || row.repo || '';
        const name = row.skillId || row.name || String(row.id || '').split('/').at(-1);
        if (!/^[\w.-]+\/[\w.-]+$/.test(source) || !/^[a-zA-Z0-9_-]+$/.test(name || '')) return [];
        return [{ identifier: `github/${source}/${name}`, name, description: String(row.description || '').slice(0, 160), source: 'skills.sh', installs: row.installs || null, needs_terminal: null }];
      });
    } catch { warning = '在线技能库暂时不可用，本地结果仍可使用'; }
    return { results: [...local, ...online].slice(0, 10), ...(warning ? { warning } : {}) };
  }
  if (args.action !== 'install') throw new Error('action 只能是 search、install 或 list');
  const identifier = String(args.identifier || '').trim();
  const reason = String(args.reason || '').trim();
  if (!identifier || !reason) throw new Error('install 需要 identifier 和当前任务相关的 reason');
  if (identifier.startsWith('local/')) {
    const skill = await loadSkill(ctx, identifier.slice(6), { includeDisabled: true });
    if (!skill) throw new Error('本地没有这个技能');
    if (TERMINAL.test(skill.content)) throw new Error('此技能需要终端命令，当前工具环境无法执行');
    validateSkillContent(skill.content);
    await setSkillEnabled(ctx, skill.name, true);
    await logInstall(ctx, skill, identifier, '本地内置', reason);
    return { ok: true, installed: [skill.name], needs_terminal: false, content: skill.content.slice(0, 12000) };
  }
  const match = identifier.match(/^github\/([\w.-]+)\/([\w.-]+)\/([a-zA-Z0-9_-]+)$/);
  if (!match) throw new Error('在线 identifier 必须来自 search：github/owner/repo/skill-name');
  const [, owner, repo, requested] = match;
  const tree = await publicJson(`https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`, signal);
  const files = (tree.tree || []).filter(f => f.type === 'blob' && typeof f.path === 'string');
  const candidate = files.find(f => path.posix.basename(f.path) === 'SKILL.md' && path.posix.basename(path.posix.dirname(f.path)) === requested) || (requested.toLowerCase() === repo.toLowerCase() ? files.find(f => f.path === 'SKILL.md') : null);
  if (!candidate || candidate.size > MAX_FILE) throw new Error('没有找到可安装的 SKILL.md');
  const prefix = path.posix.dirname(candidate.path);
  const packageFiles = files.filter(f => (prefix === '.' ? !f.path.includes('/') || /^(references|templates|assets)\//.test(f.path) : f.path.startsWith(prefix + '/')) && /\.(?:md|txt|json|ya?ml|csv)$/i.test(f.path));
  if (packageFiles.length > 50 || packageFiles.reduce((sum, f) => sum + (f.size || 0), 0) > 1024 * 1024) throw new Error('技能文件数量或总大小超出安装限制');
  const downloaded = new Map();
  for (const entry of packageFiles) {
    const relative = prefix === '.' ? entry.path : entry.path.slice(prefix.length + 1);
    relativeName(relative);
    if (entry.size > MAX_FILE) throw new Error('技能文件过大');
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${tree.sha}/${entry.path.split('/').map(encodeURIComponent).join('/')}`;
    const response = await fetchPublic(url, { signal, maxBytes: MAX_FILE });
    if (response.status !== 200) throw new Error(`无法下载技能文件：${relative}`);
    if (INJECTION.test(response.text) || TERMINAL.test(response.text)) throw new Error('此技能包含终端命令、指令覆盖或凭据外传内容，未安装');
    downloaded.set(relative, response.text);
  }
  const content = downloaded.get('SKILL.md');
  const metadata = validateSkillContent(content);
  if (String(metadata.name) !== requested) throw new Error('技能名称与搜索结果不一致');
  if ((await scanSkills(ctx, { includeDisabled: true })).some(s => s.name === requested)) throw new Error('同名技能已经存在，请直接加载或启用');
  const destination = await confined(root, `store/${requested}`);
  await locked(path.join(root, '.knowledge'), async () => {
    try { await lstat(destination); throw new Error('同名技能目录已经存在'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const staging = path.join(root, `.install-${randomUUID()}`);
    try {
      await mkdir(staging, { recursive: true });
      for (const [relative, text] of downloaded) await atomicText(path.join(staging, relative), text);
      await mkdir(path.dirname(destination), { recursive: true });
      await rename(staging, destination);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }, signal);
  await logInstall(ctx, { name: requested }, identifier, '在线技能库', reason);
  return { ok: true, installed: [requested], needs_terminal: false, content: content.slice(0, 12000) };
}

function spec(name, toolset, description, properties, required, execute) {
  return { name, toolset, description, parameters: { type: 'object', properties, ...(required?.length ? { required } : {}) }, execute: async (args = {}, signal) => { try { return await execute(args, signal); } catch (error) { if (signal?.aborted) throw error; return errorResult(error); } } };
}
const string = { type: 'string' };
export function createKnowledgeTools(ctx) {
  return [
    spec('memory', 'memory', '管理此用户的长期记忆或用户资料。add 增加，patch 精确替换 old_text，remove 删除匹配整条；可传 operations 原子校验批量修改。', { action: { type: 'string', enum: ['add', 'patch', 'remove', 'read'] }, target: { type: 'string', enum: ['memory', 'user'] }, content: string, old_text: string, operations: { type: 'array', items: { type: 'object', properties: { action: { type: 'string', enum: ['add', 'patch', 'remove'] }, content: string, old_text: string }, required: ['action'] } } }, [], (args, signal) => memoryTool(ctx, args, signal)),
    spec('skills_list', 'skills', '列出此用户已经启用且支持当前平台的技能。', { category: string }, [], async args => { const skills = (await scanSkills(ctx)).filter(s => !args.category || s.category === args.category).map(({ name, description, category }) => ({ name, description, category: category || null })); return { success: true, skills, count: skills.length, categories: [...new Set(skills.map(s => s.category).filter(Boolean))].sort() }; }),
    spec('skill_view', 'skills', '读取已启用技能的 SKILL.md 或该技能内的链接文件，执行相关任务前先加载技能。', { name: string, file_path: string }, ['name'], async args => { const skill = await loadSkill(ctx, args.name, { filePath: args.file_path }); if (!skill) throw new Error(`技能不存在、未启用或不支持当前平台：${args.name}`); await usageUpdate(ctx, skill.name, u => ({ ...u, views: (Number(u.views) || 0) + 1, uses: (Number(u.uses) || 0) + 1, last_used_at: new Date().toISOString(), last_session_id: ctx.sessionId })); return { success: true, name: skill.name, description: skill.description, content: skill.content, path: skill.local_name, linked_files: await linkedFiles(skill.dir) }; }),
    spec('skill_manage', 'skills', '仅在此用户技能目录内创建、修改、删除技能与文本支持文件。支持 operations 批量操作，不执行脚本。', { operations: { type: 'array', items: { type: 'object', properties: { action: { type: 'string', enum: ['create', 'edit', 'patch', 'write_file', 'remove_file', 'delete'] }, name: string, category: string, content: string, file_path: string, file_content: string, old_string: string, new_string: string, replace_all: { type: 'boolean' } }, required: ['name', 'action'] } }, action: string, name: string, content: string, file_path: string, file_content: string, old_string: string, new_string: string, category: string, replace_all: { type: 'boolean' } }, [], (args, signal) => manageSkills(ctx, args, signal)),
    spec('session_search', 'session_search', '搜索或读取此用户以前的聊天记录。有 query 时搜索，有 session_id 时读取会话，不带参数时列最近会话。', { query: string, session_id: string, limit: { type: 'integer', minimum: 1, maximum: 20 }, role_filter: { type: 'string', enum: ['user', 'assistant'] } }, [], args => sessionSearch(ctx, args)),
    spec('vision_analyze', 'vision', '把图片作为原生图像交给当前 Pi 模型分析。支持自己的文件、上传、站点截图、公开 HTTPS 图片及 base64 data URL；region 指定重点观察区域，返回完整原图。', { image_url: string, question: string, region: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } }, required: ['x', 'y', 'width', 'height'] } }, ['image_url'], (args, signal) => visionAnalyze(ctx, args, signal)),
    spec('skill_store', 'skillstore', '按需寻找并安装直接服务当前任务的技能。search 搜索本地停用技能和 skills.sh；install 需要搜索结果 identifier 和 reason。安装仅下载受限文本包并检查，不执行命令。list 查看安装记录。', { action: { type: 'string', enum: ['search', 'install', 'list'] }, query: string, identifier: string, reason: string }, ['action'], (args, signal) => storeTool(ctx, args, signal)),
  ];
}

export async function knowledgeContext(ctx) {
  const config = configuration(ctx);
  const blocks = [];
  for (const target of ['memory', 'user']) {
    try {
      const { file, limit } = memoryOptions(ctx, target);
      await confined(await realpath(ctx.home), path.relative(ctx.home, file));
      const content = [...await optionalText(file)].slice(0, limit).join('').trim();
      if (content) blocks.push(`${target === 'user' ? 'USER PROFILE (who the user is)' : 'MEMORY (your personal notes)'}:\n${content}`);
    } catch (error) { if (!String(error.message).includes('已停用')) throw error; }
  }
  const disabled = new Set([...names(config.agent?.disabled_tools), ...names(config.agent?.disabled_toolsets), ...names(config.tools?.api_server?.disabled)]);
  const enabled = config.platform_toolsets?.api_server;
  if (![...disabled].some(n => ['skills', 'skill_view'].includes(n)) && (enabled == null || names(enabled).has('skills'))) {
    const skills = await scanSkills(ctx);
    if (skills.length) blocks.push('可用技能（先用 skill_view 加载与当前任务相关的技能）：\n' + skills.map(s => `- ${s.name}: ${s.description}`).join('\n'));
  }
  return blocks.join('\n\n');
}
