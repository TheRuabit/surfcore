// 哈希向量 vs BM25 的检索质量对比（2026-10-30）
// 同一批消息、同一批 query，只看两件事：
//   1. 高频短串（[图片] 之类）的分数会不会降下来
//   2. 抽样配对看起来是否更合理
import fs from 'node:fs';
import path from 'node:path';
import { createEmbedder } from '../src/memory-embed.js';
import { createMemoryStore } from '../src/memory-store.js';
import { createBM25Store } from '../src/memory-bm25.js';
import { estimateTokens } from '../src/memory-shadow.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/[A-Za-z]:/, '')), '..');
const sv2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8'));
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').slice(0, n);
const round = (n, d = 3) => Math.round(n * Math.pow(10, d)) / Math.pow(10, d);
const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a,b)=>a-b); return s[Math.min(s.length-1, Math.floor(s.length*p))]; };

function run(storeFactory, label) {
  const scores = [];
  const cumTokens = Array(6).fill(0);
  let samples = 0;
  let floor = 0;
  const samples_out = [];
  for (const [key, conv] of Object.entries(sv2.conversations || {})) {
    const msgs = (conv.recentMessages || []).filter((m) => String(m.plain || m.text || '').trim());
    if (msgs.length < 4) continue;
    const store = storeFactory();
    for (let i = 0; i < msgs.length; i += 1) {
      const m = msgs[i];
      const text = String(m.plain || m.text || '').trim();
      if (i >= 3) {
        const r = store.search(text, { topK: 6, filter: { key, sender: m.sender } });
        const hits = r.hits || [];
        if (hits.length) {
          samples += 1;
          scores.push(hits[0].score);
          let cum = 0;
          for (let k = 0; k < 6; k += 1) { if (hits[k]) cum += estimateTokens(hits[k].item.text); cumTokens[k] += cum; }
          floor += hits[0].score <= 0.25 ? 1 : 0;
          if (samples_out.length < 5 && key === 'private:2593113680' && i >= 40 && i % 20 === 0) {
            samples_out.push({ q: clip(text, 50), top: hits.slice(0, 3).map((h) => ({ s: round(h.score), t: clip(h.item.text, 45) })) });
          }
        }
      }
      store.add({ key, seq: m.seq, messageId: m.messageId, sender: m.sender, userId: m.userId,
        time: m.time, replyTo: m.quoteTargetIsSelf ? 'self' : '', type: 'message', text });
    }
  }
  return {
    label, samples,
    p50: round(pct(scores, 0.5)), p90: round(pct(scores, 0.9)),
    floorRate: round(floor / Math.max(1, samples) * 100, 1),
    avgCum: cumTokens.map((v) => (samples ? Math.round(v / samples) : 0)),
    examples: samples_out,
  };
}

const a = run(() => createMemoryStore({ file: '', embedder: createEmbedder({ provider: 'hash' }) }), '哈希向量');
const b = run(() => createBM25Store({}), 'BM25');

for (const r of [a, b]) {
  console.log('\n=== ' + r.label + ' ===');
  console.log('  样本 ' + r.samples + ' 条');
  console.log('  Top1 分数 p50=' + r.p50 + ' p90=' + r.p90);
  console.log('  地板比例(≤0.25): ' + r.floorRate + '%');
  console.log('  平均累计 token: ' + JSON.stringify(r.avgCum));
  console.log('  抽样:');
  for (const e of r.examples) {
    console.log('    Q: ' + e.q);
    for (const t of e.top) console.log('       ' + t.s + '  ' + t.t);
  }
}
