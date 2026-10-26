import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSchedule, nextRun, scheduleLabel } from './goals.mjs';

test('schedules: every / at / once, with a minimum interval', () => {
  const from = new Date(2026, 9, 26, 10, 0).getTime(); // 本地时间 10:00
  assert.deepEqual(normalizeSchedule({ every: 5 }, 60), { every: 60 });
  assert.deepEqual(normalizeSchedule({}, 15), { every: 360 });
  assert.deepEqual(normalizeSchedule({ at: '8:30' }), { at: '08:30' });
  // 到点办一次：HH:MM 是今天的，已经过了就是明天的
  assert.equal(new Date(normalizeSchedule({ once: '10:30' }, 15, from).once).getTime(), new Date(2026, 9, 26, 10, 30).getTime());
  assert.equal(new Date(normalizeSchedule({ once: '09:00' }, 15, from).once).getTime(), new Date(2026, 9, 27, 9, 0).getTime());
  assert.equal(normalizeSchedule({ once: '2026-10-28T02:00:00.000Z' }).once, '2026-10-28T02:00:00.000Z');

  assert.equal(nextRun({ every: 30 }, from), new Date(from + 30 * 60_000).toISOString());
  assert.equal(nextRun({ at: '09:00' }, from), new Date(2026, 9, 27, 9, 0).toISOString());
  assert.equal(nextRun({ once: new Date(from - 60_000).toISOString() }, from), new Date(from).toISOString(), 'a missed one-off runs right away');
  assert.equal(scheduleLabel({ every: 120 }), '每 2 小时');
  assert.equal(scheduleLabel({ at: '09:00' }), '每天 09:00');
});
