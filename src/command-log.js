/**
 * 命令日志（Log Terminal 的后端存储）。
 *
 * 单写者：桥接进程。每行一条 JSON；超过上限轮转到 <file>.1，避免无限增长。
 * 失败命令只进这里，不自动回 QQ。
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_RAW = 200;
const MAX_MESSAGE = 300;

function normalizeText(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function defaultSanitize(text) {
  return String(text ?? '')
    .replace(/(?:x-agent-token|consoleToken|x-console-token)\s*[:=]\s*\S+/gi, '***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-***');
}

function readEntries(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 坏行不阻塞日志读取 */ }
  }
  return out;
}

export function createCommandLog({
  file,
  log = () => {},
  sanitize = defaultSanitize,
  maxEntries = 2000,
  maxBytes = 1_000_000,
} = {}) {
  if (!file) throw new Error('command-log 需要 file');
  const resolved = path.resolve(file);
  const limitEntries = Math.max(2, Math.min(20_000, Number(maxEntries) || 2000));
  const limitBytes = Math.max(64 * 1024, Math.min(20 * 1024 * 1024, Number(maxBytes) || 1_000_000));
  const safe = typeof sanitize === 'function' ? sanitize : defaultSanitize;

  const seqFile = `${resolved}.seq`;

  let count = 0;
  let seq = 0;
  try {
    const existing = readEntries(resolved);
    count = existing.length;
    seq = existing.reduce((max, item) => Math.max(max, Number(item?.seq) || 0), 0);
  } catch { /* 首次运行 */ }
  // 轮转/清空会丢掉旧行，seq 只从当前文件恢复会回退；侧车文件记住水位。
  try {
    const saved = Number(fs.readFileSync(seqFile, 'utf8').trim());
    if (Number.isFinite(saved) && saved > seq) seq = saved;
  } catch { /* 首次运行没有侧车 */ }

  function saveSeq() {
    try {
      fs.mkdirSync(path.dirname(seqFile), { recursive: true });
      fs.writeFileSync(seqFile, String(seq), 'utf8');
    } catch { /* 侧车失败只影响水位，不阻塞日志 */ }
  }

  function ensureDir() {
    try { fs.mkdirSync(path.dirname(resolved), { recursive: true }); } catch { /* ignore */ }
  }

  function rotate() {
    try {
      if (fs.existsSync(resolved)) fs.copyFileSync(resolved, `${resolved}.1`);
      fs.writeFileSync(resolved, '', 'utf8');
      count = 0;
      // seq 不归零：它是 Log Terminal 的增量水位（tail({since})），归零会让前端重复读到旧行。
      // 轮转只丢弃最旧的记录，编号必须继续递增。
    } catch (error) {
      log(`[command-log] 轮转失败：${String(error?.message ?? error)}`);
    }
  }

  function append(entry = {}) {
    ensureDir();
    let size = 0;
    try { size = fs.statSync(resolved).size; } catch { size = 0; }
    if (count >= limitEntries || size >= limitBytes) rotate();
    const next = {
      seq: ++seq,
      at: entry.at || new Date().toISOString(),
      level: ['info', 'warn', 'error'].includes(entry.level) ? entry.level : 'info',
      outcome: String(entry.outcome ?? 'ok').slice(0, 24),
      code: String(entry.code ?? '').slice(0, 64),
      hint: normalizeText(entry.hint, 300),
      key: String(entry.key ?? '').slice(0, 80),
      actorId: String(entry.actorId ?? '').slice(0, 32),
      actorName: normalizeText(entry.actorName, 80),
      raw: normalizeText(safe(entry.raw ?? ''), MAX_RAW),
      command: String(entry.command ?? '').slice(0, 64),
      plugin: String(entry.plugin ?? '').slice(0, 64),
      permission: String(entry.permission ?? '').slice(0, 16),
      reply: entry.reply === true,
      durationMs: Math.max(0, Math.round(Number(entry.durationMs) || 0)),
      message: normalizeText(safe(entry.message ?? ''), MAX_MESSAGE),
    };
    try {
      fs.appendFileSync(resolved, `${JSON.stringify(next)}\n`, 'utf8');
      count += 1;
      saveSeq();
    } catch (error) {
      log(`[command-log] 写入失败：${String(error?.message ?? error)}`);
    }
    return next;
  }

  function tail({ limit = 200, since = 0, outcome = '', q = '' } = {}) {
    const entries = readEntries(resolved);
    const sinceSeq = Number(since) || 0;
    const outcomeFilter = String(outcome ?? '').trim();
    const query = String(q ?? '').trim().toLowerCase();
    const filtered = entries.filter((item) => {
      if ((Number(item?.seq) || 0) <= sinceSeq) return false;
      if (outcomeFilter && String(item?.outcome ?? '') !== outcomeFilter) return false;
      if (query) {
        const hay = `${item?.raw ?? ''} ${item?.command ?? ''} ${item?.actorName ?? ''} ${item?.code ?? ''}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });
    const cap = Math.max(1, Math.min(1000, Number(limit) || 200));
    const sliced = filtered.slice(-cap);
    return {
      ok: true,
      entries: sliced,
      total: entries.length,
      filtered: filtered.length,
      nextSince: sliced.length ? Number(sliced[sliced.length - 1].seq) || 0 : sinceSeq,
      file: resolved,
    };
  }

  function clear() {
    rotate();
    return { ok: true, cleared: true, file: resolved };
  }

  function stats() {
    let size = 0;
    try { size = fs.statSync(resolved).size; } catch { size = 0; }
    return { ok: true, file: resolved, count, seq, maxEntries: limitEntries, maxBytes: limitBytes, size };
  }

  return { append, tail, clear, stats, file: resolved };
}
