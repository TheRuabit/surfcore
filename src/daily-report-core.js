/**
 * 群报聚合（纯函数，不依赖 IO）。
 *
 * 输入是桥接 api.qq.messages 返回的原始消息，输出可直接渲染的统计结构。
 * 采样用混合法：每用户保底 + 全群最长，既保证人人到场又捞得到梗。
 */

const NOISE_RE = /^\[(图片|表情|转发消息|拍一拍|视频|语音|文件|动画表情)[^\]]*\]$/;
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
    .replace(/\[@[^\]]*\]\(mqqapi:\/\/[^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\(mqqapi:\/\/[^)]*\)/g, '$1')
    .replace(/mqqapi:\/\/[^\s)]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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
export function aggregateMessages(messages, { dayKey = '', topUsers = 5, picks = 8, perUser = 2 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const clean = [];
  for (const msg of list) {
    if (!msg || msg.isSelf) continue;
    const text = normalizeText(msg.text);
    if (!isReportable(text)) continue;
    const at = Number(msg.at ?? msg.time) || 0;
    clean.push({
      at,
      userId: String(msg.userId ?? ''),
      name: String(msg.sender ?? msg.userId ?? '').trim() || '未知',
      text,
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
    users: users.size,
    chars: clean.reduce((sum, m) => sum + m.text.length, 0),
    topUsers: ranked.slice(0, Math.max(1, topUsers)).map((u) => ({ name: u.name, count: u.count })),
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
