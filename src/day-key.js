/**
 * 日切键（钉死 UTC+8）。
 *
 * 不信任宿主时区：机器搬到别的时区或丢到服务器上时，"今天"必须仍然是香港时间的那一天。
 * 先看日期再看时间（Q10）：调用方用 dayKey 判定是否跨天，再决定要不要刷新。
 */

const TZ = 'Asia/Hong_Kong';

function parts(at) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const out = {};
  for (const item of fmt.formatToParts(new Date(at))) {
    if (item.type !== 'literal') out[item.type] = item.value;
  }
  return out;
}

/** 返回 UTC+8 的 YYYY-MM-DD。 */
export function dayKey(at = Date.now()) {
  const p = parts(at);
  return `${p.year}-${p.month}-${p.day}`;
}

/** 返回距下一个 UTC+8 零点还有多少毫秒；正好零点时返回一整天。 */
export function msUntilNextDay(at = Date.now()) {
  const p = parts(at);
  const secIntoDay = Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second);
  const remaining = 86_400 - secIntoDay;
  return remaining * 1000;
}
