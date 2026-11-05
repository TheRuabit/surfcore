import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCommandHost } from '../src/command-host.js';
import { createCommandLog } from '../src/command-log.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-command-host-'));
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

function writePlugin(dir, id, code, patch = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id,
    name: id,
    version: '0.1.0',
    description: 'test',
    entry: 'index.js',
    enabled: false,
    capabilities: ['qq.command'],
    platforms: ['qq'],
    ...patch,
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'index.js'), code, 'utf8');
}

const PLUGIN = `
export async function activate(api) {
  api.commands.register({ name: '回声', aliases: ['echo'], permission: 'user', handler: async (_ctx, args) => ({ text: 'back:' + args }) });
  api.commands.register({ name: '管理员命令', aliases: ['admincmd'], permission: 'admin', handler: async () => ({ text: 'admin-ok' }) });
  api.commands.register({ name: '炸', aliases: ['boom'], permission: 'user', handler: async () => { throw new Error('boom'); } });
}
`;

function makeHost({ ratePerMinute = 30 } = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'h-'));
  const builtin = path.join(dir, 'builtin');
  const user = path.join(dir, 'user');
  fs.mkdirSync(builtin, { recursive: true });
  fs.mkdirSync(user, { recursive: true });
  const logFile = path.join(dir, 'command-log.jsonl');
  const commandLog = createCommandLog({ file: logFile, maxEntries: 200 });
  const replies = [];
  const host = createCommandHost({
    dirs: [builtin, user],
    stateFile: path.join(dir, 'plugins.json'),
    dataRoot: path.join(dir, 'data'),
    commandLog,
    sendReply: async (key, result) => { replies.push([key, result]); },
    ratePerMinute,
    log: () => {},
  });
  return { dir, builtin, user, commandLog, host, replies };
}

const ctx = (overrides = {}) => ({
  key: 'group:1', kind: 'group', groupId: '1', userId: '2', senderName: '群友',
  isOwner: false, messageId: 'm1', raw: '/回声 hi', ...overrides,
});

test('宿主：启用/用户命令/管理员命令/异常/禁用', async () => {
  const { builtin, commandLog, host, replies } = makeHost();
  writePlugin(path.join(builtin, 'demo'), 'demo', PLUGIN);
  await host.load();
  assert.equal(host.list().plugins.length, 1);
  assert.equal(host.list().plugins[0].enabled, false);

  await host.setEnabled('demo', true);
  let result = await host.dispatch(ctx());
  assert.equal(result.matched, true);
  assert.deepEqual(replies[0], ['group:1', { text: 'back:hi' }]);
  assert.equal(commandLog.tail().entries.at(-1).outcome, 'ok');

  result = await host.dispatch(ctx({ raw: '/管理员命令' }));
  assert.equal(result.outcome, 'denied');
  assert.equal(replies.length, 1);
  assert.equal(commandLog.tail().entries.at(-1).code, 'not-owner');

  result = await host.dispatch(ctx({ raw: '/管理员命令', isOwner: true }));
  assert.equal(result.outcome, 'ok');
  assert.deepEqual(replies[1], ['group:1', { text: 'admin-ok' }]);

  result = await host.dispatch(ctx({ raw: '/炸' }));
  assert.equal(result.outcome, 'error');
  const errEntry = commandLog.tail().entries.at(-1);
  assert.equal(errEntry.code, 'plugin-error');
  assert.ok(errEntry.hint);
  assert.equal(replies.length, 2);

  await host.setEnabled('demo', false);
  result = await host.dispatch(ctx());
  assert.equal(result.outcome, 'denied');
  assert.equal(commandLog.tail().entries.at(-1).code, 'plugin-disabled');
  assert.equal(replies.length, 2);
  await host.close();
});

test('宿主：未知命令不匹配，限流只日志', async () => {
  const { builtin, commandLog, host, replies } = makeHost({ ratePerMinute: 1 });
  writePlugin(path.join(builtin, 'demo'), 'demo', PLUGIN);
  await host.load();
  await host.setEnabled('demo', true);

  let result = await host.dispatch(ctx({ raw: '/不存在' }));
  assert.equal(result.matched, false);

  result = await host.dispatch(ctx({ raw: '/回声 1' }));
  assert.equal(result.outcome, 'ok');
  result = await host.dispatch(ctx({ raw: '/回声 2' }));
  assert.equal(result.outcome, 'rate-limited');
  assert.equal(replies.length, 1);
  assert.equal(commandLog.tail({ outcome: 'rate-limited' }).entries.length, 1);
  await host.close();
});

test('宿主：两个目录发现、用户目录插件可启用、状态可持久化', async () => {
  const { dir, user, host } = makeHost();
  writePlugin(path.join(user, 'u1'), 'u1', PLUGIN);
  await host.load();
  await host.setEnabled('u1', true);
  assert.equal(host.list().plugins.find((p) => p.id === 'u1').source, 'user');
  await host.close();

  const commandLog = createCommandLog({ file: path.join(dir, 'command-log.jsonl') });
  const host2 = createCommandHost({
    dirs: [path.join(dir, 'builtin'), user],
    stateFile: path.join(dir, 'plugins.json'),
    dataRoot: path.join(dir, 'data'),
    commandLog,
    sendReply: async () => {},
    log: () => {},
  });
  await host2.load();
  assert.equal(host2.list().plugins.find((p) => p.id === 'u1').loaded, true);
  await host2.close();
});

test('宿主：用户目录插件 manifest 自报 enabled=true 也不自动加载', async () => {
  const { user, host } = makeHost();
  writePlugin(path.join(user, 'auto'), 'auto', PLUGIN, { enabled: true });
  const listed = await host.load();
  const item = listed.plugins.find((p) => p.id === 'auto');
  assert.equal(item.enabled, false);
  assert.equal(item.loaded, false);
  await host.setEnabled('auto', true);
  assert.equal(host.list().plugins.find((p) => p.id === 'auto').loaded, true);
  await host.close();
});

test('宿主：重复 id / 路径穿越拒绝加载', async () => {
  const dir = fs.mkdtempSync(path.join(root, 'bad-'));
  const builtin = path.join(dir, 'builtin');
  const user = path.join(dir, 'user');
  fs.mkdirSync(builtin, { recursive: true });
  fs.mkdirSync(user, { recursive: true });
  writePlugin(path.join(builtin, 'dup'), 'dup', PLUGIN);
  writePlugin(path.join(user, 'dup'), 'dup', PLUGIN);
  writePlugin(path.join(builtin, 'escape'), 'escape', PLUGIN, { entry: '../evil.js' });
  const host = createCommandHost({
    dirs: [builtin, user],
    stateFile: path.join(dir, 'plugins.json'),
    dataRoot: path.join(dir, 'data'),
    sendReply: async () => {},
    log: () => {},
  });
  const listed = await host.load();
  assert.ok(listed.errors.some((item) => item.error === 'duplicate-id'));
  assert.ok(listed.errors.some((item) => /不能跳出/.test(item.error)));
  assert.equal(listed.plugins.find((p) => p.id === 'escape'), undefined);
  await host.close();
});
