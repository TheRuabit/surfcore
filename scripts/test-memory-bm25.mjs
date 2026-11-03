// 长期记忆检索测试（2026-10-31）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createBM25Store, tokenize } from '../src/memory-bm25.js';
import { createMemoryStore } from '../src/memory-store.js';
import { createEmbedder } from '../src/memory-embed.js';
import { createShadowRetriever } from '../src/memory-shadow.js';
import { isMemoryNoiseText, pickShadowQuery } from '../src/memory-query.js';

const root = fs.mkdtempSync(path.join(process.cwd(), '_tmp-mem-bm25-'));
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 退出清理失败不阻塞 */ } });
let seq = 0;
const file = (name) => path.join(root, `${++seq}-${name}.jsonl`);

test('tokenize：中文单字 + bigram，英文整词', () => {
  assert.deepEqual(tokenize('我饿了'), ['我', '我饿', '饿', '饿了', '了']);
  assert.deepEqual(tokenize('DeepSeek OK'), ['deepseek', 'ok']);
});

test('tokenize：@昵称 不参与检索，正文保留', () => {
  const t = tokenize('@寻玉型大肥鱼 宝宝');
  assert.ok(!t.includes('寻'), '昵称不应成为检索词');
  assert.ok(!t.includes('大肥鱼'));
  assert.ok(t.includes('宝宝'));
  assert.deepEqual(tokenize('@123456'), []);
});

test('BM25：filter.before 只保留更早的消息', () => {
  const store = createBM25Store({ file: file('before') });
  const now = Date.now();
  store.add({ key: 'g', seq: 1, time: now - 60_000, text: 'alpha beta' });
  store.add({ key: 'g', seq: 2, time: now - 120_000, text: 'alpha beta' });
  const r = store.search('alpha beta', { topK: 5, filter: { key: 'g', before: now - 90_000 } });
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].item.seq, 2);
});

test('BM25：长度用 token 数，不是去重词数', () => {
  const store = createBM25Store({ file: file('len') });
  store.add({ key: 'g', seq: 1, text: '你在干什么' });
  assert.equal(store.stats().avgLen, tokenize('你在干什么').length);
});

test('BM25：完整 bigram 命中排在只共享单字的前面', () => {
  const store = createBM25Store({ file: file('weight') });
  store.add({ key: 'g', seq: 1, time: Date.now() - 60_000, text: '合守怎么打' });
  store.add({ key: 'g', seq: 2, time: Date.now() - 60_000, text: '合理守则' });
  const r = store.search('合守', { topK: 2, filter: { key: 'g' } });
  assert.equal(r.hits[0].item.seq, 1);
  assert.ok(r.hits[0].score > r.hits[1].score);
});

test('memory-store：与 BM25 一样支持 filter.key/before', () => {
  const store = createMemoryStore({ file: file('vec'), embedder: createEmbedder() });
  const now = Date.now();
  store.add({ key: 'g', seq: 1, time: now - 60_000, text: 'alpha beta' });
  store.add({ key: 'g', seq: 2, time: now - 120_000, text: 'alpha beta' });
  store.add({ key: 'other', seq: 1, time: now - 120_000, text: 'alpha beta' });
  const r = store.search('alpha beta', { topK: 5, filter: { key: 'g', before: now - 90_000 } });
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].item.seq, 2);
});

test('isMemoryNoiseText：媒体/纯 @/单字/空串算噪音', () => {
  for (const t of ['', '  ', '[图片]', '[表情]', '[转发消息]', '[拍一拍]', '@123456', '@某人 ']) {
    assert.equal(isMemoryNoiseText(t), true, `${JSON.stringify(t)} 应当是噪音`);
  }
  for (const t of ['[图片] 你看', '@123456 你好', '草草', '[拍一拍] A 拍了拍 你']) {
    assert.equal(isMemoryNoiseText(t), false, `${JSON.stringify(t)} 不应当是噪音`);
  }
});

test('pickShadowQuery：跳过自己/拍一拍/噪音，上界取「窗口最早」与「now-10min」更早者', () => {
  const now = 1_700_000_000_000;
  const q = pickShadowQuery([
    { isSelf: true, text: '我发的', time: now - 5000 },
    { kind: 'poke', text: '[拍一拍] A 拍了拍 你', time: now - 4000 },
    { text: '[图片]', time: now - 3000 },
    { text: '@123456', time: now - 2000 },
    { text: '第一句', time: now - 9000 },
    { text: '第二句', time: now - 8000 },
    { text: '第三句', time: now - 7000 },
    { text: '第四句', time: now - 6000 },
  ], { now });
  assert.equal(q.text, '第二句 第三句 第四句');
  assert.equal(q.before, now - 10 * 60 * 1000, '活跃话题时按最近 10 分钟截断');

  const quiet = pickShadowQuery([
    { text: '很久以前 1', time: now - 30 * 60 * 1000 },
    { text: '很久以前 2', time: now - 29 * 60 * 1000 },
    { text: '很久以前 3', time: now - 28 * 60 * 1000 },
  ], { now });
  assert.equal(quiet.before, now - 30 * 60 * 1000, '群安静时用窗口最早一条，排除 query 自己');
});

test('接线：probeMemoryShadow 读 v2 会话、不再回落 prompt 尾', () => {
  const source = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  const start = source.indexOf('function probeMemoryShadow');
  const end = source.indexOf('async function ensureSlangLearnerSession', start);
  assert.ok(start > 0 && end > start, '必须能找到 probeMemoryShadow 函数体');
  const body = source.slice(start, end);
  assert.match(body, /socialV2\.conversations\.get\(canonicalV2Key\(key\) \|\| key\)/);
  assert.doesNotMatch(body, /promptText\.slice\(-200\)/);
  const archive = source.slice(source.indexOf('function archiveMemory'), start);
  assert.match(archive, /isMemoryNoiseText\(text\)/);
});

test('接线：loadConfig 白名单包含 vectorMemory', () => {
  const source = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(source, /vectorMemory: \(file\.vectorMemory && typeof file\.vectorMemory === 'object'/);
});

test('配置模板：包含 vectorMemory 默认段', () => {
  const cfg = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  assert.equal(typeof cfg.vectorMemory, 'object');
  assert.equal(cfg.vectorMemory.retriever, 'bm25');
  assert.equal(cfg.vectorMemory.shadow, false);
});

test('shadow：probe 把 before 透传给 store.search', () => {
  let seen = null;
  const store = { search(_q, opts) { seen = opts; return { hits: [], scanned: 0 }; } };
  const shadow = createShadowRetriever({ store, file: file('shadow') });
  shadow.probe({ key: 'g', query: 'x', before: 123 });
  assert.equal(seen.filter.key, 'g');
  assert.equal(seen.filter.before, 123);
});
