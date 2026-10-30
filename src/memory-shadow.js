// shadow 检索（2026-10-30，第一阶段）
//
// 只做三件事：检索、估 token、记日志。**结果永远不进 prompt。**
// 目的是攒数据回答两个问题：
//   1. 检索回来的东西和当前话题相关吗（命中率）
//   2. 覆盖同一个话题需要多少 token（TopN 累计曲线）
// 有了这两个数，才谈"要不要注入"和"预算定多少"。
import fs from 'node:fs';
import path from 'node:path';

/** 粗略 token 估算：与仓库其它地方一致（中文约 2.2 字符/token）。 */
export function estimateTokens(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  return Math.ceil(s.length / 2.2);
}

/**
 * @param {{store:object, file:string, log?:Function, topK?:number}} options
 */
export function createShadowRetriever(options) {
  const opts = options || {};
  const store = opts.store;
  const file = opts.file;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const topK = Math.max(1, Math.min(20, Number(opts.topK) || 8));
  let fd = null;
  let runs = 0;
  let totalLatency = 0;
  let lastResult = null;

  function append(record) {
    if (!file) return;
    try {
      if (fd == null) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fd = fs.openSync(file, 'a');
      }
      fs.writeSync(fd, JSON.stringify(record) + '\n');
    } catch (error) {
      log('[记忆] shadow 日志写入失败：' + String((error && error.message) || error));
    }
  }

  /**
   * 跑一次 shadow 检索并记录。
   * @param {{key:string, query:string, sender?:string, now?:number}} input
   * @returns {{skipped?:string, candidates:number, topK:number, tokens:number[], scores:number[], latencyMs:number}}
   */
  function probe(input) {
    const p = input || {};
    const query = String(p.query || '').trim();
    const base = { candidates: 0, topK, tokens: [], scores: [], latencyMs: 0 };
    if (!query) return Object.assign(base, { skipped: 'empty-query' });
    if (!store) return Object.assign(base, { skipped: 'no-store' });
    const started = Date.now();
    let result;
    try {
      result = store.search(query, {
        topK,
        now: p.now,
        filter: { key: p.key, sender: p.sender },
      });
    } catch (error) {
      log('[记忆] shadow 检索失败：' + String((error && error.message) || error));
      return Object.assign(base, { skipped: 'error' });
    }
    const latencyMs = Date.now() - started;
    const hits = Array.isArray(result.hits) ? result.hits : [];
    const tokens = [];
    const scores = [];
    const sourceMessageIds = [];
    let cumulative = 0;
    let top = null;
    for (let i = 0; i < hits.length; i += 1) {
      const h = hits[i];
      const t = estimateTokens(h.item.text);
      cumulative += t;
      tokens.push(cumulative);            // 累计值：直接给覆盖率曲线用
      scores.push(Math.round(h.score * 10000) / 10000);
      if (h.item.messageId) sourceMessageIds.push(h.item.messageId);
      if (!top) top = { text: String(h.item.text || '').slice(0, 80), score: h.score, tokens: t };
    }
    runs += 1;
    totalLatency += latencyMs;
    lastResult = {
      key: String(p.key || ''),
      query: query.slice(0, 120),
      candidates: hits.length,
      scanned: result.scanned || 0,
      scores,
      tokens,
      sourceMessageIds,
      latencyMs,
      top,
      at: new Date().toISOString(),
    };
    append(lastResult);
    return {
      candidates: hits.length,
      topK,
      tokens,
      scores,
      latencyMs,
      scanned: result.scanned || 0,
    };
  }

  function status() {
    return {
      runs,
      avgLatencyMs: runs ? Math.round(totalLatency / runs) : 0,
      last: lastResult,
      topK,
      file,
    };
  }

  function close() {
    if (fd != null) { try { fs.closeSync(fd); } catch {} fd = null; }
  }

  return { probe, status, close };
}
