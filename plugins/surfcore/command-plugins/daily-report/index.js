/**
 * 今日群报：把群里某一天的聊天聚合成日报。
 *
 * 默认 previewOnly:true —— 只把结果写进 dataDir，QQ 只回一句极短提示，方便本地看样式。
 * 纯统计，不调模型、不花 token。
 */
import fs from 'node:fs';
import path from 'node:path';
import { aggregateMessages, renderReport } from '../../../../src/daily-report-core.js';
import { buildRenderData, renderReportImage, resolveTypst } from './lib/render.js';
import { dayKey, msUntilNextDay } from '../../../../src/day-key.js';

const DEFAULTS = {
  previewOnly: true,
  autoReport: false,
  autoReportTime: '23:50',
  renderImage: true,
  topUsers: 10,
  picks: 5,
  perUser: 1,
};

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function cfg(api) {
  return { ...DEFAULTS, ...(api.config.get() ?? {}) };
}

/** UTC+8 某日的 [00:00:00, 次日 00:00:00) 毫秒区间。 */
export function dayBounds(key) {
  const m = DATE_RE.exec(String(key ?? ''));
  if (!m) return null;
  const start = Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T00:00:00+08:00');
  if (!Number.isFinite(start)) return null;
  return { since: start, until: start + 86400000 };
}

function shiftDay(key, delta) {
  const b = dayBounds(key);
  if (!b) return key;
  return dayKey(b.since + delta * 86400000);
}

function reportPath(api, groupId, key) {
  return path.join(api.dataDir, 'reports', 'group-' + groupId, key + '.txt');
}

function writeReport(api, groupId, key, text) {
  const file = reportPath(api, groupId, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

function formatDay(key) {
  const m = DATE_RE.exec(key);
  return m ? m[2] + '-' + m[3] : key;
}

/** 生成某一天的群报：返回 { ok, text, file, agg } 或 { ok:false, ... }。 */
async function buildReport(api, ctx, targetDay) {
  const bounds = dayBounds(targetDay);
  if (!bounds) {
    return { ok: false, code: 'bad-date', error: '日期不合法：' + targetDay, hint: '格式为 YYYY-MM-DD' };
  }
  if (bounds.since > Date.now()) {
    return { ok: false, code: 'future-date', error: '还没到那一天', hint: '只能看今天或过去的日期' };
  }
  if (!api.qq || !api.qq.messages) {
    return { ok: false, code: 'no-api', error: '宿主没有消息读取接口', hint: '需要较新版本的桥接' };
  }
  const read = await api.qq.messages({ key: ctx.key, since: bounds.since, until: bounds.until });
  if (!read || read.ok === false) {
    return {
      ok: false,
      code: (read && read.code) || 'read-failed',
      error: (read && read.error) || '读取消息失败',
      hint: (read && read.hint) || '检查桥接日志',
    };
  }
  // 群名：报告标题用。拿不到就退化到「本群」，不要拿群号冒充。
  let groupName = '';
  if (api.qq && api.qq.groupName) {
    const g = await api.qq.groupName({ key: ctx.key });
    if (g && g.ok && g.name) groupName = g.name;
  }

  // 成员表：把 QQ 号映射成群名片。失败不影响主流程（退化到消息自带的 sender）。
  let members = null;
  if (api.qq && api.qq.members) {
    const got = await api.qq.members({ key: ctx.key });
    if (got && got.ok && Array.isArray(got.members)) members = got.members;
    else if (got && got.ok === false) api.log('群报：拉群成员表失败，退化到 sender：' + String(got.error ?? ''));
  }
  const options = cfg(api);
  const agg = aggregateMessages(read.messages ?? [], {
    members,
    dayKey: targetDay,
    topUsers: Number(options.topUsers) || DEFAULTS.topUsers,
    picks: Number(options.picks) || DEFAULTS.picks,
    perUser: Number(options.perUser) || DEFAULTS.perUser,
  });
  const text = renderReport(agg, { title: '今日群报' });
  if (!text) return { ok: true, empty: true, agg, text: '' };
  const file = writeReport(api, ctx.groupId, targetDay, text);

  // 长图渲染：失败不阻断文本报告，但要能在日志里看到原因。
  let image = '';
  if (options.renderImage !== false) {
    try {
      const data = buildRenderData(agg, { groupName: groupName || '本群' });
      const png = path.join(api.dataDir, 'renders', `group-${ctx.groupId}`, `${targetDay}.png`);
      const r = await renderReportImage(data, { outFile: png });
      if (r.ok) image = png;
      else api.log(`群报渲染失败 [${r.code}] ${r.error}`);
    } catch (error) {
      api.log('群报渲染异常：' + String(error?.message ?? error));
    }
  }
  return { ok: true, text, file, image, agg };
}

export async function activate(api) {
  let timer = null;
  let stopped = false;

  const resolveDay = (args) => {
    const today = dayKey();
    const arg = String(args ?? '').trim();
    if (!arg) return today;
    if (arg === '昨天') return shiftDay(today, -1);
    if (arg === '今天') return today;
    if (DATE_RE.test(arg)) return arg;
    return null;
  };

  api.commands.register({
    name: '今日群报',
    aliases: ['jrgb', '群报'],
    permission: 'user',
    scopes: ['group'],
    description: '把今天的群聊聚合成日报（默认只落盘预览）',
    async handler(ctx, args) {
      const target = resolveDay(args);
      if (!target) {
        return { text: '日期格式不对。用法：/今日群报、/今日群报 昨天、/今日群报 2026-11-05' };
      }
      const result = await buildReport(api, ctx, target);
      if (!result.ok) return { text: result.error + '\n' + result.hint };
      if (result.empty) {
        api.log('群报 ' + target + ' 没有可统计的消息，不发言');
        return { silent: true };
      }
      const options = cfg(api);
      // 三明治：头部摘要 + 长图 + 尾部彩蛋。图文同条消息时，QQ 会把图压成可点开的缩略图，
      // 群里既能看到关键数字，又不会一条长图刷满屏。
      const head = '📊 ' + formatDay(target) + ' 群报\n共 ' + result.agg.total + ' 条 · ' + result.agg.users + ' 人';
      const tail = options.previewOnly ? '（预览模式，图片存于本地）' : '';
      if (options.previewOnly) {
        return { text: head + '\n' + tail };
      }
      if (result.image) {
        return { segments: [
          { type: 'text', text: head },
          { type: 'image', file: result.image },
          ...(tail ? [{ type: 'text', text: tail }] : []),
        ] };
      }
      return { text: result.text };
    },
  });

  api.commands.register({
    name: '群报设置',
    aliases: ['jrbsz'],
    permission: 'admin',
    scopes: ['group'],
    description: '查看或修改群报配置（仅管理员）',
    async handler(_ctx, args) {
      const arg = String(args ?? '').trim();
      if (!arg) {
        return { text: '群报配置：' + JSON.stringify(cfg(api)) };
      }
      let patch;
      try { patch = JSON.parse(arg); } catch {
        return { text: '用法：/群报设置 {"previewOnly":false}' };
      }
      const next = { ...cfg(api), ...(patch && typeof patch === 'object' ? patch : {}) };
      api.config.set(next);
      return { text: '群报配置已更新：' + JSON.stringify(next) };
    },
  });

  // 自动播报：默认关闭；开启后到点生成，previewOnly 时仍只落盘。
  const scheduleNext = () => {
    if (stopped) return;
    if (timer) { clearTimeout(timer); timer = null; }
    const options = cfg(api);
    if (options.autoReport !== true) return;
    const partsTm = String(options.autoReportTime || '23:50').split(':').map(Number);
    const hh = Math.min(23, Math.max(0, partsTm[0] || 0));
    const mm = Math.min(59, Math.max(0, partsTm[1] || 0));
    const now = Date.now();
    const nextMidnight = now + msUntilNextDay();
    let target = nextMidnight - 86400000 + (hh * 60 + mm) * 60000;
    if (target <= now) target += 86400000;
    timer = setTimeout(() => {
      try {
        api.log('群报自动播报触发，但缺少会话上下文，跳过；请手动 /今日群报');
      } finally {
        scheduleNext();
      }
    }, Math.max(1000, target - now));
    if (typeof timer.unref === 'function') timer.unref();
  };
  scheduleNext();

  api.__dailyReportStop = () => {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
  };
}

export function dispose() {
  // 宿主以 mod.dispose 调用；定时器随进程退出被 unref 释放，这里只保留钩子。
}