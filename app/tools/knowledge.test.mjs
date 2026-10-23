import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createKnowledgeTools, knowledgeContext } from './knowledge.mjs';
import { createToolContext } from '../pi-tools.mjs';
import { readConfig } from './common.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cattuan-knowledge-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, root: home, config: () => readConfig(home), sessionId: 'task-t_knowledge' };
}
const invoke = (ctx, name, args) => createKnowledgeTools(ctx).find(tool => tool.name === name).execute(args);
const markdown = name => `---\nname: ${name}\ndescription: Helpful instructions\n---\nRead the supplied information.\n`;

test('memory updates validate entire batches, respect limits and block linked files', async t => {
  const ctx = fixture(t), other = fixture(t);
  assert.equal((await invoke(ctx, 'memory', { action: 'add', content: 'Keep this fact.' })).success, true);
  const file = path.join(ctx.home, 'memories/MEMORY.md');
  const before = fs.readFileSync(file, 'utf8');
  assert.equal((await invoke(ctx, 'memory', { operations: [{ action: 'add', content: 'Transient.' }, { action: 'remove', old_text: 'not present' }] })).success, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  fs.writeFileSync(path.join(ctx.home, 'config.yaml'), 'memory:\n  memory_char_limit: 20\n  user_profile_enabled: false\n');
  assert.equal((await invoke(ctx, 'memory', { action: 'add', content: 'This will exceed the budget.' })).success, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  fs.mkdirSync(path.join(other.home, 'memories'));
  fs.symlinkSync(file, path.join(other.home, 'memories/MEMORY.md'));
  assert.equal((await invoke(other, 'memory', { action: 'read' })).success, false);
  assert.equal((await invoke(ctx, 'memory', { target: 'user', action: 'add', content: 'disabled' })).success, false);
});

test('skill changes remain scoped, keep built-ins and exclude disabled context', async t => {
  const ctx = fixture(t);
  assert.equal((await invoke(ctx, 'skill_manage', { action: 'create', name: 'my-skill', content: markdown('my-skill') })).success, true);
  const file = path.join(ctx.home, 'skills/my-skill/SKILL.md');
  const before = fs.readFileSync(file, 'utf8');
  const changed = await invoke(ctx, 'skill_manage', { operations: [
    { action: 'patch', name: 'my-skill', old_string: 'Read the supplied information.', new_string: 'Updated.' },
    { action: 'write_file', name: 'my-skill', file_path: '../../outside.md', file_content: 'bad' },
  ] });
  assert.equal(changed.success, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  fs.mkdirSync(path.join(ctx.home, 'skills/cattuan/builtin'), { recursive: true });
  fs.writeFileSync(path.join(ctx.home, 'skills/cattuan/builtin/SKILL.md'), markdown('builtin'));
  assert.equal((await invoke(ctx, 'skill_manage', { action: 'delete', name: 'builtin' })).success, false);
  fs.writeFileSync(path.join(ctx.home, 'config.yaml'), 'skills:\n  disabled: [my-skill]\n');
  assert.doesNotMatch(await knowledgeContext(ctx), /my-skill/);
  assert.equal((await invoke(ctx, 'skill_view', { name: 'my-skill' })).success, false);
  assert.equal((await invoke(ctx, 'skill_view', { name: 'builtin', file_path: '../../../config.yaml' })).success, false);
});

test('adopted administrator can view their uploads while other accounts stay isolated', async t => {
  const fixtureCtx = fixture(t), root = fixtureCtx.home;
  const home = path.join(root, 'agent-home'), dataDir = path.join(root, 'app/data');
  fs.mkdirSync(home);
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'app.db'));
  db.exec('CREATE TABLE users (id TEXT, agent_home TEXT)');
  db.prepare('INSERT INTO users VALUES (?,?)').run('admin', 'agent-home');
  db.prepare('INSERT INTO users VALUES (?,?)').run('other', null);
  db.close();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP8z4AdMOEQH6QSAM1BAQ/oQeJvAAAAAElFTkSuQmCC', 'base64');
  for (const id of ['admin', 'other']) {
    const dir = path.join(dataDir, 'users', id, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'image.png'), png);
  }
  const ctx = createToolContext({ home, root, env: { CATTUAN_DATA_DIR: dataDir } });
  const own = await invoke(ctx, 'vision_analyze', { image_url: path.join(dataDir, 'users/admin/uploads/image.png') });
  assert.equal(own.content[1].mimeType, 'image/png');
  assert.equal((await invoke(ctx, 'vision_analyze', { image_url: path.join(dataDir, 'users/other/uploads/image.png') })).success, false);
});
