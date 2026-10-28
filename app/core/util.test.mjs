import test from 'node:test';
import assert from 'node:assert/strict';
import { nowText } from './util.mjs';

test('the "now" text given to the model carries the full date, weekday and time', () => {
  assert.equal(nowText(new Date(2026, 9, 28, 9, 5)), '2026年10月28日周三 09:05');
});
