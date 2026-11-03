// 字符 bigram + BM25 检索（2026-10-30）
//
// 为什么加它：哈希 n-gram 的向量检索在群聊上有个致命问题 —— "[图片]"、"[转发消息]"
// 这类高频短串互相匹配能到 0.88，而真正的语义相关反而不高。BM25 有 IDF，
// 高频串的权重会自动趋近 0，这是零依赖条件下能拿到的最便宜的药。
//
// 接口和 memory-store 完全一致：add(memory) / search(query, {filter, topK})。
// 上层不知道底下是向量还是 BM25。
import fs from 'node:fs';
import path from 'node:path';

const K1 = 1.2;
const B = 0.75;
const MAX_LOAD = 50_000;

function tokenize(text) {
  const s = String(text == null ? '' : text)
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    // @昵称 是称呼不是内容；不剥掉的话每条带同一个 @ 的消息都会互相命中。
    .replace(/@\S+/g, ' ');
  const out = [];
  // 英文 / 数字 / 下划线：整词
  for (const m of s.matchAll(/[a-z0-9_]{2,}/g)) out.push(m[0]);
  // 中文：切成连续汉字段，每段产出单字 + bigram
  for (const seg of s.split(/[^\u4e00-\u9fa5]+/)) {
    if (!seg) continue;
    for (let i = 0; i < seg.length; i += 1) {
      out.push(seg[i]);
      if (i + 1 < seg.length) out.push(seg.slice(i, i + 2));
    }
  }
  return out;
}

function stableHash(text) {
  let h = 0x811c9dc5;
  const s = String(text || '');
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
  return (h >>> 0).toString(36);
}

/**
 * @param {{file?:string, log?:Function, maxLoad?:number}} options
 */
export function createBM25Store(options) {
  const opts = options || {};
  const file = opts.file || '';
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const maxLoad = Number(opts.maxLoad) > 0 ? Number(opts.maxLoad) : MAX_LOAD;

  /** id -> { id, key, seq, messageId, sender, userId, time, replyTo, type, text, len, tf:Map } */
  const docs = new Map();
  /** term -> Set<docId> */
  const postings = new Map();
  let totalLen = 0;
  let appendFd = null;

  function idOf(memory) {
    const key = String(memory.key || '');
    if (memory.seq != null && Number.isFinite(Number(memory.seq))) return key + ':' + Number(memory.seq);
    return key + ':h' + stableHash(memory.text || '');
  }

  function index(doc) {
    doc.tf = new Map();
    const terms = tokenize(doc.text);
    for (const t of terms) doc.tf.set(t, (doc.tf.get(t) || 0) + 1);
    doc.len = terms.length || 1;
    for (const t of doc.tf.keys()) {
      let set = postings.get(t);
      if (!set) { set = new Set(); postings.set(t, set); }
      set.add(doc.id);
    }
    totalLen += doc.len;
  }

  function load() {
    if (!file || !fs.existsSync(file)) return { loaded: 0 };
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { log('[BM25] 读取失败：' + String(e && e.message)); return { loaded: 0 }; }
    const lines = text.split('\n');
    const start = Math.max(0, lines.length - maxLoad);
    let loaded = 0;
    for (let i = start; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const item = JSON.parse(line);
        if (!item || !item.id || !item.text) continue;
        if (docs.has(item.id)) continue;
        docs.set(item.id, item);
        index(item);
        loaded += 1;
      } catch { /* 坏行跳过 */ }
    }
    return { loaded };
  }

  function append(doc) {
    if (!file) return;
    try {
      if (appendFd == null) { fs.mkdirSync(path.dirname(file), { recursive: true }); appendFd = fs.openSync(file, 'a'); }
      const { tf, ...rest } = doc;
      fs.writeSync(appendFd, JSON.stringify(rest) + '\n');
    } catch (e) { log('[BM25] 追加失败：' + String(e && e.message)); }
  }

  function add(input) {
    const memory = input && typeof input === 'object' ? input : {};
    const text = String(memory.text || '').trim();
    if (!text) return { added: false, id: '' };
    const id = idOf(memory);
    if (docs.has(id)) return { added: false, id };
    const doc = {
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
    };
    docs.set(id, doc);
    index(doc);
    append(doc);
    return { added: true, id };
  }

  function search(query, opts2) {
    const o = opts2 || {};
    const q = String(query || '').trim();
    const topK = Math.max(1, Math.min(50, Number(o.topK) || 5));
    const now = Number(o.now) || Date.now();
    if (!q || !docs.size) return { hits: [], scanned: 0 };

    const filter = o.filter && typeof o.filter === 'object' ? o.filter : {};
    const fKey = filter.key ? String(filter.key) : '';
    const fSince = Number(filter.since) > 0 ? Number(filter.since) : 0;
    // 时间上界：检索「旧记忆」时排除 query 自己所在的窗口。
    const fBefore = Number(filter.before) > 0 ? Number(filter.before) : 0;

    const qTerms = [...new Set(tokenize(q))];
    if (!qTerms.length) return { hits: [], scanned: 0 };
    const N = docs.size;
    const avgdl = totalLen / Math.max(1, N);

    const scores = new Map();
    for (const term of qTerms) {
      const set = postings.get(term);
      if (!set) continue;
      const df = set.size;
      // BM25 的 idf；+1 避免负值
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      if (idf <= 0) continue;
      // 单字（什么/的/了）几乎每条都有，只做兜底；bigram 才是带信息的单位。
      const termWeight = term.length === 1 ? 0.3 : 1;
      for (const docId of set) {
        const doc = docs.get(docId);
        if (!doc) continue;
        if (fKey && doc.key !== fKey) continue;
        if (fSince && doc.time < fSince) continue;
        if (fBefore && doc.time >= fBefore) continue;
        const tf = doc.tf.get(term) || 0;
        if (!tf) continue;
        const denom = tf + K1 * (1 - B + B * (doc.len / avgdl));
        const s = termWeight * idf * (tf * (K1 + 1)) / denom;
        scores.set(docId, (scores.get(docId) || 0) + s);
      }
    }

    const hits = [];
    for (const [docId, raw] of scores) {
      const doc = docs.get(docId);
      if (!doc) continue;
      // 归一化到 0~1：tanh 压一下长文档的多词命中优势。除数 8 是对短 query 的饱和修正。
      const bm25 = Math.tanh(raw / 8);
      const ageHours = Math.max(0, (now - doc.time) / 3600000);
      const recency = Math.max(0, 1 - ageHours / 168);
      // query 是多条消息拼的，sender 没有唯一值；不再按说话人/引用链加权。
      const score = bm25 * 0.75 + recency * 0.25;
      hits.push({ score, bm25, recency, item: doc });
    }
    hits.sort((a, b) => b.score - a.score);
    return { hits: hits.slice(0, topK), scanned: scores.size };
  }

  function stats() { return { total: docs.size, terms: postings.size, avgLen: docs.size ? totalLen / docs.size : 0 }; }
  function close() { if (appendFd != null) { try { fs.closeSync(appendFd); } catch {} appendFd = null; } }

  return { add, search, stats, load, close };
}

export { tokenize };
