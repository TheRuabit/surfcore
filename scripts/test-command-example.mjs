import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCommandHost } from '../src/command-host.js';
import { createCommandLog } from '../src/command-log.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-command-example-'));
process.on('exit', () => { try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* ignore */ } });
const exampleDir = path.resolve('plugins/surfcore/command-plugins');

test('示例插件：启用后可回声，管理员命令只对管理员', async () => {
  const commandLog = createCommandLog({ file: path.join(temp, 'log.jsonl') });
  const replies = [];
  const host = createCommandHost({
    dirs: [exampleDir],
    stateFile: path.join(temp, 'plugins.json'),
    dataRoot: path.join(temp, 'data'),
    commandLog,
    sendReply: async (key, result) => { replies.push([key, result]); },
    log: () => {},
  });
  const listed = await host.load();
  assert.equal(listed.plugins.find((p) => p.id === 'example')?.enabled, false);
  await host.setEnabled('example', true);

  const base = { key: 'group:1', kind: 'group', groupId: '1', userId: '2', senderName: '群友', isOwner: false, messageId: 'm1' };
  let result = await host.dispatch({ ...base, raw: '/回声 你好' });
  assert.equal(result.outcome, 'ok');
  assert.deepEqual(replies[0], ['group:1', { text: '接口正常：你好' }]);
  assert.equal(commandLog.tail().entries.at(-1).plugin, 'example');

  result = await host.dispatch({ ...base, raw: '/插件状态' });
  assert.equal(result.outcome, 'denied');
  assert.equal(replies.length, 1);
  assert.equal(commandLog.tail().entries.at(-1).code, 'not-owner');

  result = await host.dispatch({ ...base, raw: '/插件状态', isOwner: true });
  assert.equal(result.outcome, 'ok');
  assert.match(replies[1][1].text, /example 插件运行中/);
  await host.close();
});
