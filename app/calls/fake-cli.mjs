// 测试用的假木星 CLI（不会真的打电话）：在 dir 里写一个可执行的 mt-jupiter-cli，按 scenario 回话，每次调用记进 dir/calls.log。
// scenario：{ aicall: { exit, out, sleepMs }, query: [{ exit, out }, …], text: { exit, out } }。query（call-record query）按调用顺序取，
// 取完一直用最后一个；text 是 record-text query 的回话；没写的回 []。out 照真 CLI 的 -o json 写：aicall 是 { contactId }，
// 查询类直接是接口的 data，出错是 { error: { type, message, exitCode } }。记下的 exchange 是 PATH 上 bin/ 替身吐出的 token（没放替身就是 null）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHIM = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin', 'mtsso-moa-local-exchange');

const SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const dir = __dirname;
const sc = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
const argv = process.argv.slice(2);
const found = (process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, 'mtsso-moa-local-exchange')).find((f) => fs.existsSync(f));
const exchange = found === ${JSON.stringify(SHIM)} ? execFileSync(found, [], { encoding: 'utf8' }).trim() : null;
const proxy = Object.keys(process.env).filter((k) => /^(https?|all)_proxy$/i.test(k));
fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify({ argv, exchange, proxy }) + '\\n');
let reply;
if (argv.includes('aicall')) reply = sc.aicall;
else if (argv.includes('record-text')) reply = sc.text;
else {
  const counter = path.join(dir, 'query.count');
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  fs.writeFileSync(counter, String(n + 1));
  const list = sc.query || [];
  reply = list[Math.min(n, list.length - 1)];
}
reply ||= { exit: 0, out: [] };
const done = () => {
  if (reply.out !== undefined) process.stdout.write(typeof reply.out === 'string' ? reply.out : JSON.stringify(reply.out));
  process.exitCode = reply.exit || 0;
};
if (reply.sleepMs) setTimeout(done, reply.sleepMs); else done();
`;

export function writeFakeCli(dir, scenario) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(scenario));
  const bin = path.join(dir, 'mt-jupiter-cli');
  fs.writeFileSync(bin, `#!${process.execPath}\n${SCRIPT}`, { mode: 0o755 });
  const log = path.join(dir, 'calls.log');
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) };
}

// 一条话单（字段照文档的 call-record query 示例）
export const record = (contactId, { connected = true, talk = '00:01:05', lines = [] } = {}) => ({
  contactId, callResult: connected ? '已接通' : '未接通', ringTimeLen: '00:00:12', talkingTimeLen: connected ? talk : '00:00:00',
  hangupReasonName: connected ? '客户挂断' : '无人接听', recordText: lines,
});
