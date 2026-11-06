/**
 * 黑话候选的统计预筛（纯本地，零模型调用）。
 *
 * 借鉴 AstrBot self_learning 的 jargon_statistical_filter：先本地算分把候选缩到高置信度，
 * 再交给 LLM，避免"每条消息都问模型"变成无底洞。
 *
 * 三个信号加权：跨群 IDF(0.4) + 突发频次(0.3) + 用户集中度(0.3)。
 *
 * 切词用「按标点切块」而不是滑窗或 Intl.Segmenter：
 *   - 滑窗会把「破防了」切成「防了/了兄/防了兄」这类碎片，真实数据上 124 个词 0 个可用；
 *   - Intl.Segmenter 的 zh 词典把「破防」拆成「破」「防」，同样不可用；
 *   - 按标点切块在真实归档（4043 条）上能直接捞出「痒痒鼠」「杂口杂口」这类真黑话。
 * 代价是整句连写会漏，所以另加「>=2 个不同用户用过」把 bot 的回复模板挡在外面。
 */

const MIN_TERM_LENGTH = 2;
const MAX_TERM_LENGTH = 10;
const MIN_FREQUENCY = 5;
const MIN_DISTINCT_USERS = 2;
const MAX_CONTEXT_PER_TERM = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const WEIGHT_IDF = 0.4;
const WEIGHT_BURST = 0.3;
const WEIGHT_CONCENTRATION = 0.2;
const WEIGHT_FREQ = 0.1;

// 常见虚词与高频词：这些不是黑话，命中即丢弃。
const STOPWORDS = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '和', '就', '都',
  '而', '及', '与', '或', '但', '却', '又', '也', '还', '把', '被', '让', '给',
  '这', '那', '哪', '什么', '怎么', '为什么', '因为', '所以', '但是', '然后',
  '现在', '时候', '一个', '一下', '一起', '今天', '明天', '昨天', '不是',
  '没有', '可以', '应该', '知道', '觉得', '感觉', '真的', '好像', '有点',
  '哈哈', '哈哈哈', '呵呵', '嗯嗯', '哦哦', '好的', '收到', '谢谢', '没事',
  '这个', '那个', '这样', '那样', '就是', '还是', '不过', '已经', '可能',
  '需要', '问题', '东西', '事情', '地方', '时间', '自己', '我们', '你们',
]);

const SPLIT_RE = /[\s\u3000,，。.!！?？;；:：、~～…·"'"'()（）\[\]【】<>《》\-—_/\\|]+/;

// 链接、CQ 码、平台标记：不是群友自己的话。
const NOISE_RE = /https?:\/\/|mqqapi|qqbot|ugcimg|markdown|mention|\[CQ:/i;

function normalizeText(value) {
  return String(value ?? '')
    .replace(/@\S+/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ');
}

function isCandidateShape(term) {
  if (!term) return false;
  const len = [...term].length;
  if (len < MIN_TERM_LENGTH || len > MAX_TERM_LENGTH) return false;
  if (STOPWORDS.has(term)) return false;
  if (/^[\d\s]+$/.test(term)) return false;
  if (!/[\u4e00-\u9fa5A-Za-z]/.test(term)) return false;
  return true;
}

/** 按标点切出候选块。返回去重后的词条数组。 */
export function extractTerms(text) {
  const raw = String(text ?? '');
  if (!raw.trim() || NOISE_RE.test(raw)) return [];
  const out = new Set();
  for (const chunk of normalizeText(raw).split(SPLIT_RE)) {
    const piece = chunk.trim();
    if (isCandidateShape(piece)) out.add(piece);
  }
  return [...out];
}

export function createSlangFilter({ now = Date.now } = {}) {
  const groupFreq = new Map();   // key -> Map(term -> count)
  const globalUsers = new Map(); // term -> Set(userId) 跨群去重人数
  const userFreq = new Map();    // key -> Map(term -> Set(userId))
  const firstSeen = new Map();   // key -> Map(term -> ts)
  const contexts = new Map();    // key -> Map(term -> [text])

  function bucket(map, key) {
    let value = map.get(key);
    if (!value) { value = new Map(); map.set(key, value); }
    return value;
  }

  function updateFromMessage(text, key, senderId = '') {
    const groupKey = String(key ?? '').trim();
    if (!groupKey) return 0;
    const terms = extractTerms(text);
    if (!terms.length) return 0;
    const stamp = now();
    const uid = String(senderId ?? '');
    const freq = bucket(groupFreq, groupKey);
    const users = bucket(userFreq, groupKey);
    const seen = bucket(firstSeen, groupKey);
    const ctx = bucket(contexts, groupKey);
    for (const term of terms) {
      freq.set(term, (freq.get(term) ?? 0) + 1);
      if (uid) {
        if (!globalUsers.has(term)) globalUsers.set(term, new Set());
        globalUsers.get(term).add(uid);
      }
      const set = users.get(term) ?? new Set();
      if (uid) set.add(uid);
      users.set(term, set);
      if (!seen.has(term)) seen.set(term, stamp);
      const list = ctx.get(term) ?? [];
      list.push(String(text ?? '').slice(0, 200));
      if (list.length > MAX_CONTEXT_PER_TERM) list.splice(0, list.length - MAX_CONTEXT_PER_TERM);
      ctx.set(term, list);
    }
    return terms.length;
  }

  function score(term, key) {
    const freq = groupFreq.get(key)?.get(term) ?? 0;
    const groupsTotal = Math.max(groupFreq.size, 1);
    let groupsWith = 0;
    for (const map of groupFreq.values()) if (map.has(term)) groupsWith += 1;
    // 三个信号都要能分出高低。同样用 log 递减而不是直接取比值，
    // 否则归档里 idf/burst 会全部顶到 1.0，排序只剩 concentration 一项。
    const idf = Math.log(1 + groupsTotal / Math.max(groupsWith, 1)) / Math.log(1 + groupsTotal);
    const since = firstSeen.get(key)?.get(term) ?? now();
    const ageDays = Math.max((now() - since) / DAY_MS, 1 / 24);
    // burst：单位时间频次，用 log 压到可比较的区间；除以 log1p(总频次) 让它跟绝对量脱钩。
    const burst = Math.min(Math.log1p(freq / ageDays) / Math.log1p(20), 1);
    const distinctUsers = usersOf(key, term);
    // 集中度不是「人越少越高」：真实数据显示高频真黑话反而是多人共用（痒痒鼠 73 次 /14 人），
    // 而单人高频基本是 bot 固定话术（已由 minUsers 挡掉）。这里取「2~4 人」为峰值：
    // 少于 2 人无社群性，多于 6 人更像普通口头禅。
    const concentration = distinctUsers <= 0
      ? 0
      : distinctUsers <= 4
        ? 1
        : Math.max(0, 1 - (distinctUsers - 4) / 12);
    return {
      term,
      frequency: freq,
      distinctUsers,
      idf: Number(idf.toFixed(4)),
      burst: Number(burst.toFixed(4)),
      concentration: Number(Math.min(concentration, 1).toFixed(4)),
      // 第 4 项：绝对频次（对数归一）。只有三项时，两个饱和信号会把排序压平。
      score: Number((
        idf * WEIGHT_IDF
        + burst * WEIGHT_BURST
        + concentration * WEIGHT_CONCENTRATION
        + Math.min(Math.log1p(freq) / Math.log1p(100), 1) * WEIGHT_FREQ
      ).toFixed(4)),
      samples: (contexts.get(key)?.get(term) ?? []).slice(-3),
    };
  }

  function usersOf(key, term) {
    return userFreq.get(key)?.get(term)?.size ?? 0;
  }

  function getCandidates(key, { topK = 10, exclude = [], minFrequency = MIN_FREQUENCY, minUsers = MIN_DISTINCT_USERS } = {}) {
    const groupKey = String(key ?? '').trim();
    const freq = groupFreq.get(groupKey);
    if (!freq) return [];
    const skip = new Set((Array.isArray(exclude) ? exclude : []).map((v) => String(v ?? '').trim()).filter(Boolean));
    const rows = [];
    for (const [term, count] of freq) {
      if (count < minFrequency) continue;
      if (skip.has(term)) continue;
      // >=2 个不同用户：把 bot 的固定话术（"剩余抽取次数""请等待"）挡在外面。
      if (usersOf(groupKey, term) < minUsers) continue;
      rows.push(score(term, groupKey));
    }
    rows.sort((a, b) => b.score - a.score);
    return rows.slice(0, Math.max(1, Number(topK) || 10));
  }

  function resetGroup(key) {
    const groupKey = String(key ?? '').trim();
    groupFreq.delete(groupKey);
    userFreq.delete(groupKey);
    firstSeen.delete(groupKey);
    contexts.delete(groupKey);
  }

  function stats(key) {
    const groupKey = String(key ?? '').trim();
    const freq = groupFreq.get(groupKey) ?? new Map();
    let above = 0;
    for (const [term, count] of freq) {
      if (count >= MIN_FREQUENCY && usersOf(groupKey, term) >= MIN_DISTINCT_USERS) above += 1;
    }
    return { groups: groupFreq.size, terms: freq.size, eligible: above };
  }

  return { updateFromMessage, getCandidates, resetGroup, stats, extractTerms };
}
