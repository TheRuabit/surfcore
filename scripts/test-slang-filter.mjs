import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlangFilter, extractTerms } from '../src/slang-filter.js';

const KEY = 'group:1';

test('切块：按标点切，去掉 @、图片、链接', () => {
  // @对象本身不该进候选，但它后面的文字要保留。
  assert.deepEqual(extractTerms('@某人 你好'), ['你好']);
  assert.deepEqual(extractTerms('[图片]'), []);
  assert.deepEqual(extractTerms('https://example.com/abc'), []);
  const t = extractTerms('破防了，兄弟们！');
  assert.ok(t.includes('破防了'), JSON.stringify(t));
  assert.ok(t.includes('兄弟们'), JSON.stringify(t));
});

test('切块：长度边界 2~10', () => {
  assert.deepEqual(extractTerms('啊'), []);
  const long = '这是一个非常非常长的句子超过限制';
  for (const t of extractTerms(long)) assert.ok([...t].length <= 10);
  // 整块超过 10 字时整块被丢，不做滑窗（滑窗在真实数据上产出 0 个可用词）。
  assert.deepEqual(extractTerms('一二三四五六七八九十一二三'), []);
});

test('切块：停用词单独出现时被挡', () => {
  for (const w of ['的', '了', '是', '在', '哈哈', '好的']) {
    assert.deepEqual(extractTerms(w), [], `停用词 ${w} 不该进候选`);
  }
});

test('预筛：频次不到门槛不出候选', () => {
  const f = createSlangFilter();
  for (let i = 0; i < 3; i++) f.updateFromMessage('杂口杂口', KEY, String(100 + i));
  assert.equal(f.getCandidates(KEY).length, 0, '频次 3 < 5 不该出候选');
  for (let i = 3; i < 5; i++) f.updateFromMessage('杂口杂口', KEY, String(100 + i));
  assert.equal(f.getCandidates(KEY).length, 1);
});

test('预筛：只有 1 个用户的词被挡（bot 固定话术）', () => {
  const f = createSlangFilter();
  for (let i = 0; i < 10; i++) f.updateFromMessage('剩余抽取次数', KEY, '999');
  assert.equal(f.getCandidates(KEY).length, 0, '单人高频应被挡住');
});

test('预筛：>=2 用户才进候选', () => {
  const f = createSlangFilter();
  for (let i = 0; i < 5; i++) f.updateFromMessage('杂口杂口', KEY, i % 2 === 0 ? '1' : '2');
  const c = f.getCandidates(KEY);
  assert.equal(c.length, 1);
  assert.equal(c[0].term, '杂口杂口');
  assert.equal(c[0].distinctUsers, 2);
});

test('预筛：exclude 生效，已确认的词不再重复研究', () => {
  const f = createSlangFilter();
  for (let i = 0; i < 6; i++) f.updateFromMessage('杂口杂口', KEY, i % 2 === 0 ? '1' : '2');
  assert.equal(f.getCandidates(KEY, { exclude: ['杂口杂口'] }).length, 0);
});

test('预筛：分数在 0..1 且能区分高低', () => {
  const f = createSlangFilter();
  for (let i = 0; i < 20; i++) f.updateFromMessage('高频黑话', KEY, i % 2 === 0 ? '1' : '2');
  for (let i = 0; i < 5; i++) f.updateFromMessage('低频黑话', KEY, i % 2 === 0 ? '3' : '4');
  const c = f.getCandidates(KEY);
  for (const x of c) {
    assert.ok(x.score >= 0 && x.score <= 1, `分数越界: ${x.term}=${x.score}`);
    assert.ok(x.idf >= 0 && x.idf <= 1);
    assert.ok(x.burst >= 0 && x.burst <= 1);
    assert.ok(x.concentration >= 0 && x.concentration <= 1);
  }
  const high = c.find((x) => x.term === '高频黑话');
  const low = c.find((x) => x.term === '低频黑话');
  assert.ok(high.score > low.score, '高频应排在低频前');
});

test('预筛：跨群 IDF 生效（只在某个群出现的词分更高）', () => {
  const f = createSlangFilter();
  for (let i = 0; i < 6; i++) {
    f.updateFromMessage('本群专属', 'group:1', i % 2 === 0 ? '1' : '2');
    f.updateFromMessage('两个群都有', 'group:1', i % 2 === 0 ? '1' : '2');
    f.updateFromMessage('两个群都有', 'group:2', i % 2 === 0 ? '3' : '4');
  }
  const c = f.getCandidates('group:1');
  const only = c.find((x) => x.term === '本群专属');
  const both = c.find((x) => x.term === '两个群都有');
  assert.ok(only.idf > both.idf, '只在本群出现的词 IDF 应更高');
});

test('预筛：resetGroup 清空单群数据', () => {
  const f = createSlangFilter();
  for (let i = 0; i < 6; i++) f.updateFromMessage('杂口杂口', KEY, i % 2 === 0 ? '1' : '2');
  assert.ok(f.getCandidates(KEY).length > 0);
  f.resetGroup(KEY);
  assert.equal(f.getCandidates(KEY).length, 0);
});
