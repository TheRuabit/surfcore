// 从 social-v2.json 的 recentMessages 回填长期记忆（2026-10-30）
//
// 为什么需要它：桥接侧 archiveMemory 没跑到（见对话记录），先把已有历史灌进
// message-archive.jsonl，这样至少能做检索分析，不用等桥接修好。
// 幂等：store 按 key+seq 去重，重复跑不会产生重复记录。
import fs from 'node:fs';
import path from 'node:path';
import { createEmbedder } from '../src/memory-embed.js';
import { createMemoryStore } from '../src/memory-store.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/[A-Za-z]:/, '')), '..');
const stateDir = path.join(ROOT, 'state');
const sv2File = path.join(stateDir, 'social-v2.json');
const archiveFile = path.join(stateDir, 'message-archive.jsonl');

if (!fs.existsSync(sv2File)) { console.error('找不到 ' + sv2File); process.exit(1); }
const sv2 = JSON.parse(fs.readFileSync(sv2File, 'utf8'));
const store = createMemoryStore({ file: archiveFile, embedder: createEmbedder({ provider: 'hash' }), log: (m) => console.log(m) });
const loaded = store.load();
console.log('已有归档:', loaded.loaded, '条');

let total = 0;
let added = 0;
const perKey = {};
for (const [key, conv] of Object.entries(sv2.conversations || {})) {
  const list = Array.isArray(conv && conv.recentMessages) ? conv.recentMessages : [];
  perKey[key] = list.length;
  for (const m of list) {
    const text = String((m && (m.plain || m.text)) || '').trim();
    if (!text) continue;
    total += 1;
    const r = store.add({
      key,
      seq: m.seq,
      messageId: m.messageId,
      sender: m.sender,
      userId: m.userId,
      time: m.time,
      replyTo: m.quoteTargetIsSelf ? 'self' : '',
      type: 'message',
      text,
    });
    if (r.added) added += 1;
  }
}
console.log('扫描:', total, '条 | 新增:', added);
for (const [k, v] of Object.entries(perKey)) console.log('  ' + k + ': ' + v + ' 条');
console.log('store:', store.stats());
store.close();
