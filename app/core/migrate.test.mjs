import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { migrateState, migrateConfig, migrateEnv, logEntry } from './migrate.mjs';
import { openAccounts } from '../accounts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const at = '2026-10-20T08:00:00.000Z';
const photo = { id: 'p1', title: '猫', site: 'example.com', image: 'https://img.example/p1.jpg', thumb: 'https://img.example/t1.jpg', page: 'https://example.com/' };
const OLD_STATE = {
  messages: [
    { id: 'm1', chatId: 'c1', role: 'me', text: '找猫图', at },
    { id: 'm2', chatId: 'c1', role: 'bot', text: '找到了\nGALLERY: p1', photos: [photo], taskId: 't_1', steerOf: 't_0', at },
    { id: 'm3', chatId: 'c1', role: 'bot', text: '', report: { title: '报告', body: '正文 [1]', sources: [{ n: 1, title: 'A', url: 'https://a.example' }], kind: 'research' }, partOf: 't_1', at },
    { id: 'm4', chatId: 'c1', role: 'bot', text: '还差时间', booking: { type: 'ask', cur: 0, answers: {}, questions: [{ key: 'q0', tab: '时间', label: '几点', options: [{ label: '三点', value: '三点' }] }] }, at },
    { id: 'm5', chatId: 'c1', role: 'bot', text: '✅ 问到了', booking: { type: 'calls', calls: [{ id: 'c_1', short: '栗子' }] }, sites: [], at },
  ],
  tasks: [
    { id: 't_1', kind: 'research', title: '调研', status: 'done', runId: 'r1', lastSeq: 3, reattach: true,
      result: { text: '我先查查\nREPORT:\n## 结论\n最推荐 A [1]\nSOURCES:\n[1] A | https://a.example', photos: [photo] } },
    { id: 't_2', kind: 'goal', title: '目标：天气', status: 'done', result: { text: 'STATUS: 明天有雨\nNEW: yes\nDONE: no\n记得带伞\nGALLERY: p1' } },
    { id: 't_3', kind: 'chat', title: '问美甲', status: 'done', callIds: ['c_1'], call: { stage: 'done' }, result: { text: '问到了' },
      history: [{ round: 1, status: 'done', steps: [{ name: 'idol_photo_search' }] }] },
  ],
  goals: [
    { id: 'g_1', kind: 'general', createdBy: 'user', title: '天气', log: [{ at, text: '建好目标 · 每 6 小时 · 在聊天里建的' }, { at, text: '检查：明天有雨（有新进展，告诉你了）', task: 't_2' }, { at, text: '暂停' }] },
    { id: 'g_2', kind: 'redial', title: '重拨 · 栗子', calls: [{ who: '栗子', at, missed: '没人接', call: { to: '010-1', name: '栗子', goal: '问位', mode: 'ask' } }], fromTask: 't_3', schedule: { once: at }, log: [] },
    { id: 'g_3', kind: 'ledger', title: '记账' },
  ],
  chats: [{ id: 'c1', title: '找猫图', createdAt: at, updatedAt: at }], currentChat: 'c1',
};

test('old state becomes attachments and structured fields, and migrating again changes nothing', () => {
  const { state, changed } = migrateState(structuredClone(OLD_STATE), { calls: [{ id: 'c_1', short: '栗子', summary: '有位' }] });
  assert.equal(changed, true);
  const [m1, m2, m3, m4, m5] = state.messages;
  assert.equal(m1.attachments, undefined);
  assert.deepEqual(m2, { id: 'm2', chatId: 'c1', role: 'bot', text: '找到了', taskId: 't_1', at, attachments: [{ type: 'images', items: [photo] }] });
  assert.deepEqual(m3.attachments, [{ type: 'document', title: '报告', body: '正文 [1]', sources: [{ n: 1, title: 'A', url: 'https://a.example' }] }]);
  assert.equal(m4.attachments[0].type, 'ask');
  assert.equal(m4.attachments[0].questions[0].label, '几点');
  assert.deepEqual(m5.attachments, [{ type: 'calls', calls: [{ id: 'c_1', short: '栗子' }] }]);
  assert.ok(!('sites' in m5) && !('booking' in m5));

  const [t1, t2, t3] = state.tasks;
  assert.equal(t1.kind, 'chat');
  assert.deepEqual(t1.skills, ['deep-research']);
  assert.ok(!('runId' in t1) && !('lastSeq' in t1) && !('reattach' in t1));
  assert.equal(t1.result.text, '最推荐 A [1]');
  assert.deepEqual(t1.result.attachments.map((a) => a.type), ['images', 'document']);
  assert.deepEqual(t1.result.attachments[1].sources, [{ n: 1, title: 'A', url: 'https://a.example' }]);
  assert.deepEqual(t2.check, { status: '明天有雨', notify: true, done: false });
  assert.equal(t2.result.text, '记得带伞');
  assert.deepEqual(t3.result.attachments, [{ type: 'calls', calls: [{ id: 'c_1', short: '栗子', summary: '有位' }] }]);
  assert.equal(t3.history[0].steps[0].name, 'image_search');
  assert.ok(!('call' in t3) && !('callIds' in t3));

  assert.deepEqual(state.goals.map((g) => g.id), ['g_1', 'g_2']);
  assert.deepEqual(state.goals[0].log.map((l) => [l.type, l.text, !!l.notify]), [['created', '建好目标 · 每 6 小时 · 在聊天里建的', false], ['check', '明天有雨', true], ['paused', '暂停', false]]);
  assert.match(state.goals[1].brief, /自动重拨[\s\S]*"to":"010-1"/);
  assert.ok(!('kind' in state.goals[1]) && !('calls' in state.goals[1]));
  assert.equal(state.stats.tasksDone, 2);
  assert.equal(state.stats.reports, 1);

  const again = migrateState(structuredClone(state));
  assert.equal(again.changed, false);
  assert.deepEqual(again.state, state);
});

test('single-chat legacy state gets a chat, and log entries already structured stay as they are', () => {
  const { state } = migrateState({ messages: [{ id: 'm1', role: 'me', text: '你好呀', at }] }, { newId: () => 'c_new' });
  assert.deepEqual(state.chats.map((c) => [c.id, c.title]), [['c_new', '你好呀']]);
  assert.equal(state.messages[0].chatId, 'c_new');
  assert.equal(state.currentChat, 'c_new');
  const entry = { at, type: 'check', text: '晴' };
  assert.equal(logEntry(entry), entry);
  assert.equal(logEntry({ at, text: '完成：你标记的' }).type, 'done');
  assert.equal(logEntry({ at, text: '随便一句' }).type, 'note');
});

test('old tool switches and gateway credentials are rewritten', () => {
  const { config, changed } = migrateConfig({ agent: { disabled_tools: ['idol_photo_search'] }, platform_toolsets: { api_server: ['idol', 'vision', 'deepsearch', 'skills', 'skillstore', 'phone'] },
    memory: { memory_enabled: true }, skills: { disabled: ['a'], platform_disabled: { api_server: ['b'] } } });
  assert.equal(changed, true);
  assert.deepEqual(config, { toolsets: ['images', 'vision', 'web', 'skills', 'phone'], disabled_tools: ['image_search'], memory: { memory_enabled: true }, skills: { disabled: ['a', 'b'] } });
  assert.equal(migrateConfig(config).changed, false);
  assert.deepEqual(migrateEnv('API_SERVER_ENABLED=true\nAPI_SERVER_PORT=8701\nexport API_SERVER_KEY=x\nOTHER=1\n'), { text: 'OTHER=1\n', changed: true });
  assert.equal(migrateEnv('OTHER=1').changed, false);
});

test('scripts/migrate.mjs backs up, migrates a data directory and is safe to run twice', async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cattuan-migrate-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const accounts = openAccounts(data);
  const user = await accounts.createUser({ name: 'old', password: 'password-migrate' });
  accounts.db.close();
  const dir = path.join(data, 'users', user.id);
  const home = path.join(dir, 'agent-home');
  fs.mkdirSync(path.join(dir, 'pi-chat', 'sessions', 'abc123'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pi-chat', 'sessions', 'abc123', 's.jsonl'), '{}\n');
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(OLD_STATE));
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.yaml'), 'platform_toolsets:\n  api_server: [idol, deepsearch]\n');
  fs.writeFileSync(path.join(home, '.env'), 'API_SERVER_PORT=8701\nAPI_SERVER_KEY=k\n');
  const migrate = () => spawnSync(process.execPath, [path.join(ROOT, 'scripts/migrate.mjs')], { env: { ...process.env, CATTUAN_DATA_DIR: data, PORT: '1' }, encoding: 'utf8' });

  const first = migrate();
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.match(first.stdout, /备份好了/);
  assert.equal(fs.readdirSync(path.join(data, 'backups')).length, 1);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(state.version, 2);
  assert.equal(state.messages[1].attachments[0].type, 'images');
  assert.ok(fs.existsSync(path.join(home, 'pi', 'sessions', 'abc123', 's.jsonl')));
  assert.ok(!fs.existsSync(path.join(dir, 'pi-chat')));
  assert.match(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8'), /toolsets:\n\s+- images\n\s+- web/);
  assert.ok(!fs.existsSync(path.join(home, '.env')));
  assert.ok(fs.lstatSync(path.join(home, 'MAIN.md')).isSymbolicLink());

  const second = migrate();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /都已经是新格式/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')), state);
});
