import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutputTools } from './output.mjs';

test('attach resolves images from this run and numbers document sources', async () => {
  const media = new Map([['a1', { id: 'a1', image: 'https://img.example/a.jpg' }], ['b2', { id: 'b2', image: 'https://img.example/b.jpg' }]]);
  const attach = createOutputTools({ media }).find((t) => t.name === 'attach');
  const out = await attach.execute({ image_ids: ['b2', 'a1', 'b2', 'missing'], document: { title: '报告', body: '结论 [1]', sources: [{ title: 'A', url: 'https://a.example' }, { url: 'javascript:alert(1)' }] } });
  assert.deepEqual(out.attachments[0], { type: 'images', items: [media.get('b2'), media.get('a1')] });
  assert.deepEqual(out.attachments[1], { type: 'document', title: '报告', body: '结论 [1]', sources: [{ n: 1, title: 'A', url: 'https://a.example' }] });
  await assert.rejects(attach.execute({ image_ids: ['nope'] }), /不在本轮/);
  await assert.rejects(attach.execute({}), /没有要附上的东西/);
  assert.equal(attach.toolset, 'core');
});
