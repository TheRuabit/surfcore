// Vector Memory 第一阶段测试（2026-10-30）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hashEmbed, cosine, createEmbedder, normalizeText, EMBED_DIM } from '../src/memory-embed.js';
import { createMemoryStore } from '../src/memory-store.js';
import { createShadowRetriever, estimateTokens } from '../src/memory-shadow.js';

const tmp = (name) => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '_tmp-mem-'));
  return path.join(dir, name);
};

test('hashEmbed：归一化 + 同文本同向量', () => {
  const a = hashEmbed('葛叶开局合守');
  const b = hashEmbed('葛叶开局合守');
  assert.equal(a.length, EMBED_DIM);
  assert.deepEqual(Array.from(a), Array.from(b));
  let norm = 0;
  for (let i = 0; i < a.length; i += 1) norm += a[i] * a[i];
  assert.ok(Math.abs(norm - 1) < 1e-5, '应当 L2 归一化');
});

test('hashEmbed：短消息也有向量（单字不落空）', () => {
  const v = hashEmbed('瑞');
  let sum = 0;
  for (let i = 0; i < v.length; i += 1) sum += Math.abs(v[i]);
  assert.ok(sum > 0, '单字必须有非零向量');
});

test('normalizeText：全角转半角、压空白', () => {
  assert.equal(normalizeText('  ＡＢＣ   Ｄ  '), 'ABC D');
});

test('cosine：相似文本高于无关文本', () => {
  const q = hashEmbed('葛叶合守怎么打');
  const near = hashEmbed('葛叶的合守要怎么放');
  const far = hashEmbed('今天天气不错适合出去走走');
  assert.ok(cosine(q, near) > cosine(q, far), '相近文本相似度必须更高');
});

test('store：add 幂等（同 key+seq 不重复）', () => {
  const file = tmp('a.jsonl');
  const store = createMemoryStore({ file, embedder: createEmbedder() });
  const m = { key: 'group:1', seq: 10, sender: '甲', text: '葛叶开局合守', time: Date.now() };
  assert.equal(store.add(m).added, true);
  assert.equal(store.add(m).added, false, '重复 add 必须被拦');
  assert.equal(store.stats().total, 1);
});

test('store：落盘后重新加载能重建索引', () => {
  const file = tmp('b.jsonl');
  const s1 = createMemoryStore({ file, embedder: createEmbedder() });
  s1.add({ key: 'group:1', seq: 1, sender: '甲', text: '葛叶', time: Date.now() });
  s1.add({ key: 'group:1', seq: 2, sender: '乙', text: '杂鱼杂鱼', time: Date.now() });
  s1.close();
  const s2 = createMemoryStore({ file, embedder: createEmbedder() });
  const loaded = s2.load();
  assert.equal(loaded.loaded, 2);
  assert.equal(s2.stats().total, 2);
  const r = s2.search('葛叶', { topK: 1 });
  assert.ok(r.hits.length >= 1);
  assert.match(r.hits[0].item.text, /葛叶/);
});

test('store：filter.key 隔离会话', () => {
  const file = tmp('c.jsonl');
  const store = createMemoryStore({ file, embedder: createEmbedder() });
  store.add({ key: 'group:1', seq: 1, sender: '甲', text: '葛叶合守', time: Date.now() });
  store.add({ key: 'group:2', seq: 1, sender: '乙', text: '葛叶合守', time: Date.now() });
  const r = store.search('葛叶', { topK: 5, filter: { key: 'group:2' } });
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].item.key, 'group:2');
});

test('store：新消息在分数上占优（recency 起作用）', () => {
  const file = tmp('d.jsonl');
  const store = createMemoryStore({ file, embedder: createEmbedder() });
  const old = Date.now() - 20 * 24 * 3600 * 1000;
  store.add({ key: 'g', seq: 1, sender: '甲', text: '合守怎么打', time: old });
  store.add({ key: 'g', seq: 2, sender: '甲', text: '合守怎么打', time: Date.now() });
  const r = store.search('合守怎么打', { topK: 2, filter: { key: 'g' } });
  assert.equal(r.hits[0].item.seq, 2, '同样的文本，更新的那条应该排前面');
});

test('shadow：probe 记录累计 token 且不返回正文给调用方', () => {
  const file = tmp('e.jsonl');
  const store = createMemoryStore({ file, embedder: createEmbedder() });
  store.add({ key: 'g', seq: 1, sender: '甲', text: '葛叶的二技能是合守', time: Date.now() });
  store.add({ key: 'g', seq: 2, sender: '乙', text: '杂口杂口就是菜鸡', time: Date.now() });
  const shadowFile = tmp('shadow.jsonl');
  const shadow = createShadowRetriever({ store, file: shadowFile, topK: 4 });
  const out = shadow.probe({ key: 'g', query: '合守是什么' });
  assert.equal(out.candidates, 2);
  assert.equal(out.tokens.length, 2);
  assert.ok(out.tokens[1] >= out.tokens[0], '累计 token 必须单调不减');
  assert.ok(out.latencyMs >= 0);
  assert.equal(out.topK, 4);
  // 日志真的写下去了
  const lines = fs.readFileSync(shadowFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.key, 'g');
  assert.ok(Array.isArray(rec.sourceMessageIds));
  assert.equal(shadow.status().runs, 1);
});

test('shadow：空 query / 无 store 都优雅跳过', () => {
  const shadow = createShadowRetriever({ store: null, file: tmp('f.jsonl') });
  assert.equal(shadow.probe({ key: 'g', query: '' }).skipped, 'empty-query');
  assert.equal(shadow.probe({ key: 'g', query: 'x' }).skipped, 'no-store');
});

test('estimateTokens：空串为 0，中文按 2.2 字符/token 估算', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('一'.repeat(22)), 10);
});
