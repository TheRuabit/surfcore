// 抽样看检索质量（2026-10-30）：哈希 embedding 容易在短文本上虚高，
// 所以必须有具体例子，不能只看分数。
import fs from 'node:fs';
import path from 'node:path';
import { createEmbedder } from '../src/memory-embed.js';
import { createMemoryStore } from '../src/memory-store.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/[A-Za-z]:/, '')), '..');
const sv2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8'));
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

for (const [key, conv] of Object.entries(sv2.conversations || {})) {
  const msgs = (conv.recentMessages || []).filter((m) => String(m.plain || m.text || '').trim());
  if (msgs.length < 20) continue;
  console.log('\n===== ' + key + ' =====');
  const store = createMemoryStore({ file: '', embedder: createEmbedder({ provider: 'hash' }) });
  // 只取后半段，避免全是"早上好"这类开场
  for (let i = 0; i < msgs.length; i += 1) {
    const m = msgs[i];
    const text = String(m.plain || m.text || '').trim();
    if (i >= 20 && i % 12 === 0) {
      const r = store.search(text, { topK: 3, filter: { key, sender: m.sender } });
      const hits = r.hits || [];
      console.log('Q[' + i + '] ' + (m.sender || '?') + ': ' + clip(text, 60));
      for (const h of hits) {
        console.log('   ' + Math.round(h.score * 1000) / 1000 + '  ' + clip(h.item.sender, 8) + ': ' + clip(h.item.text, 60));
      }
    }
    store.add({ key, seq: m.seq, messageId: m.messageId, sender: m.sender, userId: m.userId,
      time: m.time, replyTo: m.quoteTargetIsSelf ? 'self' : '', type: 'message', text });
  }
}
