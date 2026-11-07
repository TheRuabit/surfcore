import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCommandHost } from '../src/command-host.js';
import { createCommandLog } from '../src/command-log.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-daily-report-'));
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

// 插件 import 了仓库内的 src/daily-report-core.js，所以必须**原地**加载，不能复制到临时目录。
const PLUGIN_DIR = path.resolve('plugins/surfcore/command-plugins');
const DAY = '2026-11-06';
const AT = (h) => Date.parse(DAY + 'T' + String(h).padStart(2, '0') + ':00:00+08:00');

const SAMPLE = [
  { at: AT(10), userId: '1', sender: '甲', text: '今天天气不错啊', isSelf: false },
  { at: AT(11), userId: '2', sender: '乙', text: '铸币月眠', isSelf: false },
  { at: AT(12), userId: '3', sender: '丙', text: '[图片]', isSelf: false },
  { at: AT(13), userId: '1', sender: '甲', text: '/今日群报', isSelf: false },
];

function makeHost({ messages = SAMPLE } = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'h-'));
  const commandLog = createCommandLog({ file: path.join(dir, 'log.jsonl') });
  const replies = [];
  const host = createCommandHost({
    dirs: [PLUGIN_DIR],
    stateFile: path.join(dir, 'plugins.json'),
    dataRoot: path.join(dir, 'data'),
    commandLog,
    sendReply: async (key, result) => { replies.push(result); },
    readMessages: async ({ key, since, until }) => {
      if (!String(key).startsWith('group:')) {
        return { ok: false, code: 'unsupported-key', error: '只支持群聊', hint: '群报只读群聊' };
      }
      const inWindow = messages.filter((m) => m.at >= since && m.at < until);
      return { ok: true, messages: inWindow, total: inWindow.length, truncated: false };
    },
    log: () => {},
  });
  return { dir, host, replies, commandLog };
}

const ctx = (over = {}) => ({
  key: 'group:999', kind: 'group', groupId: '999', userId: '2', senderName: '群友',
  isOwner: false, messageId: 'm1', raw: '/今日群报', ...over,
});

test('插件：manifest 默认关闭，命令已注册', async () => {
  const { host } = makeHost();
  await host.load();
  const item = host.list().plugins.find((p) => p.id === 'daily-report');
  assert.ok(item, '插件没被发现');
  assert.equal(item.enabled, false, '默认必须关闭');
  assert.equal(item.loaded, false);

  await host.setEnabled('daily-report', true);
  const loaded = host.list().plugins.find((p) => p.id === 'daily-report');
  assert.equal(loaded.loaded, true);
  const names = (loaded.commands ?? []).map((c) => c.name);
  assert.ok(names.includes('今日群报'));
  assert.ok(names.includes('群报设置'));
  const report = (loaded.commands ?? []).find((c) => c.name === '今日群报');
  assert.deepEqual(report.scopes, ['group'], '群报必须限定群聊');
  assert.equal(report.permission, 'user');
  await host.close();
});

test('插件：私聊发命令被 scope-mismatch 拒绝且不回话', async () => {
  const { host, replies, commandLog } = makeHost();
  await host.load();
  await host.setEnabled('daily-report', true);

  const result = await host.dispatch(ctx({ key: 'private:2', kind: 'private', raw: '/今日群报' }));
  assert.equal(result.outcome, 'denied');
  assert.equal(commandLog.tail().entries.at(-1).code, 'scope-mismatch');
  assert.equal(replies.length, 0, '私聊失败不该回话');
  await host.close();
});

test('插件：默认 previewOnly 只落盘，QQ 只回简短提示', async () => {
  const { dir, host, replies } = makeHost();
  await host.load();
  await host.setEnabled('daily-report', true);

  const result = await host.dispatch(ctx({ raw: '/今日群报 2026-11-06' }));
  assert.equal(result.outcome, 'ok');
  assert.equal(replies.length, 1);
  const text = String(replies[0].text ?? replies[0].segments?.[0]?.text ?? '');
  assert.match(text, /预览模式/);
  assert.ok(!text.includes('今日精选'), '预览模式不该把正文发出来');

  const reportDir = path.join(dir, 'data', 'daily-report', 'reports', 'group-999');
  const files = fs.existsSync(reportDir) ? fs.readdirSync(reportDir) : [];
  assert.equal(files.length, 1, '应该落盘一个报告文件');
  const body = fs.readFileSync(path.join(reportDir, files[0]), 'utf8');
  assert.match(body, /今日群报/);
  assert.match(body, /今日精选/);
  await host.close();
});

test('插件：日期参数（昨天 / 指定日期 / 非法）', async () => {
  const { host, replies } = makeHost();
  await host.load();
  await host.setEnabled('daily-report', true);

  await host.dispatch(ctx({ raw: '/今日群报 2026-11-06' }));
  assert.match(String(replies.at(-1).text ?? replies.at(-1).segments?.[0]?.text ?? ''), /群报/);

  await host.dispatch(ctx({ raw: '/今日群报 昨天' }));
  assert.match(String(replies.at(-1).text ?? replies.at(-1).segments?.[0]?.text ?? ''), /群报/);

  await host.dispatch(ctx({ raw: '/今日群报 不是日期' }));
  assert.match(String(replies.at(-1).text), /日期格式不对/);
  await host.close();
});

test('插件：未来日期给出友好提示', async () => {
  const { host, replies } = makeHost();
  await host.load();
  await host.setEnabled('daily-report', true);
  await host.dispatch(ctx({ raw: '/今日群报 2099-01-01' }));
  assert.match(String(replies.at(-1).text), /还没到那一天/);
  await host.close();
});

test('插件：不带日期时默认看昨天（报纸报已发生完的一天）', async () => {
  // 钉死默认窗口：昨天 00:00 ~ 今天 00:00。看今天会让晨间报告残缺、统计值随时间漂移。
  const seen = [];
  const dir = fs.mkdtempSync(path.join(root, 'yday-'));
  const host = createCommandHost({
    dirs: [PLUGIN_DIR],
    stateFile: path.join(dir, 'plugins.json'),
    dataRoot: path.join(dir, 'data'),
    sendReply: async () => {},
    readMessages: async ({ since, until }) => {
      seen.push({ since, until });
      return { ok: true, messages: [], total: 0, truncated: false };
    },
    log: () => {},
  });
  await host.load();
  await host.setEnabled('daily-report', true);
  await host.dispatch(ctx({ raw: '/今日群报' }));

  assert.equal(seen.length, 1, 'readMessages 应被调用一次');
  const { since, until } = seen[0];
  assert.equal(until - since, 86400000, '窗口必须正好一天');
  const midnightToday = Date.parse(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' }) + 'T00:00:00+08:00');
  assert.equal(until, midnightToday, '默认窗口应止于今天 00:00（即统计昨天）');
  await host.close();
});

test('插件：显式 今天 仍然看今天', async () => {
  const seen = [];
  const dir = fs.mkdtempSync(path.join(root, 'today-'));
  const host = createCommandHost({
    dirs: [PLUGIN_DIR],
    stateFile: path.join(dir, 'plugins.json'),
    dataRoot: path.join(dir, 'data'),
    sendReply: async () => {},
    readMessages: async ({ since, until }) => {
      seen.push({ since, until });
      return { ok: true, messages: [], total: 0, truncated: false };
    },
    log: () => {},
  });
  await host.load();
  await host.setEnabled('daily-report', true);
  await host.dispatch(ctx({ raw: '/今日群报 今天' }));

  assert.equal(seen.length, 1);
  const midnightToday = Date.parse(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' }) + 'T00:00:00+08:00');
  assert.equal(seen[0].since, midnightToday, '「今天」必须从今天 00:00 起算');
  await host.close();
});

test('插件：当天没消息时回明确提示，而不是静默', async () => {
  // 静默会让人分不清「这天没人说话」和「插件坏了」——命令是用户主动 @ 的，必须回话。
  const { host, replies } = makeHost({ messages: [] });
  await host.load();
  await host.setEnabled('daily-report', true);
  const result = await host.dispatch(ctx({ raw: '/今日群报 2026-11-06' }));
  assert.equal(result.outcome, 'ok');
  assert.equal(result.reply, true);
  assert.equal(replies.length, 1);
  const text = String(replies.at(-1).text ?? '');
  assert.match(text, /没有可统计的消息/, '必须说明是这天没数据');
  assert.match(text, /11-06/, '必须带上问的是哪一天');
  await host.close();
});

test('插件：归档不可用时回结构化提示', async () => {
  const dir = fs.mkdtempSync(path.join(root, 'noarch-'));
  const replies = [];
  const host = createCommandHost({
    dirs: [PLUGIN_DIR],
    stateFile: path.join(dir, 'plugins.json'),
    dataRoot: path.join(dir, 'data'),
    sendReply: async (key, result) => { replies.push(result); },
    readMessages: async () => ({ ok: false, code: 'archive-missing', error: '消息归档不存在', hint: '在设置里开启向量记忆' }),
    log: () => {},
  });
  await host.load();
  await host.setEnabled('daily-report', true);
  await host.dispatch(ctx({ raw: '/今日群报 2026-11-06' }));
  const text = String(replies.at(-1).text ?? '');
  assert.match(text, /消息归档不存在/);
  assert.match(text, /开启向量记忆/, '必须给出下一步');
  await host.close();
});

test('插件：群报设置可读可写（仅管理员）', async () => {
  const { host, replies } = makeHost();
  await host.load();
  await host.setEnabled('daily-report', true);

  const denied = await host.dispatch(ctx({ raw: '/群报设置' }));
  assert.equal(denied.outcome, 'denied');
  assert.equal(replies.length, 0);

  await host.dispatch(ctx({ raw: '/群报设置', isOwner: true }));
  assert.match(String(replies.at(-1).text), /previewOnly/);

  await host.dispatch(ctx({ raw: '/群报设置 {"previewOnly":false}', isOwner: true }));
  assert.match(String(replies.at(-1).text), /已更新/);
  await host.close();
});
test('插件：没有 analyze 接口时降级到统计版', async () => {
  const { host, replies } = makeHost();
  await host.load();
  await host.setEnabled('daily-report', true);
  // 切到真实发送模式，走渲染分支
  await host.setConfig('daily-report', { previewOnly: false, renderImage: true });
  const r = await host.dispatch(ctx({ raw: '/今日群报 2026-11-06' }));
  assert.equal(r.outcome, 'ok');
  assert.ok(replies.length >= 1, '应该回话');
  await host.close();
});

test('插件：llmAnalysis=false 时不调用 analyze（省钱开关）', async () => {
  const dir = fs.mkdtempSync(path.join(root, 'noanalysis-'));
  let called = 0;
  const replies = [];
  const host = createCommandHost({
    dirs: [PLUGIN_DIR],
    stateFile: path.join(dir, 'plugins.json'),
    dataRoot: path.join(dir, 'data'),
    sendReply: async (key, result) => { replies.push(result); },
    readMessages: async ({ since, until }) => ({ ok: true, messages: SAMPLE.filter((m) => m.at >= since && m.at < until), total: 1, truncated: false }),
    readMembers: async () => ({ ok: true, members: [], cached: false }),
    readGroupName: async () => ({ ok: true, name: '测试群', cached: false }),
    analyze: async () => { called += 1; return { ok: true, text: '{}' }; },
    log: () => {},
  });
  await host.load();
  await host.setEnabled('daily-report', true);
  // 关掉分析开关
  await host.setConfig('daily-report', { llmAnalysis: false });
  await host.dispatch(ctx({ raw: '/今日群报 2026-11-06' }));
  assert.equal(called, 0, 'llmAnalysis=false 时不该调用 analyze');
  assert.ok(replies.length >= 1);
  await host.close();
});