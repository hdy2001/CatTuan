import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createTools, createToolContext } from './tools.mjs';
import { readEnv } from '../tools/common.mjs';

const CONFIG = `toolsets: [skills, memory, session_search, vision, testing]\nskills:\n  disabled: [hidden-skill]\nmemory:\n  memory_enabled: true\n  user_profile_enabled: false\n`;

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

test('tools follow the toolset switches, skills and memory policy, and see earlier sessions', async (t) => {
  const home = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bridge = await createTools({ home, sessionId: 'task-t_testbridge' });
  t.after(() => bridge.close());

  assert.deepEqual(bridge.tools.map((x) => x.name).sort(), ['attach', 'memory', 'session_search', 'skill_manage', 'skill_store', 'skill_view', 'skills_list', 'vision_analyze']);
  assert.equal(bridge.tools.find((x) => x.name === 'memory').label, '翻记忆');
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

  // 主 agent 的聊天会话和子 agent 的任务会话在同一个目录，都能翻到
  const sessionDir = path.join(home, 'pi/sessions/previous-chat');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'task.json'), JSON.stringify({ task_session_id: 'chat-c_previous' }));
  fs.writeFileSync(path.join(sessionDir, 'previous.jsonl'), [
    { type: 'session', id: 'pi-previous', timestamp: '2026-10-22T01:00:00Z' },
    { type: 'message', id: 'm1', message: { role: 'user', content: [{ type: 'text', text: 'Previously discussed Hangzhou travel.' }] } },
  ].map((row) => JSON.stringify(row)).join('\n'));
  const history = parsed(await invoke(bridge, 'session_search', { query: 'Hangzhou' }));
  assert.equal(history.sessions[0].task_session_id, 'chat-c_previous');
  assert.match(parsed(await invoke(bridge, 'session_search', { session_id: 'chat-c_previous' })).sessions[0].messages[0].content, /Hangzhou/);

  fs.writeFileSync(path.join(home, 'config.yaml'), `${CONFIG}disabled_tools: [session_search]\n`);
  await assert.rejects(invoke(bridge, 'session_search', { query: 'Hangzhou' }), /unavailable or disabled/);
});

test('a profile can leave out a toolset, and attachments stay out of the model text', async (t) => {
  const home = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, 'config.yaml'), 'toolsets: [phone, memory]\n');
  const calls = [];
  const services = { phone: async (args, { progress }) => { calls.push(args); progress({ type: 'call', call: { stage: 'dialing' } }); return { dialed: true, summary: '问到了', attachments: [{ type: 'calls', calls: [{ id: 'c_1' }] }] }; } };
  const worker = await createTools({ home, sessionId: 'task-t_phone', taskId: 't_phone', services });
  const main = await createTools({ home, sessionId: 'chat-c_1', services }, { exclude: ['phone'] });
  t.after(() => { worker.close(); main.close(); });
  assert.ok(worker.tools.some((x) => x.name === 'phone_call'));
  assert.ok(!main.tools.some((x) => x.name === 'phone_call'));
  const updates = [];
  const out = await worker.tools.find((x) => x.name === 'phone_call').execute('id', { to: '010-1', name: '店', goal: '问问', mode: 'ask' }, undefined, (u) => updates.push(u));
  assert.deepEqual(JSON.parse(out.content[0].text), { dialed: true, summary: '问到了' });
  assert.deepEqual(out.details.attachments, [{ type: 'calls', calls: [{ id: 'c_1' }] }]);
  assert.deepEqual(updates, [{ content: [], details: { type: 'call', call: { stage: 'dialing' } } }]);
  assert.equal(calls.length, 1);
});

test('network tools propagate cancellation and keep later calls usable', async (t) => {
  const home = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, 'config.yaml'), 'toolsets: [web, skills]\n');
  let entered;
  const requested = new Promise(resolve => { entered = resolve; });
  const server = http.createServer((_req, _res) => entered());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const hanging = 'http://127.0.0.1:' + server.address().port;
  const bridge = await createTools({ home, sessionId: 'task-t_abort', env: { CATTUAN_SANDBOX_URL: hanging, DDGS_URL: hanging } });
  t.after(() => bridge.close());
  const controller = new AbortController();
  const pending = invoke(bridge, 'web_search', { query: 'test' }, controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await requested;
  controller.abort();
  await rejected;
  assert.ok(Array.isArray(parsed(await invoke(bridge, 'skills_list')).skills));
  bridge.close();
  await assert.rejects(invoke(bridge, 'skills_list'), { name: 'AbortError' });
});

test('tool environment adds the home .env, and dotenv parsing keeps quoted values', (t) => {
  const home = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, '.env'), '# note\nexport OWN_KEY="test#key"\nPI_MODEL=local-model # note\nLONGCAT_API_KEY=\n');
  assert.deepEqual(readEnv(path.join(home, '.env')), { OWN_KEY: 'test#key', PI_MODEL: 'local-model', LONGCAT_API_KEY: '' });
  assert.deepEqual(readEnv(path.join(home, 'missing')), {});
  const ctx = createToolContext({ home, env: { SHARED: 'shared' }, sessionId: 'task-t_own', taskId: 't_own', user: { id: 'u_1', dir: '/data/users/u_1' } });
  assert.equal(ctx.env.OWN_KEY, 'test#key');
  assert.equal(ctx.env.SHARED, 'shared');
  assert.equal(ctx.taskId, 't_own');
  assert.equal(ctx.uploadDir, '/data/users/u_1/uploads');
});

test('native vision returns Pi image content and refuses files outside the home and uploads', async (t) => {
  const home = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const image = path.join(home, 'tiny.png');
  fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP8z4AdMOEQH6QSAM1BAQ/oQeJvAAAAAElFTkSuQmCC', 'base64'));
  const bridge = await createTools({ home, sessionId: 'task-t_visionbridge' });
  t.after(() => bridge.close());
  const viewed = await invoke(bridge, 'vision_analyze', { image_url: image, question: 'Describe the image.' });
  assert.ok(viewed.content.some((part) => part.type === 'image' && part.mimeType === 'image/png'), JSON.stringify(viewed));
  assert.equal(parsed(await invoke(bridge, 'vision_analyze', { image_url: '/private/tmp/another-users-image.png', question: 'Read' })).success, false);
});
