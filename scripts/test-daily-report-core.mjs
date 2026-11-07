import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateMessages, renderReport, isReportable, normalizeText } from '../src/daily-report-core.js';

const T = (h) => Date.parse('2026-11-06T' + String(h).padStart(2, '0') + ':00:00+08:00');

function msg(h, userId, sender, text) {
  return { at: T(h), userId, sender, text };
}

test('过滤：空 / 纯媒体 / 命令 / 单字都不进报告', () => {
  assert.equal(isReportable(''), false);
  assert.equal(isReportable('   '), false);
  assert.equal(isReportable('嗯'), false);
  assert.equal(isReportable('/今日群报'), false);
  assert.equal(isReportable('[图片]'), false);
  assert.equal(isReportable('[表情:给你糖吃]'), false);
  assert.equal(isReportable('[转发消息 id=123]'), false);
  assert.equal(isReportable('铸币月眠'), true);
});

test('空输入：total=0，render 返回空串（调用方据此不回话）', () => {
  const agg = aggregateMessages([], { dayKey: '2026-11-06' });
  assert.equal(agg.total, 0);
  assert.equal(agg.users, 0);
  assert.equal(renderReport(agg), '');
});

test('自己发的消息计入统计，但不进金句', () => {
  const agg = aggregateMessages([
    { ...msg(10, '1', '甲', '你好呀今天过得怎么样'), isSelf: false },
    { ...msg(11, '9', '我', '这是我的回复'), isSelf: true },
  ], { dayKey: '2026-11-06' });
  // 话痨榜要能统计她自己说了多少
  assert.equal(agg.total, 2);
  assert.equal(agg.users, 2);
  // 但金句只摘群友的话
  assert.equal(agg.picks.length, 1);
  assert.equal(agg.picks[0].name, '甲');
});

test('includeSelf=false 时自己完全不计入', () => {
  const agg = aggregateMessages([
    { ...msg(10, '1', '甲', '你好呀今天过得怎么样'), isSelf: false },
    { ...msg(11, '9', '我', '这是我的回复'), isSelf: true },
  ], { dayKey: '2026-11-06', includeSelf: false });
  assert.equal(agg.total, 1);
});

test('每用户保底采样：三人各 3 条，perUser=2 时每人最多 2 条', () => {
  const msgs = [];
  for (const [uid, name] of [['1', '甲'], ['2', '乙'], ['3', '丙']]) {
    msgs.push(msg(10, uid, name, name + '的第一句话'));
    msgs.push(msg(11, uid, name, name + '的第二句稍微长一点点'));
    msgs.push(msg(12, uid, name, name + '的第三句话最长了啊啊'));
  }
  const agg = aggregateMessages(msgs, { dayKey: '2026-11-06', perUser: 2, picks: 0 });
  assert.equal(agg.users, 3);
  const byName = {};
  for (const p of agg.picks) byName[p.name] = (byName[p.name] || 0) + 1;
  assert.equal(byName['甲'], 2);
  assert.equal(byName['乙'], 2);
  assert.equal(byName['丙'], 2);
});

test('全群最长并入：picks 会捞到全群最长的那几条', () => {
  const msgs = [
    msg(10, '1', '甲', '短句'),
    msg(11, '2', '乙', '这是一句特别特别长的消息用来测试全群最长的采样逻辑是不是真的生效了'),
  ];
  const agg = aggregateMessages(msgs, { dayKey: '2026-11-06', perUser: 0, picks: 1 });
  assert.equal(agg.picks.length, 1);
  assert.match(agg.picks[0].text, /特别特别长/);
});

test('去重：同一用户同一句话只出现一次', () => {
  const same = msg(10, '1', '甲', '重复的一句话');
  const agg = aggregateMessages([same, same], { dayKey: '2026-11-06', perUser: 2, picks: 2 });
  assert.equal(agg.picks.length, 1);
});

test('精选每条截断到 60 字', () => {
  const long = '啊'.repeat(200);
  const agg = aggregateMessages([msg(10, '1', '甲', long)], { dayKey: '2026-11-06', perUser: 2, picks: 1 });
  assert.equal(agg.picks[0].text.length, 60);
});

test('日切按 UTC+8：01:00 和 23:00 落在同一小时图的两端', () => {
  const agg = aggregateMessages([
    msg(1, '1', '甲', '凌晨一点说话'),
    msg(23, '2', '乙', '晚上十一点说话'),
  ], { dayKey: '2026-11-06' });
  assert.equal(agg.hourHistogram[1], 1);
  assert.equal(agg.hourHistogram[23], 1);
});

test('渲染：包含日期/条数/人数/精选', () => {
  const agg = aggregateMessages([
    msg(10, '1', '甲', '今天天气不错啊'),
    msg(11, '2', '乙', '铸币月眠'),
  ], { dayKey: '2026-11-06' });
  const out = renderReport(agg, { title: '今日群报' });
  assert.match(out, /今日群报/);
  assert.match(out, /2026-11-06/);
  assert.match(out, /共 2 条 · 2 人参与/);
  assert.match(out, /今日精选/);
});
test('规范化：markdown @mention 的 mqqapi 链接被剥掉', () => {
  const raw = '@甜心信仰酱(超鬼王特供版)[@甜心信仰酱(超鬼王特供版)](mqqapi://markdown/mention?at_type=1&at_tinyid=378) 在吗';
  const out = normalizeText(raw);
  // 前导 @ 会被剥掉：报告里不需要"在叫谁"，读者看上下文就知道
  assert.equal(out, '甜心信仰酱(超鬼王特供版) 在吗');
  assert.ok(!out.includes('mqqapi'), '内部协议不该进报告');
});

test('规范化：独立的 mqqapi 链接被移除，不留空壳', () => {
  assert.equal(normalizeText('看这个 mqqapi://markdown/mention?at_type=1 好'), '看这个 好');
  assert.equal(normalizeText('  多个   空格  '), '多个 空格');
});

test('渲染：总长度受 maxChars 限制，超长时收口', () => {
  const msgs = [];
  for (let i = 0; i < 40; i++) {
    msgs.push({ at: T(10 + (i % 12)), userId: String(i % 8), sender: 'U' + (i % 8), text: '这是一句话'.repeat(5) + i });
  }
  const agg = aggregateMessages(msgs, { dayKey: '2026-11-06', perUser: 2, picks: 40 });
  const out = renderReport(agg, { maxChars: 300 });
  assert.ok(out.length <= 340, '渲染结果应受 maxChars 约束，实际 ' + out.length);
  assert.match(out, /完整版见本地报告文件/);
});