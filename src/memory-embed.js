// 记忆层用的 embedding 抽象（2026-10-30）
//
// 第一阶段刻意用**本地哈希 n-gram 基线**，不用真模型：
//   1. 零依赖、同步、可单测 —— 先把 archive → embed → store → search 这条链路跑通；
//   2. 换模型只改 provider，不动 store / retrieval / 接线；
//   3. 群聊短文本（"葛叶""合守""急了"）用 2-gram 哈希已经能拉开区分度，
//      足以支撑 shadow 阶段的命中率统计。
//
// 明确它不是什么：这不是语义向量。同义词（"菜鸡" vs "杂鱼"）它认不出来。
// 等 shadow 数据证明"检索确实有用"，再换 bge / API —— 那时只需要新增一个 provider。

export const EMBED_DIM = 256;

/** 32 位 FNV-1a，短字符串足够，避免引入依赖。 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function l2normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i += 1) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (!norm) return vec;
  for (let i = 0; i < vec.length; i += 1) vec[i] /= norm;
  return vec;
}

/** 规范化文本：去掉空白、全角转半角常见的没意义差异（保留中文与标点）。 */
export function normalizeText(text) {
  return String(text == null ? '' : text)
    .replace(/[\s\u00a0]+/g, ' ')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .trim();
}

/**
 * 字符 n-gram 哈希向量（同步、纯 JS）。
 * @param {string} text
 * @param {number} [dim]
 * @returns {Float32Array}
 */
export function hashEmbed(text, dim) {
  const size = Math.max(16, Number(dim) || EMBED_DIM);
  const vec = new Float32Array(size);
  const s = normalizeText(text).replace(/ /g, '');
  if (!s) return vec;
  // 单字也进：短消息（"瑞"）如果只取 2-gram 会得到空向量。
  for (let i = 0; i < s.length; i += 1) {
    const gram = s.slice(i, i + 2);
    vec[fnv1a(gram) % size] += 1;
    if (gram.length === 1) vec[fnv1a(gram) % size] += 0.5;
  }
  return l2normalize(vec);
}

export const EMBED_PROVIDERS = Object.freeze({
  hash: {
    label: '本地哈希 n-gram（基线）',
    dim: EMBED_DIM,
    sync: true,
    note: '零依赖，不是语义向量；只用来把链路跑通',
  },
  // 以后要接真模型时加在这里，并让 createEmbedder 返回对应的实现。
  // bge: { label: 'bge-small-zh（ONNX）', dim: 512, sync: false },
});

/**
 * 建一个 embedder。返回的 embed(text) 同步返回 Float32Array。
 * 未来接入异步模型时，这里可以返回 Promise —— 调用方统一用 await 即可。
 * @param {{provider?:string, dim?:number}} [options]
 */
export function createEmbedder(options) {
  const opts = options || {};
  const provider = String(opts.provider || 'hash').trim();
  const spec = EMBED_PROVIDERS[provider];
  if (!spec) throw new Error('未知 embedding provider：' + provider);
  const dim = Math.max(16, Number(opts.dim) || spec.dim);
  return {
    provider,
    dim,
    sync: spec.sync !== false,
    embed(text) {
      return hashEmbed(text, dim);
    },
  };
}

/** 余弦相似度；向量已归一化时就是点积。 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}
