import test from 'node:test';
import assert from 'node:assert/strict';
import { leadingSelfAtCount, resolveCommandText } from '../src/command-text.js';
import { dayKey, msUntilNextDay } from '../src/day-key.js';

const SELF = '10001';

test('群内：@机器人 /命令 才算命令', () => {
  const segs = [
    { type: 'at', data: { qq: SELF } },
    { type: 'text', data: { text: ' /回声 你好' } },
  ];
  const { count, end } = leadingSelfAtCount(segs, SELF);
  assert.equal(count, 1);
  assert.equal(end, 1);
  const r = resolveCommandText({ plainContent: '@寻玉型大肥鱼 /回声 你好', tailContent: ' /回声 你好', hadAtPrefix: true, kind: 'group' });
  assert.equal(r.isCommand, true);
  assert.equal(r.droppedBare, false);
  assert.equal(r.commandText, '/回声 你好');
});

test('群内：裸斜杠丢弃，不执行也不进 DSH', () => {
  const r = resolveCommandText({ plainContent: '/回声 你好', tailContent: '/回声 你好', hadAtPrefix: false, kind: 'group' });
  assert.equal(r.isCommand, false);
  assert.equal(r.droppedBare, true);
});

test('群内：@别人 打头不是命令', () => {
  const segs = [
    { type: 'text', data: { text: '@' } },
    { type: 'at', data: { qq: '99999' } },
    { type: 'text', data: { text: ' /回声' } },
  ];
  const { count } = leadingSelfAtCount(segs, SELF);
  assert.equal(count, 0);
  const r = resolveCommandText({ plainContent: '@别人 /回声', hadAtPrefix: false, kind: 'group' });
  assert.equal(r.isCommand, false);
  assert.equal(r.droppedBare, false);
});

test('群内：@全体 不算命令前缀', () => {
  const segs = [
    { type: 'at', data: { qq: 'all' } },
    { type: 'text', data: { text: ' /回声' } },
  ];
  assert.equal(leadingSelfAtCount(segs, SELF).count, 0);
});

test('群内：连续 @机器人 都剥掉，中间空白段跳过', () => {
  const segs = [
    { type: 'at', data: { qq: SELF } },
    { type: 'text', data: { text: '  ' } },
    { type: 'at', data: { qq: SELF } },
    { type: 'text', data: { text: ' /回声' } },
  ];
  const { count, end } = leadingSelfAtCount(segs, SELF);
  assert.equal(count, 2);
  assert.equal(end, 3);
});

test('私聊：不需要 @，裸斜杠放行', () => {
  const r = resolveCommandText({ plainContent: '/reset', tailContent: '/reset', kind: 'private' });
  assert.equal(r.isCommand, true);
  assert.equal(r.droppedBare, false);
  assert.equal(r.commandText, '/reset');
});

test('命令判定：@后不是斜杠的普通对话不是命令（保留原有对话）', () => {
  const segs = [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text: ' 你好' } }];
  const { count } = leadingSelfAtCount(segs, SELF);
  const r = resolveCommandText({ plainContent: '@鱼 你好', tailContent: ' 你好', hadAtPrefix: count > 0, kind: 'group' });
  assert.equal(r.isCommand, false);
  assert.equal(r.droppedBare, false);
  assert.equal(r.commandText, '');
});

test('日切：钉死 UTC+8，不信宿主时区', () => {
  assert.equal(dayKey(Date.parse('2026-11-05T15:59:59Z')), '2026-11-05');
  assert.equal(dayKey(Date.parse('2026-11-05T16:00:01Z')), '2026-11-06');
  assert.equal(dayKey(Date.parse('2026-11-05T00:00:00Z')), '2026-11-05');
});

test('日切：到下一个零点的毫秒数', () => {
  const noon = Date.parse('2026-11-05T04:00:00Z');
  assert.equal(msUntilNextDay(noon), 12 * 3600 * 1000);
  const justBefore = Date.parse('2026-11-05T15:59:00Z');
  assert.equal(msUntilNextDay(justBefore), 60 * 1000);
});
