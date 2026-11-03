// 长期记忆的查询构造（2026-10-31）
//
// 两件事：判断一条消息是否值得进记忆/当查询；从最近消息里挑一窗，并算出
// 「只看更早」的时间上界。独立成模块是为了能单测，不把判断埋进 bridge。

const MEDIA_ONLY_RE = /^\[(图片|表情|转发消息|拍一拍|视频|语音|文件|动画表情)\]$/;
const PURE_AT_RE = /^@\S+\s*$/;
const TOPIC_WINDOW_MS = 10 * 60 * 1000;

export function isMemoryNoiseText(text) {
  const s = String(text == null ? '' : text).trim();
  return !s || s.length <= 1 || MEDIA_ONLY_RE.test(s) || PURE_AT_RE.test(s);
}

/**
 * 从最近消息里挑出 shadow 检索用的查询窗口。
 * 上界取「窗口内最早一条」与「now - 10 分钟」中更早的那个：前者保证 query 自己不会被检索回来，
 * 后者保证当前正在进行的话题（最近 10 分钟）不参与「旧记忆」检索。
 * @param {Array<{text?:string, plain?:string, time?:number, isSelf?:boolean, kind?:string}>} messages
 * @param {{limit?:number, now?:number}} [options]
 * @returns {{text:string, before:number}}
 */
export function pickShadowQuery(messages, options) {
  const limit = Math.max(1, Number(options?.limit) || 3);
  const now = Number(options?.now) > 0 ? Number(options.now) : Date.now();
  const picked = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && !m.isSelf && m.kind !== 'poke')
    .map((m) => ({ text: String(m.plain || m.text || '').trim(), time: Number(m.time) || 0 }))
    .filter((m) => m.text && !isMemoryNoiseText(m.text))
    .slice(-limit);
  const times = picked.map((m) => m.time).filter((t) => t > 0);
  return {
    text: picked.map((m) => m.text).join(' ').trim(),
    before: times.length ? Math.min(Math.min(...times), now - TOPIC_WINDOW_MS) : 0,
  };
}
