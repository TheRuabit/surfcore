/**
 * 群报聚合（纯函数，不依赖 IO）。
 *
 * 输入是桥接 api.qq.messages 返回的原始消息，输出可直接渲染的统计结构。
 * 采样用混合法：每用户保底 + 全群最长，既保证人人到场又捞得到梗。
 */

const NOISE_RE = /^\[(图片|表情|转发消息|拍一拍|视频|语音|文件|动画表情)[^\]]*\]$/;
// 内联出现（不是整条消息）的媒体占位，用于统计表情数
const MEDIA_TOKEN_RE = /\[(图片|表情|动画表情|视频|语音|文件|转发消息|拍一拍)[^\]]*\]/g;
// bot 的模板化交互输出：枚举菜单、编号选择、限时提示。这类保留会让群报变成说明书。
const BOT_TEMPLATE_RE = /[（(]回复编号[^）)]*[）)]|请选择你的|\d+\s*秒内有效|\d+、.*\d+、.*\d+、/;
const MIN_LEN = 2;
const PICK_MAX_CHARS = 60;

function len(text) {
  return String(text ?? '').trim().length;
}

/**
 * 规范化一条消息：去掉 markdown @mention 的原始链接尾巴。
 *
 * SnowLuma 的 at 段在 markdown 文本里会长成
 * `@某人[@某人](mqqapi://markdown/mention?at_type=1&at_tinyid=...)`，
 * 直接进报告既难看又把内部协议暴露给群友。
 */
export function normalizeText(text) {
  return String(text ?? '')
    // 裸 markdown 图片：![alt](url) —— 必须先于通用链接规则，否则 ! 会残留
    .replace(/!\[[^\]]*\]\([^)]*\)?/g, '')
    // @mention 的 markdown 尾巴（mqqapi 协议）
    .replace(/\[@[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/mqqapi:\/\/[^\s)]+/g, '')
    // CQ 码残留：\[CQ:image,...]
    .replace(/\[CQ:[^\]]*\]/g, '')
    // 内联的裸 QQ 号（at 段解析失败时会拼进正文）：10 位上下、独立出现的数字串
    .replace(/(?<![\d])[1-9]\d{5,11}(?![\d])/g, '')
    // 内联的媒体占位（表情/图片等）：整条是它时由 NOISE_RE 丢，句中出现时在这里剥
    .replace(/\[(图片|表情|动画表情|视频|语音|文件|转发消息|拍一拍)[^\]]*\]/g, '')
    // 收尾：多余标点与空白
    .replace(/[\s，。、；：]+$/g, '')
    .replace(/^[@\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 对别的 bot 下命令 / 纯 @ 提问，不算金句（群里有人 @ 别的鱼要抽老婆）。
const BOT_ORDER_RE = /(今日老婆|强娶|抽老婆|今日小猪|今日群报|回声|今日运势)/;
const TRUNCATE_PICK = 60;

/**
 * 一条消息是否适合当"金句"：比 isReportable 更严。
 * 可以统计，但不该被单独摘出来展示。
 */
export function isQuotable(text) {
  const s = String(text ?? '').trim();
  if (s.length < 4) return false;
  if (BOT_ORDER_RE.test(s)) return false;
  if (isBotTemplate(s)) return false;
  if (/^@\S+$/.test(s)) return false;
  return true;
}

/**
 * 复读榜：连续 >= minRepeat 条完全相同的消息。
 *
 * 只看相邻序列 —— 隔很久的巧合重复不是"复读"，那是两个人在说同一件事。
 */
export function detectRepeats(items, { minRepeat = 3 } = {}) {
  const out = [];
  let run = 1;
  for (let i = 1; i <= items.length; i += 1) {
    const prev = items[i - 1];
    const cur = items[i];
    const same = cur && prev && cur.text === prev.text && cur.userId !== prev.userId;
    if (same) { run += 1; continue; }
    if (run >= minRepeat && prev) out.push({ text: prev.text, count: run });
    run = 1;
  }
  return out.sort((a, b) => b.count - a.count).slice(0, 5);
}

/**
 * 构造「QQ 号 → 显示名」的解析器。
 *
 * 优先级：成员表的群名片 > 成员表昵称 > 消息自带的 sender > 裸号。
 * 归档里 sender 为空串时（at 段解析失败），以前会显示成一个纯数字 QQ 号 —— 那看起来像 bug。
 */
export function buildNameResolver(members) {
  const map = new Map();
  for (const m of Array.isArray(members) ? members : []) {
    const uid = String(m?.userId ?? m?.user_id ?? '').trim();
    if (!uid) continue;
    const card = String(m?.card ?? '').trim();
    const nick = String(m?.nickname ?? '').trim();
    map.set(uid, card || nick || '');
  }
  return (userId, fallback) => {
    const uid = String(userId ?? '').trim();
    const fromTable = uid ? map.get(uid) : '';
    if (fromTable) return fromTable;
    const s = String(fallback ?? '').trim();
    // sender 是纯数字且等于自己的号 → 说明没解析出名字，别把 QQ 号显示出去
    if (s && !/^\d{5,}$/.test(s)) return s;
    return uid ? `群友${uid.slice(-4)}` : '未知';
  };
}

/** 数出文本里内联的媒体占位（表情/图片等）。 */
export function countMediaTokens(text) {
  const m = String(text ?? '').match(MEDIA_TOKEN_RE);
  return m ? m.length : 0;
}

/** bot 的模板化输出不算金句（枚举菜单/限时选择），但照样计入统计。 */
export function isBotTemplate(text) {
  return BOT_TEMPLATE_RE.test(String(text ?? ''));
}

/** 过滤掉不该进群报的消息：空、纯媒体占位、命令、过短。 */
export function isReportable(text) {
  const s = normalizeText(text);
  if (!s || s.length < MIN_LEN) return false;
  if (s.startsWith('/')) return false;
  if (NOISE_RE.test(s)) return false;
  return true;
}

/**
 * 聚合一天的消息。
 *
 * @param {Array<{at?:number,time?:number,userId?:string,sender?:string,text?:string,isSelf?:boolean}>} messages
 * @param {{dayKey?:string, topUsers?:number, picks?:number, perUser?:number}} [options]
 */
export function aggregateMessages(messages, { dayKey = '', topUsers = 5, picks = 5, perUser = 2, members = null, includeSelf = true } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  // QQ 号 → 人名：归档里的 sender 可能是空串或裸号，成员表能补上群名片/昵称。
  const nameOf = buildNameResolver(members);
  const clean = [];
  let mediaCount = 0;
  for (const msg of list) {
    // isSelf 的消息（她自己发的）默认计入统计，但不进金句候选 —— 那是「她的话」不是「群友的话」。
    if (!msg) continue;
    if (msg.isSelf && !includeSelf) continue;
    mediaCount += countMediaTokens(msg.text);
    const text = normalizeText(msg.text);
    if (!isReportable(text)) continue;
    const at = Number(msg.at ?? msg.time) || 0;
    const userId = String(msg.userId ?? '');
    clean.push({
      at,
      userId,
      name: nameOf(userId, msg.sender),
      text,
      isSelf: msg.isSelf === true,
    });
  }

  const users = new Map();
  const hourHistogram = new Array(24).fill(0);
  for (const item of clean) {
    const rec = users.get(item.userId) ?? { name: item.name, count: 0, chars: 0 };
    rec.count += 1;
    rec.chars += item.text.length;
    rec.name = item.name;
    users.set(item.userId, rec);
    if (item.at > 0) {
      const h = new Date(item.at + 8 * 3600 * 1000).getUTCHours();
      hourHistogram[h] += 1;
    }
  }

  const ranked = [...users.entries()]
    .map(([userId, rec]) => ({ userId, ...rec }))
    .sort((a, b) => b.count - a.count || b.chars - a.chars);

  // 混合采样：每用户按长度降序取 perUser 条，再并入全群最长的 picks 条。
  const chosen = new Map(); // 用 at+text 去重
  const push = (item) => {
    if (item.isSelf) return;
    if (!isQuotable(item.text)) return;
    const key = `${item.at}|${item.text}`;
    if (!chosen.has(key)) chosen.set(key, item);
  };
  for (const user of ranked) {
    const own = clean.filter((m) => m.userId === user.userId)
      .sort((a, b) => b.text.length - a.text.length)
      .slice(0, Math.max(0, perUser));
    for (const item of own) push(item);
  }
  const longest = [...clean].sort((a, b) => b.text.length - a.text.length).slice(0, Math.max(0, picks));
  for (const item of longest) push(item);

  const picked = [...chosen.values()]
    .sort((a, b) => a.at - b.at)
    .map((item) => ({ at: item.at, name: item.name, text: item.text.slice(0, PICK_MAX_CHARS) }));

  let peakHour = -1;
  let peakCount = 0;
  hourHistogram.forEach((n, h) => { if (n > peakCount) { peakCount = n; peakHour = h; } });

  return {
    dayKey,
    total: clean.length,
    emojiCount: mediaCount,
    users: users.size,
    chars: clean.reduce((sum, m) => sum + m.text.length, 0),
    topUsers: ranked.slice(0, Math.max(1, topUsers)).map((u) => ({ name: u.name, count: u.count })),
    repeats: detectRepeats(clean),
    picks: picked,
    peakHour: peakCount > 0 ? peakHour : -1,
    peakCount,
    hourHistogram,
  };
}

/** 把聚合结果渲染成多行纯文本。空数据返回空串（调用方据此决定不回话）。 */
export function renderReport(agg, { title = '今日群报', maxChars = 480 } = {}) {
  if (!agg || !agg.total) return '';
  const lines = [];
  lines.push(`📊 ${title} · ${agg.dayKey}`);
  lines.push('━━━━━━━━━━');
  lines.push(`共 ${agg.total} 条 · ${agg.users} 人参与`);
  if (agg.topUsers.length) {
    lines.push(`🔥 最活跃：${agg.topUsers.map((u) => `${u.name}(${u.count})`).join('、')}`);
  }
  if (agg.peakHour >= 0) {
    lines.push(`⏰ 高峰：${String(agg.peakHour).padStart(2, '0')} 点 ${agg.peakCount} 条`);
  }
  if (agg.picks.length) {
    lines.push('📝 今日精选：');
    // 逐条追加，逼近上限就停：群里单条消息硬限 500 字，超了会被桥接截断，
    // 那样反而把最后一条截成半句话，不如主动收口。
    for (const item of agg.picks) {
      const line = `  · ${item.name}：${item.text}`;
      if (lines.join('\n').length + line.length + 1 > maxChars) {
        lines.push('  …（完整版见本地报告文件）');
        break;
      }
      lines.push(line);
    }
  }
  return lines.join('\n');
}
