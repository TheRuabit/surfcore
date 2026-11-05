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
