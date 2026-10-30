// 黑话候选发现器：纯函数 + cursor 幂等测试（2026-10-30）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseExtractedTerms,
  buildExtractPrompt,
  pickContext,
  EXTRACTOR_SYSTEM,
  createSlangExtractor,
} from '../src/slang-extractor.js';

const tmpdir = () => fs.mkdtempSync(path.join(process.cwd(), '_tmp-slang-'));

test('parseExtractedTerms：纯数组', () => {
  const out = parseExtractedTerms('[{"term":"瑞","guess":"respect","evidence":["瑞"]}]');
  assert.equal(out.length, 1);
  assert.equal(out[0].term, '瑞');
  assert.deepEqual(out[0].evidence, ['瑞']);
});

test('parseExtractedTerms：带围栏和前后废话', () => {
  const fence = String.fromCharCode(96).repeat(3);
  const text = '好的，我找到了：\n' + fence + 'json\n[{"term":"急了","guess":"反讽"} ]\n' + fence + '\n以上。';
  const out = parseExtractedTerms(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].term, '急了');
});

test('parseExtractedTerms：空数组 / 垃圾输入', () => {
  assert.deepEqual(parseExtractedTerms('[]'), []);
  assert.deepEqual(parseExtractedTerms(''), []);
  assert.deepEqual(parseExtractedTerms('不是 JSON'), []);
  assert.deepEqual(parseExtractedTerms(null), []);
});

test('parseExtractedTerms：单对象也接受', () => {
  const out = parseExtractedTerms('{"term":"葛叶","guess":"阴阳师角色名"}');
  assert.equal(out.length, 1);
  assert.equal(out[0].term, '葛叶');
});

test('buildExtractPrompt：只有固定 system + 上文 + 本批，没有历史', () => {
  const msgs = [{ seq: 10, sender: '甲', plain: '他又开始葛叶了' }];
  const ctx = [{ seq: 9, sender: '乙', plain: '葛叶是谁' }];
  const p = buildExtractPrompt(msgs, ctx);
  assert.equal(p.system, EXTRACTOR_SYSTEM);
  assert.match(p.user, /\[10\] 甲/);
  assert.match(p.user, /乙: 葛叶是谁/);   // 上文只带"谁说了什么"，不带 seq（它不参与找词）
  assert.ok(p.user.length < 2000, '单批 prompt 必须很小');
});

test('pickContext：只取尾巴且上限正确', () => {
  const before = [1, 2, 3, 4, 5, 6].map((n) => ({ seq: n }));
  assert.deepEqual(pickContext(before, 2).map((x) => x.seq), [5, 6]);
  assert.deepEqual(pickContext([], 4), []);
  assert.deepEqual(pickContext(before, 0), []);
});

test('cursor 幂等：重复跑不会重复处理', async () => {
  const dir = tmpdir();
  const added = [];
  let calls = 0;
  const ex = createSlangExtractor({
    stateDir: dir,
    loadMessages: () => ({
      messages: [
        { seq: 1, sender: '甲', plain: '瑞' },
        { seq: 2, sender: '乙', plain: '瑞' },
        { seq: 3, sender: '丙', plain: '瑞一下' },
      ],
    }),
    askModel: async () => {
      calls += 1;
      return '[{"term":"瑞","guess":"respect","evidence":["瑞"]}]';
    },
    onCandidate: (x) => added.push(x.term),
    minMessages: 1,
    cooldownMs: 0,
  });
  const first = await ex.runOnce('group:1');
  assert.equal(first.ok, true);
  assert.equal(first.processed, 3);
  assert.equal(first.found, 1);
  const second = await ex.runOnce('group:1');
  assert.equal(second.skipped, 'not-enough', '同一批不该再跑');
  assert.equal(calls, 1, '模型只该被调用一次');
  assert.deepEqual(added, ['瑞'], '候选不该重复写');
  const st = ex.status();
  assert.equal(st.cursors['group:1'], 3);
});

test('没有新消息时不推进 cursor', async () => {
  const dir = tmpdir();
  const ex = createSlangExtractor({
    stateDir: dir,
    loadMessages: () => ({ messages: [{ seq: 1, sender: '甲', plain: 'hi' }] }),
    askModel: async () => '[]',
    minMessages: 5,
    cooldownMs: 0,
  });
  const r = await ex.runOnce('group:1');
  assert.equal(r.skipped, 'not-enough');
  assert.equal(ex.status().cursors['group:1'], undefined);
});

test('模型失败时不写 cursor（下轮可重试）', async () => {
  const dir = tmpdir();
  const ex = createSlangExtractor({
    stateDir: dir,
    loadMessages: () => ({ messages: [{ seq: 1, sender: '甲', plain: 'a' }, { seq: 2, sender: '乙', plain: 'b' }] }),
    askModel: async () => { throw new Error('boom'); },
    minMessages: 1,
    cooldownMs: 0,
  });
  const r = await ex.runOnce('group:1');
  assert.equal(r.skipped, 'model-failed');
  assert.equal(ex.status().cursors['group:1'], undefined, '失败不能推进 cursor');
});

test('resetCursor 只清指针，不动其它会话', async () => {
  const dir = tmpdir();
  const ex = createSlangExtractor({
    stateDir: dir,
    loadMessages: () => ({ messages: [{ seq: 1, sender: '甲', plain: 'a' }] }),
    askModel: async () => '[]',
    minMessages: 1,
    cooldownMs: 0,
  });
  await ex.runOnce('group:1');
  await ex.runOnce('group:2');
  const st0 = ex.status();
  assert.equal(st0.cursors['group:1'], 1);
  const r = ex.resetCursor('group:1');
  assert.equal(r.cursors['group:1'], undefined);
  assert.equal(r.cursors['group:2'], 1);
});
