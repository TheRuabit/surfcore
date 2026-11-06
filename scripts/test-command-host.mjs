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

test('宿主：未知命令留痕，限流只日志', async () => {
  const { builtin, commandLog, host, replies } = makeHost({ ratePerMinute: 1 });
  writePlugin(path.join(builtin, 'demo'), 'demo', PLUGIN);
  await host.load();
  await host.setEnabled('demo', true);

  // 未注册的斜杠命令必须 matched:true：否则桥接会把它当普通消息投给 DSH。
  let result = await host.dispatch(ctx({ raw: '/不存在' }));
  assert.equal(result.matched, true);
  assert.equal(result.outcome, 'unknown');
  assert.equal(replies.length, 0);

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
const PLUGIN_SCOPED = `
export async function activate(api) {
  api.commands.register({ name: '仅群', aliases: ['grouponly'], permission: 'user', scopes: ['group'], handler: async () => ({ text: 'group-ok' }) });
  api.commands.register({ name: '仅私聊', aliases: ['privateonly'], permission: 'user', scopes: ['private'], handler: async () => ({ text: 'private-ok' }) });
}
`;

test('宿主：scopes 生效，不匹配只记日志不回 QQ', async () => {
  const { builtin, commandLog, host, replies } = makeHost();
  writePlugin(path.join(builtin, 'scoped'), 'scoped', PLUGIN_SCOPED);
  await host.load();
  await host.setEnabled('scoped', true);

  let result = await host.dispatch(ctx({ raw: '/仅群' }));
  assert.equal(result.outcome, 'ok');
  assert.equal(replies.length, 1);

  result = await host.dispatch(ctx({ raw: '/仅群', kind: 'private', key: 'private:2' }));
  assert.equal(result.outcome, 'denied');
  assert.equal(commandLog.tail().entries.at(-1).code, 'scope-mismatch');
  assert.equal(replies.length, 1);

  result = await host.dispatch(ctx({ raw: '/仅私聊' }));
  assert.equal(result.outcome, 'denied');
  assert.equal(commandLog.tail().entries.at(-1).code, 'scope-mismatch');
  assert.equal(replies.length, 1);

  result = await host.dispatch(ctx({ raw: '/仅私聊', kind: 'private', key: 'private:2' }));
  assert.equal(result.outcome, 'ok');
  assert.equal(replies.length, 2);
  await host.close();
});

test('宿主：未知命令写日志并标记 matched（不进 DSH）', async () => {
  const { builtin, commandLog, host, replies } = makeHost();
  writePlugin(path.join(builtin, 'demo'), 'demo', PLUGIN);
  await host.load();
  await host.setEnabled('demo', true);

  const result = await host.dispatch(ctx({ raw: '/不存在的命令' }));
  assert.equal(result.matched, true);
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.code, 'unknown-command');
  const entry = commandLog.tail().entries.at(-1);
  assert.equal(entry.outcome, 'unknown');
  assert.equal(entry.code, 'unknown-command');
  assert.ok(entry.hint, 'unknown 必须带 hint');
  assert.equal(replies.length, 0);
  await host.close();
});

test('宿主：慢插件超时，记 plugin-timeout 且不回 QQ', async () => {
  const dir = fs.mkdtempSync(path.join(root, 'slow-'));
  const builtin = path.join(dir, 'builtin');
  fs.mkdirSync(builtin, { recursive: true });
  writePlugin(path.join(builtin, 'slow'), 'slow', `
export async function activate(api) {
  api.commands.register({ name: '慢', permission: 'user', handler: async () => { await new Promise((r) => setTimeout(r, 3000)); return { text: 'late' }; } });
}
`);
  const commandLog = createCommandLog({ file: path.join(dir, 'log.jsonl') });
  const replies = [];
  const host = createCommandHost({
    dirs: [builtin],
    stateFile: path.join(dir, 'plugins.json'),
    dataRoot: path.join(dir, 'data'),
    commandLog,
    sendReply: async (key, result) => { replies.push([key, result]); },
    handlerTimeoutMs: 600,
    log: () => {},
  });
  await host.load();
  await host.setEnabled('slow', true);
  const result = await host.dispatch(ctx({ raw: '/慢' }));
  assert.equal(result.outcome, 'error');
  assert.equal(commandLog.tail().entries.at(-1).code, 'plugin-timeout');
  assert.ok(commandLog.tail().entries.at(-1).hint);
  assert.equal(replies.length, 0);
  await host.close();
});

test('宿主：激活失败的插件不会把 enabled=true 落盘', async () => {
  const dir = fs.mkdtempSync(path.join(root, 'broken-'));
  const builtin = path.join(dir, 'builtin');
  fs.mkdirSync(builtin, { recursive: true });
  writePlugin(path.join(builtin, 'broken'), 'broken', 'export async function activate() { throw new Error("激活失败"); }');
  const stateFile = path.join(dir, 'plugins.json');
  const host = createCommandHost({
    dirs: [builtin],
    stateFile,
    dataRoot: path.join(dir, 'data'),
    sendReply: async () => {},
    log: () => {},
  });
  await host.load();
  await assert.rejects(() => host.setEnabled('broken', true), /激活失败/);
  // 激活失败时状态文件可能压根没生成；只要存在就不能留下 enabled:true。
  if (fs.existsSync(stateFile)) {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.notEqual(saved.enabled?.broken, true, '激活失败却把 enabled=true 写进了状态文件');
  }
  const item = host.list().plugins.find((p) => p.id === 'broken');
  assert.equal(item.loaded, false);
  assert.equal(item.enabled, false, '激活失败的插件不该显示为已启用');
  await host.close();
});

test('宿主：api.qq.messages 透传 readMessages，失败原样返回', async () => {
  const dir = fs.mkdtempSync(path.join(root, 'msgs-'));
  const builtin = path.join(dir, 'builtin');
  fs.mkdirSync(builtin, { recursive: true });
  writePlugin(path.join(builtin, 'msgplug'), 'msgplug', `
export async function activate(api) {
  api.commands.register({ name: '取消息', permission: 'user', handler: async (ctx) => {
    const r = await api.qq.messages({ key: ctx.key, since: 0, until: Date.now() });
    return { silent: true, __r: r };
  } });
}
`);
  const seen = [];
  const host = createCommandHost({
    dirs: [builtin],
    stateFile: path.join(dir, 'plugins.json'),
    dataRoot: path.join(dir, 'data'),
    sendReply: async () => {},
    readMessages: async ({ key, since, until }) => {
      seen.push({ key, since, until });
      return { ok: true, messages: [{ at: 1, userId: '1', sender: '甲', text: 'hi', isSelf: false }], total: 1, truncated: false };
    },
    log: () => {},
  });
  await host.load();
  await host.setEnabled('msgplug', true);
  const r = await host.dispatch(ctx({ raw: '/取消息' }));
  assert.equal(r.outcome, 'ok');
  assert.equal(seen.length, 1, 'readMessages 没被调用');
  assert.equal(seen[0].key, 'group:1');
  await host.close();
});

test('宿主：没有 readMessages 时返回 not-supported 而不是崩溃', async () => {
  const dir = fs.mkdtempSync(path.join(root, 'nomsg-'));
  const builtin = path.join(dir, 'builtin');
  fs.mkdirSync(builtin, { recursive: true });
  writePlugin(path.join(builtin, 'msgplug'), 'msgplug', `
export async function activate(api) {
  api.commands.register({ name: '取消息', permission: 'user', handler: async (ctx) => {
    const r = await api.qq.messages({ key: ctx.key });
    throw new Error(JSON.stringify(r));
  } });
}
`);
  const commandLog = createCommandLog({ file: path.join(dir, 'log.jsonl') });
  const host = createCommandHost({
    dirs: [builtin],
    stateFile: path.join(dir, 'plugins.json'),
    dataRoot: path.join(dir, 'data'),
    commandLog,
    sendReply: async () => {},
    log: () => {},
  });
  await host.load();
  await host.setEnabled('msgplug', true);
  const r = await host.dispatch(ctx({ raw: '/取消息' }));
  assert.equal(r.outcome, 'error');
  const entry = commandLog.tail().entries.at(-1);
  assert.equal(entry.code, 'plugin-error');
  assert.match(String(entry.message), /not-supported/, '应返回 not-supported 而非抛异常');
  await host.close();
});