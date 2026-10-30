// 内存版 shadow 分析（2026-10-30）
// 不写盘、不依赖桥接：从 social-v2.json 的 recentMessages 重建索引，
// 逐条"用当前消息查它的历史"，模拟真实唤醒时的检索。
import fs from 'node:fs';
import path from 'node:path';
import { createEmbedder } from '../src/memory-embed.js';
import { createMemoryStore } from '../src/memory-store.js';
import { estimateTokens } from '../src/memory-shadow.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/[A-Za-z]:/, '')), '..');
const sv2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8'));
const TOPK = 8;

const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a,b)=>a-b); return s[Math.min(s.length-1, Math.floor(s.length*p))]; };
const round = (n, d = 1) => Math.round(n * Math.pow(10, d)) / Math.pow(10, d);

const all = { samples: 0, top1Tokens: [], cumTokens: Array(TOPK).fill(0), top1Scores: [], floor: 0, strong: 0, latency: [] };
const perKey = {};

for (const [key, conv] of Object.entries(sv2.conversations || {})) {
  const msgs = (Array.isArray(conv && conv.recentMessages) ? conv.recentMessages : [])
    .filter((m) => String((m && (m.plain || m.text)) || '').trim());
  if (msgs.length < 4) { perKey[key] = { msgs: msgs.length, samples: 0, note: '太少，跳过' }; continue; }

  const store = createMemoryStore({ file: '', embedder: createEmbedder({ provider: 'hash' }) });
  const stat = { msgs: msgs.length, samples: 0, cum: Array(TOPK).fill(0), top1: [], floor: 0, strong: 0, lat: [] };

  for (let i = 0; i < msgs.length; i += 1) {
    const m = msgs[i];
    const text = String(m.plain || m.text || '').trim();
    if (i >= 3) {
      const t0 = Date.now();
      const r = store.search(text, { topK: TOPK, filter: { key, sender: m.sender } });
      stat.lat.push(Date.now() - t0);
      all.latency.push(Date.now() - t0);
      const hits = r.hits || [];
      if (hits.length) {
        let cum = 0;
        const top1Score = hits[0].score;
        for (let k = 0; k < TOPK; k += 1) {
          const h = hits[k];
          if (h) cum += estimateTokens(h.item.text);
          stat.cum[k] += cum;
          all.cumTokens[k] += cum;
        }
        stat.samples += 1;
        all.samples += 1;
        stat.top1.push(top1Score);
        all.top1Scores.push(top1Score);
        stat.strong += top1Score > 0.35 ? 1 : 0;
        all.strong += top1Score > 0.35 ? 1 : 0;
        // 0.25 以下基本是 recency 地板（cosine 接近 0），视为"没检索到东西"
        stat.floor += top1Score <= 0.25 ? 1 : 0;
        all.floor += top1Score <= 0.25 ? 1 : 0;
      }
    }
    store.add({ key, seq: m.seq, messageId: m.messageId, sender: m.sender, userId: m.userId,
      time: m.time, replyTo: m.quoteTargetIsSelf ? 'self' : '', type: 'message', text });
  }
  stat.avgCum = stat.cum.map((v) => (stat.samples ? round(v / stat.samples) : 0));
  stat.floorRate = stat.samples ? round(stat.floor / stat.samples * 100) : 0;
  stat.strongRate = stat.samples ? round(stat.strong / stat.samples * 100) : 0;
  stat.p50 = round(pct(stat.top1, 0.5), 3);
  stat.p90 = round(pct(stat.top1, 0.9), 3);
  stat.avgLat = stat.lat.length ? round(stat.lat.reduce((a,b)=>a+b,0)/stat.lat.length, 1) : 0;
  perKey[key] = stat;
}

console.log('=== 总体 ===');
console.log('样本数(逐条检索):', all.samples);
const avgCum = all.cumTokens.map((v) => (all.samples ? round(v / all.samples) : 0));
console.log('平均累计 token:');
for (let k = 0; k < TOPK; k += 1) console.log('  Top' + (k + 1) + ': ' + avgCum[k]);
console.log('Top1 分数: p50=' + round(pct(all.top1Scores, 0.5), 3) + ' p90=' + round(pct(all.top1Scores, 0.9), 3));
console.log('地板比例(≤0.25): ' + round(all.floor / Math.max(1, all.samples) * 100) + '%');
console.log('强匹配(>0.35): ' + round(all.strong / Math.max(1, all.samples) * 100) + '%');
console.log('平均延迟: ' + round(all.latency.reduce((a,b)=>a+b,0)/Math.max(1,all.latency.length), 2) + 'ms');

console.log('\n=== 分会话 ===');
for (const [k, s] of Object.entries(perKey)) {
  if (!s.samples) { console.log('  ' + k + ': ' + (s.note || '无样本')); continue; }
  console.log('  ' + k);
  console.log('    消息 ' + s.msgs + ' 条 → 样本 ' + s.samples);
  console.log('    平均累计 token: ' + JSON.stringify(s.avgCum));
  console.log('    Top1 p50=' + s.p50 + ' p90=' + s.p90 + ' | 地板 ' + s.floorRate + '% | 强匹配 ' + s.strongRate + '%');
  console.log('    平均延迟 ' + s.avgLat + 'ms');
}
