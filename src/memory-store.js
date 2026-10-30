// 长期记忆存储 + 检索（2026-10-30，第一阶段：本地实现）
//
// 形态刻意做窄：JSONL 落盘 + 内存向量 + 暴力余弦。
// 为什么不上 Qdrant：现在一天几千条、一年百万条量级，一万条 256 维暴力检索在 Node 里
// 约 50ms，完全够用；而多一个外部进程就多一处装不起来的地方。
// 接口按 Qdrant 的形状定死（add / search({filter, topK})），以后换实现上层不用改。
//
// 幂等键：优先 key + seq（群消息天然唯一），没有 seq 时退回内容哈希。
// 重复 add 同一条不会产生第二条记录 —— 归档点分散在多处，这条是必需的。
import fs from 'node:fs';
import path from 'node:path';

const MAX_LOAD = 50_000;      // 启动时最多回填多少条（避免一次性读爆大文件）
const MAX_MEMORIES = 200_000; // 内存里最多保留多少条

function roundVec(vec) {
  const out = new Array(vec.length);
  for (let i = 0; i < vec.length; i += 1) out[i] = Math.round(vec[i] * 10000) / 10000;
  return out;
}

function stableHash(text) {
  let h = 0x811c9dc5;
  const s = String(text || '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * @param {{file:string, embedder:object, log?:Function, maxLoad?:number}} options
 */
export function createMemoryStore(options) {
  const opts = options || {};
  const file = opts.file;
  const embedder = opts.embedder;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const maxLoad = Number(opts.maxLoad) > 0 ? Number(opts.maxLoad) : MAX_LOAD;

  /** @type {Map<string, any>} id -> memory */
  const byId = new Map();
  let appendFd = null;
  let dirty = false;

  function idOf(memory) {
    const key = String(memory.key || '');
    if (memory.seq != null && Number.isFinite(Number(memory.seq))) return key + ':' + Number(memory.seq);
    return key + ':h' + stableHash(memory.text || '');
  }

  function load() {
    if (!file || !fs.existsSync(file)) return { loaded: 0 };
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
      log('[记忆] 读取归档失败：' + String((error && error.message) || error));
      return { loaded: 0 };
    }
    const lines = text.split('\n');
    const start = Math.max(0, lines.length - maxLoad);
    let loaded = 0;
    for (let i = start; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const item = JSON.parse(line);
        if (!item || !item.id || !Array.isArray(item.v)) continue;
        byId.set(String(item.id), item);
        loaded += 1;
      } catch { /* 半行/坏行跳过，不让一行坏数据毁掉整个索引 */ }
    }
    return { loaded };
  }

  function append(memory) {
    if (!file) return;
    try {
      if (appendFd == null) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        appendFd = fs.openSync(file, 'a');
      }
      fs.writeSync(appendFd, JSON.stringify(memory) + '\n');
      dirty = true;
    } catch (error) {
      // 写盘失败不能影响群聊主流程；内存里的索引仍然可用。
      log('[记忆] 追加失败：' + String((error && error.message) || error));
    }
  }

  /**
   * 写一条记忆。幂等：同一 key+seq 重复调用只保留一条。
   * @returns {{added:boolean, id:string}}
   */
  function add(input) {
    const memory = input && typeof input === 'object' ? input : {};
    const text = String(memory.text || '').trim();
    if (!text) return { added: false, id: '' };
    const id = idOf(memory);
    if (byId.has(id)) return { added: false, id };
    const vec = embedder.embed(text);
    const item = {
      id,
      key: String(memory.key || ''),
      seq: memory.seq == null ? null : Number(memory.seq),
      messageId: String(memory.messageId || ''),
      sender: String(memory.sender || ''),
      userId: String(memory.userId || ''),
      time: Number(memory.time) || Date.now(),
      replyTo: String(memory.replyTo || ''),
      type: String(memory.type || 'message'),
      text: String(text).slice(0, 600),
      v: roundVec(vec),
    };
    byId.set(id, item);
    append(item);
    if (byId.size > MAX_MEMORIES) {
      const drop = byId.size - MAX_MEMORIES;
      let n = 0;
      for (const k of byId.keys()) { byId.delete(k); if (++n >= drop) break; }
    }
    return { added: true, id };
  }

  /**
   * 检索。返回按混合分排序的前 topK 条。
   * 混合分 = 余弦 0.6 + 新鲜度 0.2 + 同说话人 0.1 + 回复链 0.1
   * （权重先按经验定，shadow 阶段会记录每条的分项，便于以后调）
   * @param {string} query
   * @param {{filter?:object, topK?:number, now?:number}} [opts]
   */
  function search(query, opts2) {
    const o = opts2 || {};
    const q = String(query || '').trim();
    const topK = Math.max(1, Math.min(50, Number(o.topK) || 5));
    const now = Number(o.now) || Date.now();
    const empty = { hits: [], scanned: 0 };
    if (!q || !byId.size) return empty;
    const qv = embedder.embed(q);
    const filter = o.filter && typeof o.filter === 'object' ? o.filter : {};
    const fKey = filter.key ? String(filter.key) : '';
    const fSince = Number(filter.since) > 0 ? Number(filter.since) : 0;
    const fSender = filter.sender ? String(filter.sender) : '';
    const hits = [];
    let scanned = 0;
    for (const item of byId.values()) {
      if (fKey && item.key !== fKey) continue;
      if (fSince && item.time < fSince) continue;
      scanned += 1;
      let dot = 0;
      const v = item.v;
      for (let i = 0; i < v.length; i += 1) dot += qv[i] * v[i];
      const ageHours = Math.max(0, (now - item.time) / 3600000);
      const recency = Math.max(0, 1 - ageHours / 168);           // 7 天内线性衰减
      const sameSpeaker = fSender && item.sender === fSender ? 1 : 0;
      const replyChain = fSender && item.replyTo && item.replyTo === fSender ? 1 : 0;
      const score = dot * 0.6 + recency * 0.2 + sameSpeaker * 0.1 + replyChain * 0.1;
      hits.push({ score, dot, recency, item });
    }
    hits.sort((a, b) => b.score - a.score);
    return { hits: hits.slice(0, topK), scanned };
  }

  function stats() {
    return { total: byId.size, file, dirty };
  }

  function close() {
    if (appendFd != null) { try { fs.closeSync(appendFd); } catch {} appendFd = null; }
  }

  return { add, search, stats, close, load };
}
