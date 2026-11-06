import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('接线：桥接有命令宿主/日志端点，且失败不再直接回 QQ', () => {
  const bridge = read('src/bridge.js');
  assert.match(bridge, /createCommandHost/);
  assert.match(bridge, /commandHost\.dispatch\(/);
  assert.match(bridge, /\/api\/commands\/plugins/);
  assert.match(bridge, /\/api\/commands\/log/);
  assert.ok(!bridge.includes("sendToQQ(key, '管理命令仅管理员可用。')"), '非管理员失败仍会直接回 QQ');
  assert.match(bridge, /outcome: 'denied'/);
  assert.match(bridge, /code: builtin \? 'not-owner' : 'unknown-command'/);
});

test('接线：设置页有 Log Terminal 和代理路由', () => {
  const host = read('plugins/surfcore/lib/index.js');
  assert.match(host, /handleCommands/);
  assert.match(host, /\/commands\/plugins/);
  assert.match(host, /\/commands\/log/);
  const client = read('plugins/surfcore/lib/client.js');
  assert.match(client, /function CommandTerminalTab/);
  assert.match(client, /\["commands", "Log Terminal"\]/);
  assert.match(client, /\/commands\/log/);
});

test('接线：示例插件 manifest 默认关闭且只声明 qq.command', () => {
  const manifest = JSON.parse(read('plugins/surfcore/command-plugins/example/manifest.json'));
  assert.equal(manifest.id, 'example');
  assert.equal(manifest.enabled, false);
  assert.deepEqual(manifest.capabilities, ['qq.command']);
  const code = read('plugins/surfcore/command-plugins/example/index.js');
  assert.match(code, /name: '回声'/);
  assert.match(code, /permission: 'admin'/);
});
test('接线：群内命令必须 @机器人，裸斜杠丢弃且不转发 DSH', () => {
  const bridge = read('src/bridge.js');
  assert.match(bridge, /import \{ leadingSelfAtCount, resolveCommandText \} from '\.\/command-text\.js'/);
  assert.match(bridge, /leadingSelfAtCount\(event\.message/, '没有按消息段切前缀');
  assert.match(bridge, /resolveCommandText\(/);
  assert.match(bridge, /command\.droppedBare/);
  assert.match(bridge, /code: 'bare-slash'/);
  // 聊天不再驱动 DSH 斜杠命令
  assert.ok(!bridge.includes("code: 'forwarded-dsh'"), 'QQ→DSH 斜杠转发没删干净');
  assert.match(bridge, /code: 'unknown-slash'/);
});

test('接线：命令不再污染记忆卡 / 黑话 / 公开流', () => {
  const bridge = read('src/bridge.js');
  assert.match(bridge, /recordMemoryInboxEvent\(\{[\s\S]{0,200}?isCommand: command\.isCommand \|\| command\.droppedBare/);
  assert.match(bridge, /if \(!text \|\| isCommand \|\| text\.startsWith\('\/'\)\) return;/);
  assert.match(bridge, /feedSlangWindow\(key, sender, plainContent, \{ isCommand:/);
  assert.match(bridge, /!command\.isCommand && !command\.droppedBare/);
});

test('接线：静默模式放行命令（不产生模型回合）', () => {
  const bridge = read('src/bridge.js');
  assert.match(bridge, /roleState\.mode === 'silent' && !isOwner && !command\.isCommand && !command\.droppedBare/);
});

test('接线：命令回复不再绕过发送守卫', () => {
  const bridge = read('src/bridge.js');
  const fn = bridge.slice(bridge.indexOf('async function sendCommandReply'));
  const body = fn.slice(0, fn.indexOf('\n  function readArchiveActiveMembers'));
  assert.match(body, /captureSendGuard\(key\)/, 'sendCommandReply 没有会话守卫');
  assert.ok(!/文本发送仍走 sendToQQ/.test(bridge), '误导性注释还在');
});

test('接线：宿主检查 scopes 并有处理超时', () => {
  const host = read('src/command-host.js');
  assert.match(host, /scope-mismatch/);
  assert.match(host, /plugin-timeout/);
  assert.match(host, /handlerTimeoutMs/);
  assert.match(host, /outcome: 'unknown'/);
  // 激活失败不得先落盘
  const setEnabled = host.slice(host.indexOf('async function setEnabled'));
  const body = setEnabled.slice(0, setEnabled.indexOf('function setConfig'));
  assert.ok(body.indexOf('activate(manifest)') < body.indexOf('state.enabled[id] = true'), 'setEnabled 仍先落盘再激活');
});

test('接线：日志轮转不重置 seq 水位', () => {
  const log = read('src/command-log.js');
  const rotate = log.slice(log.indexOf('function rotate()'));
  const body = rotate.slice(0, rotate.indexOf('function append'));
  assert.ok(!/seq = 0/.test(body), '轮转仍把 seq 归零');
  assert.match(log, /saveSeq\(\)/);
});
test('接线：命令回复过内容审计，示例插件不回显本机路径', () => {
  const bridge = read('src/bridge.js');
  const fn = bridge.slice(bridge.indexOf('async function sendCommandReply'));
  const body = fn.slice(0, fn.indexOf('function readArchiveActiveMembers'));
  assert.match(body, /SENSITIVE_RE\.test\(text\)/, '命令回复没有走敏感信息审计');

  const example = read('plugins/surfcore/command-plugins/example/index.js');
  assert.ok(!example.includes('数据目录：'), '示例插件仍在向 QQ 回显数据目录');
  assert.match(example, /example 插件运行中。/);
});

test('审计：示例插件旧回复里的本机路径确实会被拦', async () => {
  const { SENSITIVE_RE } = await import('../src/sensitive.js');
  assert.equal(SENSITIVE_RE.test('example 插件运行中；数据目录：E:\\DSH\\DSHWorkingDir\\state\\x'), true);
  assert.equal(SENSITIVE_RE.test('接口正常：I love you'), false);
  assert.equal(SENSITIVE_RE.test('example 插件运行中。'), false);
});

test('接线：桥接暴露 readMessages，群报插件默认关闭', () => {
  const bridge = read('src/bridge.js');
  assert.match(bridge, /function readArchiveMessages\(/, '桥接缺少 readArchiveMessages');
  assert.match(bridge, /readMessages: readArchiveMessages/, 'readMessages 没装配进 createCommandHost');
  assert.match(bridge, /code: 'archive-missing'/);
  assert.match(bridge, /code: 'unsupported-key'/);

  const host = read('src/command-host.js');
  assert.match(host, /messages: async \(\{ key, since, until, limit, maxBytes \} = \{\}\)/);
  assert.match(host, /code: 'not-supported'/);

  const manifest = JSON.parse(read('plugins/surfcore/command-plugins/daily-report/manifest.json'));
  assert.equal(manifest.id, 'daily-report');
  assert.equal(manifest.enabled, false, '群报插件默认必须关闭');

  const plugin = read('plugins/surfcore/command-plugins/daily-report/index.js');
  assert.match(plugin, /previewOnly: true/, '默认必须是预览模式');
  assert.match(plugin, /scopes: \['group'\]/);
  assert.match(plugin, /name: '今日群报'/);
  assert.match(plugin, /name: '群报设置'/);
  // 群报不能把本机路径回显到 QQ
  assert.ok(!plugin.includes('api.dataDir}'), '插件不该把 dataDir 拼进回复文本');
});

test('接线：群报纯函数模块只依赖自身，不碰 IO', () => {
  const core = read('src/daily-report-core.js');
  assert.ok(!/from 'node:fs'/.test(core), '纯函数模块不该 import fs');
  assert.match(core, /export function aggregateMessages/);
  assert.match(core, /export function renderReport/);
  assert.match(core, /export function isReportable/);
});