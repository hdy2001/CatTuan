import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJupiterProvider, mediaTxt, transcript, MEDIA_KEYS } from './jupiter-provider.mjs';
import { writeFakeCli, record } from './fake-cli.mjs';

const CONFIG = { JUPITER_TENANT_ID: 'tenant-1', JUPITER_ROUTE_POINT: '58486441', JUPITER_ENV: 'test', JUPITER_POLL_SECONDS: '0' };
const ok = (contactId) => ({ out: { contactId } });
const found = (...records) => ({ out: records });
const error = (exit, type, message) => ({ exit, out: { error: { type, message, exitCode: exit } } });
const TENNIS = {
  to: '152-8176-3765', name: '示例网球中心（测试店）', goal: '预约网球场地', category: '网球', mode: 'book',
  details: { 日期: '2026-10-27', 时间: '19:00-21:00', 时长: '连续2小时', 人数: '2人', 项目: '网球单打', 场地: '室内', 数量: '1片', 付款方式: '到店支付' },
  rejected_terms: ['其他时间', '室外场', '预付款、定金、最低消费', '超预算方案', '更换门店'],
  share: '仅可提供：顾客称呼：测试顾客；手机尾号：0000。禁止提供：完整手机号、微信、其他个人信息',
  questions: ['是否有符合要求的室内场地', '单价及计费方式', '包含全部费用后的总价', '付款方式', '是否已登记成功', '到店确认方式', '迟到保留时间'],
};

function setup(t, scenario, { llmOut = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cattuan-jupiter-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cli = writeFakeCli(dir, scenario);
  const asked = [];
  const llm = { complete: async (x) => { asked.push(x); return llmOut; } };
  return { cli, asked, dir, provider: createJupiterProvider({ llm, agent: '喵团' }), env: { ...CONFIG, JUPITER_CLI: cli.bin } };
}

test('the call request becomes the fixed --media-txt format the server-side agent expects', () => {
  const { media, missing } = mediaTxt(TENNIS);
  assert.deepEqual(missing, []);
  assert.deepEqual(Object.keys(media), MEDIA_KEYS);
  assert.deepEqual(media, {
    电话号码: '15281763765', merchantName: '示例网球中心（测试店）', purpose: '预约网球场地', category: '网球', mode: 'book',
    customerNeed: '日期：2026-10-27；时间：19:00-21:00；时长：连续2小时；人数：2人；项目：网球单打；场地：室内；数量：1片；付款方式：到店支付',
    rejectedTerms: '其他时间；室外场；预付款、定金、最低消费；超预算方案；更换门店',
    allowedInfo: '仅可提供：顾客称呼：测试顾客；手机尾号：0000。禁止提供：完整手机号、微信、其他个人信息',
    toConfirm: '1.是否有符合要求的室内场地；2.单价及计费方式；3.包含全部费用后的总价；4.付款方式；5.是否已登记成功；6.到店确认方式；7.迟到保留时间',
    pauseCases: '暂无',
  });
  assert.ok(Object.values(media).every((v) => typeof v === 'string' && v));
  for (const [to, number] of [['+86 152-8176-3765', '15281763765'], ['0086 15281763765', '15281763765'], ['(010) 1234-5678', '01012345678'], ['86123', '86123']]) {
    assert.equal(mediaTxt({ ...TENNIS, to }).media.电话号码, number, to);
  }
  assert.deepEqual(mediaTxt({ to: '1', mode: 'call' }).missing, ['打给谁（name）', '要办的事（goal）', '品类（category）', 'mode（ask / book）']);
});

test('a connected call: aicall with the request, then the call record is polled and summarized', async (t) => {
  const lines = [{ role: 'robot', text: '您好，我是喵团智能助理' }, { role: 'customer', text: '19 点有室内场，120 一小时' }];
  const { cli, asked, provider, env } = setup(t, { aicall: ok('C-1'), query: [found(), found(record('C-1', { lines }))] },
    { llmOut: { outcome: 'booked', summary: '约上了 19:00-21:00 室内场，240 元到店付', answers: { 单价及计费方式: '120 元/小时' }, booked: { 日期: '2026-10-27' } } });
  const events = [];
  const r = await provider.dial(TENNIS, { env, onStage: (s) => events.push(s), onPlaced: async (id) => events.push(`placed:${id}`) });
  assert.deepEqual(events, ['placed:C-1', 'dialing']);
  assert.equal(r.status, 'done');
  assert.equal(r.outcome, 'booked');
  assert.equal(r.seconds, 65);
  assert.deepEqual(r.lines, [{ who: 'ai', text: '您好，我是喵团智能助理' }, { who: 'shop', text: '19 点有室内场，120 一小时' }]);
  assert.equal(r.summary, '约上了 19:00-21:00 室内场，240 元到店付');
  assert.deepEqual(r.booked, { 日期: '2026-10-27' });
  assert.equal(r.needUser, false);
  assert.equal(r.retry, null);
  assert.match(asked[0].user, /示例网球中心/);

  const [dial, ...queries] = cli.calls();
  assert.deepEqual(dial.argv.slice(0, -1), ['-o', 'json', '--env', 'test', 'call', 'aicall', '--tenant-id', 'tenant-1', '--callee', '15281763765', '--route-point', '58486441', '--media-txt']);
  assert.deepEqual(JSON.parse(dial.argv.at(-1)), mediaTxt(TENNIS).media);
  assert.equal(dial.exchange, null, 'moa: the CLI exchanges its own token');
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[0].argv.slice(0, 10), ['-o', 'json', '--env', 'test', 'call-record', 'query', '--contact-id', 'C-1', '--tenant-id', 'tenant-1']);
  assert.match(queries[0].argv.at(-1), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
});

test('when the call record has no text, the transcript is read by the recording deviceId', async (t) => {
  const rec = { ...record('C-12'), recordUrlData: [{ contactId: 'C-12', deviceId: 'D-1', recordType: 'ivr' }] };
  const { cli, provider, env } = setup(t, { aicall: ok('C-12'), query: [{ out: { list: [rec], total: 1 } }],
    text: { out: { sentences: [{ role: 'robot', text: '您好' }, { role: 'customer', text: '有位' }] } } }, { llmOut: { outcome: 'answered', summary: '有位' } });
  const r = await provider.dial(TENNIS, { env });
  assert.deepEqual(r.lines, [{ who: 'ai', text: '您好' }, { who: 'shop', text: '有位' }]);
  assert.equal(r.outcome, 'answered');
  assert.deepEqual(cli.calls().at(-1).argv.slice(4), ['record-text', 'query', '--tenant-id', 'tenant-1', '--device-id', 'D-1']);
});

test('resuming a call already placed polls its record without dialing again', async (t) => {
  const { cli, provider, env } = setup(t, { aicall: ok('C-NEW'), query: [found(record('C-OLD', { connected: false }))] });
  const placed = [];
  const r = await provider.dial(TENNIS, { env, resume: { ref: 'C-OLD', at: new Date(Date.now() - 60_000).toISOString() }, onPlaced: async (id) => placed.push(id) });
  assert.deepEqual([r.status, r.outcome], ['missed', 'no_answer']);
  assert.deepEqual(placed, []);
  assert.deepEqual(cli.calls().map((c) => c.argv[4]), ['call-record']);
  assert.ok(cli.calls()[0].argv.includes('C-OLD'));
});

test('calls that are not answered, have no transcript or no result yet', async (t) => {
  const missed = setup(t, { aicall: ok('C-2'), query: [found(record('C-2', { connected: false }))] });
  let r = await missed.provider.dial(TENNIS, { env: missed.env });
  assert.deepEqual([r.status, r.outcome, r.label, r.retry, r.seconds], ['missed', 'no_answer', '未接通：无人接听', 'later', 12]);

  const dead = setup(t, { aicall: ok('C-3'), query: [found({ ...record('C-3', { connected: false }), hangupReasonName: '空号' })] });
  r = await dead.provider.dial(TENNIS, { env: dead.env });
  assert.deepEqual([r.status, r.outcome, r.retry], ['missed', 'invalid_number', 'no']);

  const silent = setup(t, { aicall: ok('C-4'), query: [found(record('C-4'))] });
  r = await silent.provider.dial(TENNIS, { env: { ...silent.env, JUPITER_RESULT_MINUTES: '0' } });
  assert.deepEqual([r.status, r.outcome, r.summary], ['done', 'no_text', '接通了 65 秒，平台没给通话文字']);
  assert.equal(silent.asked.length, 0);

  const waiting = setup(t, { aicall: ok('C-5'), query: [found()] });
  r = await waiting.provider.dial(TENNIS, { env: { ...waiting.env, JUPITER_RESULT_MINUTES: '0' } });
  assert.deepEqual([r.status, r.outcome, r.retry], ['pending', 'result_pending', null]);
});

test('nothing is dialed when the platform is not configured, the request is incomplete or the CLI fails', async (t) => {
  t.mock.method(console, 'error', () => {});
  const s = setup(t, { aicall: ok('C-6') });
  let r = await s.provider.dial(TENNIS, { env: {} });
  assert.deepEqual([r.status, r.outcome], ['blocked', 'not_configured']);
  r = await s.provider.dial({ ...TENNIS, category: '' }, { env: s.env });
  assert.deepEqual([r.status, r.outcome, r.retry], ['blocked', 'bad_params', 'rewrite']);
  assert.match(r.label, /品类/);
  r = await s.provider.dial(TENNIS, { env: { ...s.env, JUPITER_CLI: path.join(s.dir, 'missing-cli') } });
  assert.deepEqual([r.status, r.outcome], ['blocked', 'no_cli']);
  assert.equal(s.cli.calls().length, 0);

  const cases = [
    [error(1, 'BusinessError', '号码在黑名单'), 'platform_error', 'no', /号码在黑名单/],
    [error(1, 'BusinessError', '没有可用的外显号码'), 'platform_error', 'soon', /外显号码/],
    [{ exit: 1, out: "error: required option '--callee <phone>' not specified" }, 'platform_error', 'no', /required option/],
    [error(2, 'ValidationError', '--media-txt 不是合法 JSON'), 'bad_params', 'rewrite', /media-txt/],
    [error(3, 'AuthError', 'SSO 获取失败: spawn mtsso-moa-local-exchange ENOENT'), 'auth_failed', null, /鉴权失败/],
    [error(1, 'BusinessError', 'SSO 认证失败: SSO Token 无效或已过期'), 'auth_failed', null, /鉴权失败/],
    [error(4, 'NetworkError', '连接失败: timeout'), 'network', 'soon', /连不上/],
    [{ exit: 0, out: {} }, 'platform_error', 'no', /外呼平台没接这通/],
  ];
  for (const [aicall, outcome, retry, label] of cases) {
    const x = setup(t, { aicall });
    const placed = [];
    r = await x.provider.dial(TENNIS, { env: x.env, onPlaced: async (id) => placed.push(id) });
    assert.deepEqual([r.status, r.outcome, r.retry], ['blocked', outcome, retry], JSON.stringify(aicall));
    assert.match(r.label, label);
    assert.deepEqual(placed, []);
  }
});

test('auth sources: the CLI exchanges its own token (moa), or gets ours through the PATH stand-in', async (t) => {
  t.mock.method(console, 'error', () => {});
  const token = setup(t, { aicall: ok('C-7'), query: [found(record('C-7', { connected: false }))] });
  await token.provider.dial(TENNIS, { env: { ...token.env, JUPITER_AUTH: 'token', JUPITER_SSO_TOKEN: 'tok-123' } });
  assert.deepEqual(token.cli.calls().map((c) => c.exchange), ['tok-123', 'tok-123'], 'both aicall and call-record query get the token');

  const command = setup(t, { aicall: ok('C-8'), query: [found(record('C-8', { connected: false }))] });
  await command.provider.dial(TENNIS, { env: { ...command.env, JUPITER_AUTH: 'command', JUPITER_AUTH_COMMAND: 'printf "tok-%s" from-cmd' } });
  assert.equal(command.cli.calls()[0].exchange, 'tok-from-cmd');

  const bad = setup(t, { aicall: ok('C-9') });
  for (const auth of [{ JUPITER_AUTH: 'command', JUPITER_AUTH_COMMAND: 'echo no >&2; exit 3' }, { JUPITER_AUTH: 'command' },
    { JUPITER_AUTH: 'token' }, { JUPITER_AUTH: 'oauth' }]) {
    const r = await bad.provider.dial(TENNIS, { env: { ...bad.env, ...auth } });
    assert.deepEqual([r.status, r.outcome], ['blocked', 'auth_failed'], JSON.stringify(auth));
  }
  assert.equal(bad.cli.calls().length, 0);
});

test('the CLI runs without the App\'s outbound proxy (it only talks to the company network)', async (t) => {
  for (const k of ['HTTPS_PROXY', 'http_proxy']) {
    const before = process.env[k];
    process.env[k] = 'http://127.0.0.1:7897';
    t.after(() => { if (before === undefined) delete process.env[k]; else process.env[k] = before; });
  }
  const s = setup(t, { aicall: ok('C-13'), query: [found(record('C-13', { connected: false }))] });
  await s.provider.dial(TENNIS, { env: s.env });
  await s.provider.dial(TENNIS, { env: { ...s.env, JUPITER_AUTH: 'token', JUPITER_SSO_TOKEN: 'tok' } });
  assert.deepEqual(s.cli.calls().map((c) => c.proxy), [[], [], [], []]);
});

test('cancelling kills the CLI, and stops waiting for the result after the call was placed', async (t) => {
  const slow = setup(t, { aicall: { ...ok('C-10'), sleepMs: 5000 } });
  const started = Date.now();
  await assert.rejects(slow.provider.dial(TENNIS, { env: slow.env, signal: AbortSignal.timeout(200) }), { name: 'TimeoutError' });
  assert.ok(Date.now() - started < 3000);

  const placed = setup(t, { aicall: ok('C-11') });
  const ids = [];
  const stop = new AbortController();
  const dialing = placed.provider.dial(TENNIS, { env: { ...placed.env, JUPITER_POLL_SECONDS: '30' }, signal: stop.signal, onPlaced: async (id) => { ids.push(id); stop.abort(); } });
  await assert.rejects(dialing, { name: 'AbortError' });
  assert.deepEqual(ids, ['C-11']);
});

test('transcripts are read leniently until the real aicall format is known', () => {
  assert.deepEqual(transcript([{ speaker: 'AI', content: '您好' }, { type: 'user', asrText: '有位' }, { role: 'robot', text: '' }]),
    [{ who: 'ai', text: '您好' }, { who: 'shop', text: '有位' }]);
  assert.deepEqual(transcript('机器人：您好\n客户：有位'), [{ who: 'ai', text: '您好' }, { who: 'shop', text: '有位' }]);
  assert.deepEqual(transcript(JSON.stringify([{ role: 'agent', text: '好的' }])), [{ who: 'ai', text: '好的' }]);
  assert.deepEqual(transcript(null), []);
});
