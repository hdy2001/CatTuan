// 把东西附在回复下面给用户看：图片（按本轮工具找到的图片 id）、长文档（报告、清单，Markdown + 来源）。
// 工具结果里的 attachments 只给 App 看（挂到消息上），不给模型看；本轮找到的图片登记在 ctx.media 里，这里按 id 取。
import { tool } from './common.mjs';
import { clip } from '../core/util.mjs';

const MAX_DOCUMENT = 20000;

export function createOutputTools(ctx) {
  return [
    tool('attach', 'core', {
      label: '附上',
      describe: (a) => ({ act: [a.image_ids?.length && `附上 ${a.image_ids.length} 张图`, a.document?.title && `附上「${clip(a.document.title, 20)}」`].filter(Boolean).join('，') || '附上' }),
      description: '把东西附在你这次的回复下面给用户看：image_ids 是本轮搜图结果里挑出的图片 id（按展示顺序，挑清晰、确实相关的 4–8 张，去掉广告和重复）；document 是一份长文档（调研报告、完整清单），正文用 Markdown，引用写 [n]，对应 sources 里第 n 个来源。回复正文里不要再贴图片链接或整份文档。',
      parameters: { type: 'object', properties: {
        image_ids: { type: 'array', items: { type: 'string' } },
        document: { type: 'object', properties: {
          title: { type: 'string', description: '不超过 20 个字' },
          body: { type: 'string', description: 'Markdown 正文：先给结论，再分节写要点；对比用表格' },
          sources: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' } }, required: ['url'] }, description: '真正引用过的来源，顺序对应正文里的 [1] [2]…' },
        }, required: ['title', 'body'] },
      } },
    }, async ({ image_ids: ids = [], document } = {}) => {
      const attachments = [];
      const wanted = [...new Set([].concat(ids).map(String))];
      const items = wanted.map((id) => ctx.media?.get(id)).filter(Boolean);
      if (wanted.length && !items.length) throw new Error('这些图片 id 不在本轮的搜图结果里');
      if (items.length) attachments.push({ type: 'images', items });
      const body = String(document?.body || '').trim().slice(0, MAX_DOCUMENT);
      if (body) {
        const sources = (Array.isArray(document.sources) ? document.sources : []).filter((s) => /^https?:\/\//.test(String(s?.url || '')))
          .slice(0, 30).map((s, i) => ({ n: i + 1, title: clip(s.title || s.url, 120), url: String(s.url) }));
        attachments.push({ type: 'document', title: clip(document.title || '文档', 30), body, sources });
      }
      if (!attachments.length) throw new Error('没有要附上的东西：给 image_ids 或 document');
      return { ok: true, images: items.length, document: !!body, attachments };
    }),
  ];
}
