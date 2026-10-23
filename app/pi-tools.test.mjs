import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createPiTools, createToolContext } from './pi-tools.mjs';

const CONFIG = `platform_toolsets:\n  api_server: [skills, memory, session_search, vision, testing]\nskills:\n  disabled: [hidden-skill]\nmemory:\n  memory_enabled: true\n  user_profile_enabled: false\n`;

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cattuan-pi-tools-'));
  fs.writeFileSync(path.join(home, 'config.yaml'), CONFIG);
  for (const name of ['test-skill', 'hidden-skill']) {
    fs.mkdirSync(path.join(home, 'skills', name, 'references'), { recursive: true });
    fs.writeFileSync(path.join(home, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} description\n---\nA complete instruction.\n`);
    fs.writeFileSync(path.join(home, 'skills', name, 'references/example.md'), 'Linked reference.');
  }
  fs.mkdirSync(path.join(home, 'memories'));
  fs.writeFileSync(path.join(home, 'memories/MEMORY.md'), 'Durable environment fact.');
  fs.writeFileSync(path.join(home, 'memories/USER.md'), 'Disabled profile fact.');
  return home;
}

const parsed = (result) => JSON.parse(result.content.find((part) => part.type === 'text').text);
const invoke = (bridge, name, args = {}, signal) => bridge.tools.find((t) => t.name === name).execute('test-call', args, signal);

test('native Pi tools preserve skills, memory policy and task history', async (t) => {
  const home = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bridge = await createPiTools({ home, sessionId: 'task-t_testbridge' });
  t.after(() => bridge.close());

  assert.match(bridge.systemPrompt, /Durable environment fact/);
  assert.match(bridge.systemPrompt, /test-skill/);
  assert.doesNotMatch(bridge.systemPrompt, /Disabled profile fact|hidden-skill/);
  const skills = parsed(await invoke(bridge, 'skills_list'));
  assert.deepEqual(skills.skills.map((s) => s.name), ['test-skill']);
  assert.match(parsed(await invoke(bridge, 'skill_view', { name: 'test-skill' })).content, /complete instruction/);
  assert.equal(parsed(await invoke(bridge, 'skill_view', { name: 'test-skill', file_path: 'references/example.md' })).content, 'Linked reference.');
  assert.equal(parsed(await invoke(bridge, 'skill_view', { name: 'test-skill', file_path: '../../config.yaml' })).success, false);
  assert.equal(parsed(await invoke(bridge, 'skill_view', { name: 'hidden-skill' })).success, false);
  const usage = JSON.parse(fs.readFileSync(path.join(home, 'skills/.usage.json'), 'utf8'));
  assert.ok(usage['test-skill'].last_used_at);
  const managed = parsed(await invoke(bridge, 'skill_manage', { operations: [{
    action: 'write_file', name: 'test-skill', file_path: 'references/research.md', file_content: 'New research notes.',
  }] }));
  assert.equal(managed.success, true, JSON.stringify(managed));
  assert.equal(fs.readFileSync(path.join(home, 'skills/test-skill/references/research.md'), 'utf8'), 'New research notes.');

  const saved = parsed(await invoke(bridge, 'memory', { action: 'add', target: 'memory', content: 'The user prefers concise replies.' }));
  assert.equal(saved.success, true, JSON.stringify(saved));
  assert.match(fs.readFileSync(path.join(home, 'memories/MEMORY.md'), 'utf8'), /prefers concise replies/);
  assert.equal(parsed(await invoke(bridge, 'memory', { action: 'add', target: 'user', content: 'Must remain disabled.' })).success, false);

  const sessionDir = path.join(home, 'pi/sessions/previous-task');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'task.json'), JSON.stringify({ task_session_id: 'task-t_previous' }));
  fs.writeFileSync(path.join(sessionDir, 'previous.jsonl'), [
    { type: 'session', id: 'pi-previous', timestamp: '2026-10-22T01:00:00Z' },
    { type: 'message', id: 'm1', message: { role: 'user', content: [{ type: 'text', text: 'Previously discussed Hangzhou travel.' }] } },
  ].map((row) => JSON.stringify(row)).join('\n'));
  const history = parsed(await invoke(bridge, 'session_search', { query: 'Hangzhou' }));
  assert.equal(history.sessions[0].task_session_id, 'task-t_previous');
  assert.match(parsed(await invoke(bridge, 'session_search', { session_id: 'task-t_previous' })).sessions[0].messages[0].content, /Hangzhou/);

  fs.writeFileSync(path.join(home, 'config.yaml'), CONFIG + 'agent:\n  disabled_tools: [session_search]\n');
  await assert.rejects(invoke(bridge, 'session_search', { query: 'Hangzhou' }), /unavailable or disabled/);
});

test('native network tools propagate cancellation and keep later calls usable', async (t) => {
  const home = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, 'config.yaml'), 'platform_toolsets:\n  api_server: [deepsearch, skills]\n');
  let entered;
  const requested = new Promise(resolve => { entered = resolve; });
  const server = http.createServer((_req, _res) => entered());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const bridge = await createPiTools({ home, sessionId: 'task-t_abort', env: { CATTUAN_SANDBOX_URL: 'http://127.0.0.1:' + server.address().port } });
  t.after(() => bridge.close());
  const controller = new AbortController();
  const pending = invoke(bridge, 'deep_web_search', { query: 'test' }, controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await requested;
  controller.abort();
  await rejected;
  assert.ok(Array.isArray(parsed(await invoke(bridge, 'skills_list')).skills));
  bridge.close();
  await assert.rejects(invoke(bridge, 'skills_list'), { name: 'AbortError' });
});

test('tool credentials come only from the selected home', (t) => {
  const home = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { API_SERVER_KEY: 'other-user-key', API_SERVER_PORT: '9999', LONGCAT_API_KEY: 'shared-model-key' };
  assert.equal(createToolContext({ home, env }).env.API_SERVER_KEY, undefined);
  fs.writeFileSync(path.join(home, '.env'), 'API_SERVER_KEY=own-key\nAPI_SERVER_PORT=8701\n');
  const ctx = createToolContext({ home, env, sessionId: 'task-t_own' });
  assert.equal(ctx.env.API_SERVER_KEY, 'own-key');
  assert.equal(ctx.env.API_SERVER_PORT, '8701');
  assert.equal(ctx.env.LONGCAT_API_KEY, 'shared-model-key');
  assert.equal(ctx.sessionId, 'task-t_own');
});

test('native vision returns Pi image content and refuses other users files', async (t) => {
  const home = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const image = path.join(home, 'tiny.png');
  fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP8z4AdMOEQH6QSAM1BAQ/oQeJvAAAAAElFTkSuQmCC', 'base64'));
  const bridge = await createPiTools({ home, sessionId: 'task-t_visionbridge' });
  t.after(() => bridge.close());
  const viewed = await invoke(bridge, 'vision_analyze', { image_url: image, question: 'Describe the image.' });
  assert.ok(viewed.content.some((part) => part.type === 'image' && part.mimeType === 'image/png'), JSON.stringify(viewed));
  assert.equal(parsed(await invoke(bridge, 'vision_analyze', { image_url: '/private/tmp/another-users-image.png', question: 'Read' })).success, false);
});
