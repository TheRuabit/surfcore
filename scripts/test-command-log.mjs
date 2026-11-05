import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCommandLog } from '../src/command-log.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-command-log-'));
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

test('命令日志：追加/查询/过滤/脱敏', () => {
  const file = path.join(root, 'log.jsonl');
  const log = createCommandLog({ file, maxEntries: 50, sanitize: (s) => String(s).replace(/secret\d+/g, '***') });
  log.append({ outcome: 'ok', code: '', raw: '/回声 secret123', actorName: '群友', command: '回声', plugin: 'example', reply: true });
  log.append({ outcome: 'denied', code: 'not-owner', raw: '/status', actorName: '群友', hint: '仅管理员可用' });
  const all = log.tail();
  assert.equal(all.entries.length, 2);
  assert.equal(all.entries[0].raw, '/回声 ***');
  assert.equal(all.entries[0].reply, true);
  assert.equal(log.tail({ outcome: 'denied' }).entries.length, 1);
  assert.equal(log.tail({ q: '/status' }).entries.length, 1);
  assert.equal(log.tail({ since: all.entries[0].seq }).entries.length, 1);
});

test('命令日志：达到上限轮转，当前文件只保留新条目', () => {
  const file = path.join(root, 'small.jsonl');
  const log = createCommandLog({ file, maxEntries: 2 });
  for (let i = 0; i < 4; i += 1) log.append({ outcome: 'ok', raw: `/${i}` });
  assert.equal(log.tail().entries.length, 2);
  assert.ok(fs.existsSync(`${file}.1`));
  const stats = log.stats();
  assert.equal(stats.count, 2);
});

test('命令日志：clear 会备份旧文件', () => {
  const file = path.join(root, 'clear.jsonl');
  const log = createCommandLog({ file });
  log.append({ outcome: 'ok', raw: '/x' });
  log.clear();
  assert.equal(log.tail().entries.length, 0);
  assert.ok(fs.existsSync(`${file}.1`));
});
