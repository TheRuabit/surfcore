import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ANALYSIS_VERSION, parseAnalysisJson, normalizeAnalysis,
  analysisCachePath, loadCachedAnalysis, saveCachedAnalysis,
} from '../plugins/surfcore/command-plugins/daily-report/lib/analysis.js';

const MEMBERS = [
  { card: '寻玉型大肥鱼', nickname: 'x' },
  { card: '荀彧三号机()', nickname: 'y' },
];

test('解析：纯 JSON', () => {
  assert.deepEqual(parseAnalysisJson('{"verdict":"ok"}'), { verdict: 'ok' });
});

test('解析：代码块包裹', () => {
  const text = '好的' + String.fromCharCode(96, 96, 96) + 'json' + String.fromCharCode(10) + '{"verdict":"code"}' + String.fromCharCode(10) + String.fromCharCode(96, 96, 96);
  assert.deepEqual(parseAnalysisJson(text), { verdict: 'code' });
});

test('解析：前后带解释文字', () => {
  assert.deepEqual(parseAnalysisJson('分析如下 {"verdict":"mix"} 以上'), { verdict: 'mix' });
});

test('解析：非 JSON 返回 null', () => {
  assert.equal(parseAnalysisJson('完全不是 JSON'), null);
  assert.equal(parseAnalysisJson(''), null);
  assert.equal(parseAnalysisJson(null), null);
});

test('规范化：编造的昵称被剔除', () => {
  const raw = {
    topics: [{ title: '抽老婆', who: '甲' }],
    titles: [
      { name: '寻玉型大肥鱼', title: '群草', reason: '话多' },
      { name: '不存在的人', title: '幽灵', reason: '编的' },
    ],
    ghost: [{ name: '荀彧三号机()', reason: '像bot' }],
    verdict: '今天很热闹',
  };
  const n = normalizeAnalysis(raw, MEMBERS);
  assert.equal(n.titles.length, 1);
  assert.equal(n.titles[0].name, '寻玉型大肥鱼');
  assert.equal(n.ghost[0].name, '荀彧三号机()');
  assert.equal(n.version, ANALYSIS_VERSION);
});

test('规范化：全空时返回 null（调用方据此退回统计版）', () => {
  assert.equal(normalizeAnalysis({ topics: [], titles: [], verdict: '' }, MEMBERS), null);
  assert.equal(normalizeAnalysis(null, MEMBERS), null);
});

test('规范化：字段长度被裁剪', () => {
  const long = '啊'.repeat(200);
  const n = normalizeAnalysis({
    topics: [{ title: long, who: long }],
    titles: [{ name: '寻玉型大肥鱼', title: long, reason: long }],
    verdict: long,
  }, MEMBERS);
  assert.ok(n.topics[0].title.length <= 18);
  assert.ok(n.titles[0].title.length <= 14);
  assert.ok(n.verdict.length <= 60);
});

test('缓存：命中 / 版本失效 / 未命中', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-cache-'));
  try {
    const analysis = { version: ANALYSIS_VERSION, topics: [{ title: 'a', who: 'b' }], titles: [], ghost: [], verdict: 'x' };
    const file = saveCachedAnalysis(dir, '824266596', '2026-11-06', analysis);
    assert.ok(file, '应返回写入路径');
    assert.match(file, /group-824266596/);
    assert.match(file, /2026-11-06\.json$/);

    const hit = loadCachedAnalysis(dir, '824266596', '2026-11-06');
    assert.equal(hit.verdict, 'x');

    // 版本不符 -> 当没有
    fs.writeFileSync(file, JSON.stringify({ version: ANALYSIS_VERSION + 99, verdict: 'old' }), 'utf8');
    assert.equal(loadCachedAnalysis(dir, '824266596', '2026-11-06'), null);

    // 不同日期 -> 未命中
    assert.equal(loadCachedAnalysis(dir, '824266596', '2026-11-07'), null);

    // 目录不存在 -> 不抛
    assert.equal(loadCachedAnalysis(path.join(dir, 'nope'), '1', '2026-11-06'), null);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('缓存路径：非法群号/日期不越界', () => {
  const p = analysisCachePath('/tmp/x', '../../etc', '../../../bad');
  assert.ok(!p.includes('..'), '不能出现路径穿越：' + p);
  assert.match(p, /group-unknown/);
});