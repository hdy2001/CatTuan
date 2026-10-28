import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.mjs';

test('both agents think by default with room for it, and each can be switched off', () => {
  const env = { LONGCAT_API_KEY: 'k', PI_THINKING: '', DISPATCH_THINKING: '', PI_MAX_TOKENS: '', DISPATCH_MAX_TOKENS: '' };
  const { models } = loadConfig(env);
  assert.equal(models.worker.thinking, true);
  assert.equal(models.main.thinking, true);
  assert.equal(models.worker.maxTokens, 16384, 'thinking counts as output, so the worker gets a larger output budget');
  assert.equal(models.main.maxTokens, 8192, 'a thinking chat turn must not hit the output limit');
  const flipped = loadConfig({ ...env, PI_THINKING: '0', DISPATCH_THINKING: '0' }).models;
  assert.equal(flipped.worker.thinking, false);
  assert.equal(flipped.main.thinking, false);
});
