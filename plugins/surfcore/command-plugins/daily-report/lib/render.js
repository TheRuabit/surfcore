/**
 * 群报渲染：把 aggregateMessages 的结果转成 Typst 数据并编译成长图。
 *
 * 0 token：只画统计和原始金句，不做话题总结/画像。LLM 版是后续增量。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(HERE, '..', 'templates', 'report.typ');
const FONT_DIR = path.join(HERE, '..', 'assets', 'fonts');

/**
 * 找 Typst 可执行文件。
 *
 * 顺序：显式参数 > 环境变量 > 用户目录（~/.dsh/surfcore/tools/typst）> 插件内置 > PATH。
 * 用户目录优先，是为了让二进制不占仓库体积；插件内置只是兼容旧安装的回退。
 */
export function resolveTypst(explicit = '') {
  if (explicit) return explicit;
  if (process.env.SURFCORE_TYPST) return process.env.SURFCORE_TYPST;
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const userTypst = path.join(home, 'surfcore', 'tools', 'typst', 'typst.exe');
  if (fs.existsSync(userTypst)) return userTypst;
  const bundled = path.join(HERE, '..', 'assets', 'typst', 'typst.exe');
  if (fs.existsSync(bundled)) return bundled;
  return 'typst';
}

/** 二进制缺失时的下载地址与提示（首次使用时引导，不自动执行）。 */
export const TYPST_DOWNLOAD = {
  url: 'https://github.com/typst/typst/releases/latest/download/typst-x86_64-pc-windows-msvc.zip',
  target: '~/.dsh/surfcore/tools/typst/typst.exe',
  hint: '把 typst.exe 放到 ~/.dsh/surfcore/tools/typst/ 下，或设 SURFCORE_TYPST 指向它',
};

const pad = (n) => String(n).padStart(2, '0');

/** '2026-11-06' → '2026年11月06日' */
export function dateText(dayKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey ?? ''));
  return m ? `${m[1]}年${m[2]}月${m[3]}日` : String(dayKey ?? '');
}

/** 把聚合结果转成模板数据。 */
export function buildRenderData(agg, ctx = {}) {
  const quotes = (agg.picks ?? []).slice(0, 5).map((p) => ({ text: p.text, name: p.name }));
  const ranking = (agg.topUsers ?? []).slice(0, 10).map((u) => ({ name: u.name, count: u.count }));
  const repeats = (agg.repeats ?? []).slice(0, 3).map((r) => ({ text: String(r.text ?? '').slice(0, 40), count: r.count }));
  return {
    groupName: String(ctx.groupName || '群聊'),
    dateText: dateText(agg.dayKey),
    tagline: ctx.tagline || '统计口径：仅群聊文字消息，已过滤命令与纯表情',
    stats: {
      total: agg.total ?? 0,
      users: agg.users ?? 0,
      chars: agg.chars ?? 0,
      emojis: agg.emojiCount ?? 0,
    },
    hourly: (agg.hourHistogram ?? new Array(24).fill(0)).map((count, hour) => ({ hour, count })),
    quotes,
    ranking,
    repeats,
    // LLM 趣味内容：没有分析时给空数组，模板用 #if 保护，不占位。
    topics: (ctx.analysis && Array.isArray(ctx.analysis.topics)) ? ctx.analysis.topics : [],
    titles: (ctx.analysis && Array.isArray(ctx.analysis.titles)) ? ctx.analysis.titles : [],
    ghost: (ctx.analysis && Array.isArray(ctx.analysis.ghost)) ? ctx.analysis.ghost : [],
    hasAnalysis: Boolean(ctx.analysis && (ctx.analysis.topics?.length || ctx.analysis.titles?.length || ctx.analysis.verdict)),
    verdict: String(ctx.analysis?.verdict ?? ''),
    footer: ctx.footer || 'SurfCore · 今日群报（统计版，未调用模型）',
  };
}

/** 调用 Typst 编译。返回 { ok, file, ms } 或 { ok:false, code, error, hint }。 */
export async function renderReportImage(data, { outFile, typstPath = '', timeoutMs = 30000 } = {}) {
  if (!outFile) return { ok: false, code: 'no-output', error: '缺少输出路径', hint: '检查插件 dataDir' };
  const exe = resolveTypst(typstPath);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-'));
  const started = Date.now();
  try {
    const tpl = fs.readFileSync(TEMPLATE, 'utf8');
    fs.writeFileSync(path.join(workDir, 'report.typ'), tpl, 'utf8');
    fs.writeFileSync(path.join(workDir, 'data.json'), JSON.stringify(data, null, 2), 'utf8');
    // 模板里 #image("mascot/...") 是相对 typ 文件的，素材必须一起搬过去
    const mascotDir = path.join(HERE, '..', 'assets', 'mascot');
    if (fs.existsSync(mascotDir)) fs.cpSync(mascotDir, path.join(workDir, 'mascot'), { recursive: true });
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const args = [
      'compile',
      '--font-path', FONT_DIR,
      '--font-path', path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'),
      path.join(workDir, 'report.typ'),
      outFile,
    ];
    // 用 spawn + stdio:'ignore'：DSH 沙箱禁止通过管道捕获子进程输出（会报 spawn EPERM）。
    // 失败原因从 stderr 落盘文件里读，相当于自建一条不经过管道的日志通道。
    const stderrFile = path.join(workDir, 'stderr.txt');
    const args2 = args.slice(0, -1).concat(['--diagnostic-format', 'short', outFile]);
    // 上面的参数改写不稳，退回原始 args；stderr 由 shell 重定向不可用，改为失败时只看退出码。
    await new Promise((resolve, reject) => {
      const child = spawn(exe, args, { timeout: timeoutMs, windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(Object.assign(new Error('typst exit ' + code), { code, killed: code === null }));
      });
    });
    return { ok: true, file: outFile, ms: Date.now() - started };
  } catch (error) {
    const stderr = String(error?.stderr ?? '').trim();
    return {
      ok: false,
      code: error?.killed ? 'render-timeout' : 'render-failed',
      error: stderr || String(error?.message ?? error),
      hint: error?.killed ? `渲染超过 ${timeoutMs}ms` : '检查 Typst 是否可用（SURFCORE_TYPST 或 assets/typst/typst.exe）',
    };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}