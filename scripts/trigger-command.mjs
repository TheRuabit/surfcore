#!/usr/bin/env node
// 后台触发命令插件（不经 QQ）：加载真实插件包，走真实 dispatch，落盘到真实 dataDir。
// 用法：node scripts/trigger-command.mjs <命令> [--key group:123] [--dry]
//   例：node scripts/trigger-command.mjs '/今日群报 昨天' --key group:824266596
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCommandHost } from '../src/command-host.js';
import { createCommandLog } from '../src/command-log.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = path.join(ROOT, 'state');

function parseArgs(argv) {
  const out = { raw: '', key: 'group:824266596', dry: false, owner: true };
  for (const a of argv.slice(2)) {
    if (a === '--dry') out.dry = true;
    else if (a === '--as-user') out.owner = false;
    else if (a.startsWith('--key=')) out.key = a.slice(6);
    else if (!out.raw) out.raw = a;
  }
  return out;
}

// 与 bridge.readArchiveMessages 同语义：按绝对时间窗读群聊归档。
function readArchiveMessages({ key, since = 0, until = Date.now(), limit = 2000 } = {}) {
  if (!String(key).startsWith('group:')) {
    return { ok: false, code: 'unsupported-key', error: '只支持群聊', hint: '只读 group: 会话' };
  }
  const file = path.join(STATE_DIR, 'message-archive.jsonl');
  if (!fs.existsSync(file)) {
    return { ok: false, code: 'archive-missing', error: '消息归档不存在', hint: '设置里开启向量记忆' };
  }
  let selfId = '';
  try { selfId = String(JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'self-identity.json'), 'utf8')).userId ?? ''); } catch {}
  const messages = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    if (String(item.key ?? '') !== String(key)) continue;
    if (item.type && item.type !== 'message') continue;
    const at = Number(item.time) || 0;
    if (at < since || at > until) continue;
    const uid = String(item.userId ?? '').trim();
    const isSelf = Boolean(!uid || uid === selfId || String(item.sender ?? '') === '我');
    messages.push({ at, userId: uid, sender: String(item.sender ?? ''), text: String(item.text ?? ''), isSelf });
    if (messages.length >= limit) break;
  }
  messages.sort((a, b) => a.at - b.at);
  return { ok: true, messages, total: messages.length, truncated: false };
}

const args = parseArgs(process.argv);
if (!args.raw) {
  console.error('用法：node scripts/trigger-command.mjs <命令> [--key=group:123] [--dry] [--as-user]');
  process.exit(2);
}

// --dry：把 dataRoot 指到临时目录，不污染真实数据
const dataRoot = args.dry
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-dry-'))
  : path.join(STATE_DIR, 'command-plugins');

const replies = [];
const host = createCommandHost({
  dirs: [path.join(ROOT, 'plugins/surfcore/command-plugins')],
  stateFile: path.join(STATE_DIR, 'command-plugins.json'),
  dataRoot,
  commandLog: createCommandLog({ file: path.join(STATE_DIR, 'command-log.jsonl') }),
  sendReply: async (key, result) => { replies.push({ key, result }); },
  readMessages: readArchiveMessages,
  readGroupName: async ({ key }) => {
    const gid = String(key).replace(/^group:/, '');
    let cfg; try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch { return { ok: false, code: 'no-config', error: '读不到 config.json', hint: '检查配置' }; }
    const httpUrl = String(cfg?.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const tk = cfg?.snowluma?.accessToken;
    try {
      const r = await fetch(httpUrl + '/get_group_info', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(tk ? { authorization: 'Bearer ' + tk } : {}) },
        body: JSON.stringify({ group_id: Number(gid) }),
        signal: AbortSignal.timeout(20000),
      });
      const body = await r.json().catch(() => ({}));
      if (body.status !== 'ok') return { ok: false, code: 'name-unavailable', error: String(body.wording ?? r.status), hint: '网关未实现 get_group_info' };
      const name = String(body.data?.group_name ?? '').trim();
      if (!name) return { ok: false, code: 'name-unavailable', error: '群名为空', hint: '网关返回不含 group_name' };
      return { ok: true, name, cached: false };
    } catch (error) {
      return { ok: false, code: 'name-read-failed', error: String(error?.message ?? error), hint: '检查 SnowLuma 是否在线' };
    }
  },
  readMembers: async ({ key }) => {
    const gid = String(key).replace(/^group:/, '');
    let cfg; try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch { return { ok: false, code: 'no-config', error: '读不到 config.json', hint: '检查配置' }; }
    const httpUrl = String(cfg?.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const tk = cfg?.snowluma?.accessToken;
    const r = await fetch(httpUrl + '/get_group_member_list', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(tk ? { authorization: 'Bearer ' + tk } : {}) },
      body: JSON.stringify({ group_id: Number(gid) }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await r.json().catch(() => ({}));
    if (body.status !== 'ok') return { ok: false, code: 'members-unavailable', error: String(body.wording ?? r.status), hint: '网关未实现' };
    const list = Array.isArray(body.data) ? body.data : (body.data?.data ?? []);
    return { ok: true, members: list.map(m => ({ userId: String(m.user_id ?? ''), card: String(m.card ?? ''), nickname: String(m.nickname ?? ''), isRobot: m.is_robot === true })), cached: false };
  },
  // 内部模型分析必须走桥接**进程内**的会话（脚本自己起不了 DSH 会话），
  // 所以这里转发到桥接的调试端点，复用同一个 runInternalAnalysis。
  analyze: async ({ prompt, timeoutMs }) => {
    let cfg; try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch { return { ok: false, code: 'no-config', error: '读不到 config.json', hint: '检查配置' }; }
    const token = String(cfg?.consoleToken || '').trim();
    if (!token) return { ok: false, code: 'no-console-token', error: 'config.json 没有 consoleToken', hint: '先启动一次桥接自动生成' };
    const port = Number(cfg?.consolePort) || 3100;
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/api/commands/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-console-token': token },
        body: JSON.stringify({ prompt: String(prompt ?? ''), timeoutMs: Number(timeoutMs) || 120000 }),
        signal: AbortSignal.timeout(Math.max(5000, Number(timeoutMs) || 120000) + 15000),
      });
      const body = await r.json().catch(() => ({}));
      if (body && body.ok === true) return body;
      return { ok: false, code: String(body?.code || 'analyze-failed'), error: String(body?.error || ('HTTP ' + r.status)), hint: String(body?.hint || '看 bridge.log') };
    } catch (error) {
      return { ok: false, code: 'analyze-unreachable', error: String(error?.message ?? error), hint: '桥接控制台未启动？检查 ' + port + ' 端口' };
    }
  },
  log: (m) => console.error('[host]', m),
});

const listed = await host.load();
const enabled = listed.plugins.filter((p) => p.enabled);
if (!enabled.length) {
  console.error('没有已启用的插件；先在设置 → Log Terminal 启用，或直接改 state/command-plugins.json');
  process.exit(1);
}

const [kind, id] = args.key.split(':');
const result = await host.dispatch({
  key: args.key,
  kind,
  groupId: kind === 'group' ? id : '',
  userId: args.owner ? '2593113680' : '10000',
  senderName: args.owner ? '管理员' : '群友',
  isOwner: args.owner,
  messageId: 'cli-trigger',
  raw: args.raw,
  atTargets: [],
});

await host.close();
console.log('dispatch:', JSON.stringify(result));
console.log('回复条数:', replies.length);
for (const r of replies) console.log('---', r.key, '---\n' + String(r.result?.text ?? JSON.stringify(r.result)));
console.log('dataRoot:', dataRoot);