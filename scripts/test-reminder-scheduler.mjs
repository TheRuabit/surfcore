// 定时提醒调度器测试（2026-11-03）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createReminderScheduler } from '../src/reminder-scheduler.js';

const root = fs.mkdtempSync(path.join(process.cwd(), '_tmp-reminder-'));
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });
let seq = 0;
const file = () => path.join(root, `${++seq}.json`);
const T = (s) => Date.parse(s);

test('set：未来时间入库；wake=false 到点直接发送', async () => {
  const sent = [];
  let current = T('2026-11-03T20:00:00+08:00');
  const s = createReminderScheduler({
    file: file(), now: () => current,
    sendText: async (key, text) => { sent.push([key, text]); return true; },
    wake: async () => { throw new Error('不应走 wake'); },
  });
  const r = s.set({ key: 'private:1', at: '2026-11-03T21:30:00+08:00', text: '九点半叫我', wake: false });
  assert.equal(r.ok, true);
  assert.equal(s.list().length, 1);
  await s.checkDue(T('2026-11-03T21:29:00+08:00'));
  assert.equal(sent.length, 0);
  await s.checkDue(T('2026-11-03T21:30:00+08:00'));
  assert.deepEqual(sent, [['private:1', '九点半叫我']]);
  assert.equal(s.list().length, 0);
  s.close();
});

test('wake=true 到点走唤醒，并带提醒内容', async () => {
  const woke = [];
  let current = T('2026-11-03T20:00:00+08:00');
  const s = createReminderScheduler({
    file: file(), now: () => current,
    sendText: async () => { throw new Error('不应走 sendText'); },
    wake: async (key, text, reminder) => { woke.push([key, text, reminder.at]); return true; },
  });
  assert.equal(s.set({ key: 'group:2', at: '2026-11-03T20:30:00+08:00', text: '该喝水了', wake: true }).ok, true);
  await s.checkDue(T('2026-11-03T20:30:00+08:00'));
  assert.deepEqual(woke, [['group:2', '该喝水了', '2026-11-03T12:30:00.000Z']]);
  s.close();
});

test('cancel：取消后不再触发', async () => {
  let current = T('2026-11-03T20:00:00+08:00');
  let called = 0;
  const s = createReminderScheduler({
    file: file(), now: () => current,
    sendText: async () => { called++; return true; },
    wake: async () => true,
  });
  const r = s.set({ key: 'private:1', at: '2026-11-03T21:30:00+08:00', text: 'x' });
  assert.equal(s.cancel(r.reminder.id).ok, true);
  await s.checkDue(T('2026-11-03T21:31:00+08:00'));
  assert.equal(called, 0);
  s.close();
});

test('持久化：重启后仍能看到未来提醒', () => {
  const f = file();
  let current = T('2026-11-03T20:00:00+08:00');
  const a = createReminderScheduler({ file: f, now: () => current, sendText: async () => true, wake: async () => true });
  const r = a.set({ key: 'private:1', at: '2026-11-03T22:00:00+08:00', text: '持久化' });
  a.close();
  const b = createReminderScheduler({ file: f, now: () => current, sendText: async () => true, wake: async () => true });
  b.load({ fireOverdue: false });
  assert.equal(b.list().length, 1);
  assert.equal(b.list()[0].id, r.reminder.id);
  b.close();
});

test('过期补发：30 分钟内到点会立即发；超过 30 分钟丢弃', async () => {
  const f = file();
  const now = T('2026-11-03T22:00:00+08:00');
  fs.writeFileSync(f, JSON.stringify({ reminders: [
    { id: 'rm_old', key: 'private:1', at: '2026-11-03T21:50:00+08:00', text: '补发', wake: false },
    { id: 'rm_ancient', key: 'private:1', at: '2026-11-03T19:00:00+08:00', text: '太旧', wake: false },
  ] }));
  const sent = [];
  const s = createReminderScheduler({ file: f, now: () => now, sendText: async (k, t) => { sent.push(t); return true; }, wake: async () => true });
  const loaded = s.load({ fireOverdue: false });
  assert.equal(loaded.loaded, 1);
  assert.equal(loaded.dropped, 1);
  await s.checkDue(now);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /补发/);
  s.close();
});

test('set：过去时间/空文本/缺 key 拒绝', () => {
  const s = createReminderScheduler({ file: file(), now: () => T('2026-11-03T20:00:00+08:00'), sendText: async () => true, wake: async () => true });
  assert.equal(s.set({ key: 'private:1', at: '2026-11-03T19:00:00+08:00', text: 'x' }).ok, false);
  assert.equal(s.set({ key: 'private:1', at: '2026-11-03T21:00:00+08:00', text: '' }).ok, false);
  assert.equal(s.set({ key: '', at: '2026-11-03T21:00:00+08:00', text: 'x' }).ok, false);
  s.close();
});

test('接线：bridge / MCP / preset 都有 reminder 入口', () => {
  const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(bridge, /\/api\/socialV2\/reminder/);
  assert.match(bridge, /setReminder: 'qq_set_reminder'/);
  const mcp = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8');
  assert.match(mcp, /'qq_set_reminder'/);
  const preset = fs.readFileSync(new URL('../dsh/agent-presets/qq-chat-v2/agent.cordis.yml', import.meta.url), 'utf8');
  assert.match(preset, /定时提醒/);
});
