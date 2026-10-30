// 黑话候选发现器（旁路，2026-10-30）
//
// 定位：不是"学习 Agent"，是"候选词发现器"。
//   老的 slang-learner 走 DSH 会话，每轮 replay 183k 历史（其中两次 web_fetch 的
//   HTML 就占了 50k），代价约 ¥0.7/天，而产出的候选一条都没被确认过。这里换形态：
//
//     cursor 之后的新消息  →  固定短 prompt  →  候选词 + 证据  →  候选池
//
//   没有会话历史，没有 web_fetch 残留，每轮输入基本恒定（1~3k）。
//
// 红线（改动前先读）：
//   1. **不删、不改 slang-learner.js** —— 旧链路完整保留，slangMode 可随时切回。
//   2. **cursor 幂等** —— 同一条消息重复处理不会重复写候选；失败不推进 cursor。
//   3. **原始消息只读** —— 本模块不写 social-v2.json，不删任何日志。
//   4. **不碰消费链** —— 只写 candidate，从不确认、不改 confirmed 词条。
import fs from 'node:fs';
import path from 'node:path';

export const EXTRACTOR_VERSION = 1;

/** 固定 system：越短越稳定，这是 cache 友好的前提。 */
export const EXTRACTOR_SYSTEM = [
  '你是候选词发现器。任务：从一批群聊消息里找出"疑似黑话 / 梗 / 网络用语 / 圈内称呼"。',
  '',
  '只要满足任意一条就输出：',
  '- 字面看不懂、但群里显然都懂（如 "瑞" = respect、"急了" 作反讽）',
  '- 同一个词在一批里反复出现且用法特殊',
  '- 特定圈子的固定说法（游戏、动漫、AI 圈）',
  '',
  '不要输出：',
  '- 普通词、语气词、单字感叹',
  '- 群友昵称 / 外号（除非它本身就是梗）',
  '- 你看不出特殊用法的词',
  '',
  '输出严格的 JSON 数组，不要任何解释文字。每项字段：',
  '{ "term": "词", "guess": "你猜的意思，20 字内；不确定就留空", "evidence": ["原话片段1", "原话片段2"] }',
  '没有发现就输出 []。',
].join('\n');

/** 从消息里取"上下文尾巴"：帮助消歧，不参与找词。 */
export function pickContext(before, size) {
  const list = Array.isArray(before) ? before : [];
  // 注意：size=0 是合法值（不要上文），不能用 `Number(size) || 4` —— 0 是 falsy，
  // 会被悄悄换成默认值 4。这里显式判 NaN。
  const raw = Number(size);
  const n = Number.isFinite(raw) ? Math.max(0, raw) : 4;
  return n ? list.slice(-n) : [];
}

/**
 * 拼一次提取请求。**不含任何历史**：只有固定 system + 上文几行 + 本批消息。
 * @returns {{system:string, user:string}}
 */
export function buildExtractPrompt(messages, context) {
  const ctx = Array.isArray(context) ? context : [];
  const msgs = Array.isArray(messages) ? messages : [];
  const lines = [];
  if (ctx.length) {
    lines.push('[上文，仅供消歧，不要从这里面找词]');
    for (const m of ctx) {
      lines.push((m.sender || '?') + ': ' + String(m.plain || m.text || '').slice(0, 200));
    }
    lines.push('');
  }
  lines.push('[待处理消息]');
  for (const m of msgs) {
    lines.push('[' + (m.seq == null ? '?' : m.seq) + '] ' + (m.sender || '?') + ': ' + String(m.plain || m.text || '').slice(0, 300));
  }
  return { system: EXTRACTOR_SYSTEM, user: lines.join('\n') };
}

const FENCE = String.fromCharCode(96).repeat(3);

/** 解析模型输出。宽容处理围栏、前后废话、单对象。 */
export function parseExtractedTerms(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return [];
  const tries = [];
  const fenceRe = new RegExp(FENCE + '(?:json)?\\s*([\\s\\S]*?)' + FENCE, 'i');
  const fenced = raw.match(fenceRe);
  if (fenced) tries.push(fenced[1]);
  const arr = raw.match(/\[[\s\S]*\]/);
  if (arr) tries.push(arr[0]);
  tries.push(raw);
  for (const candidate of tries) {
    try {
      const parsed = JSON.parse(candidate);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list
        .map((x) => ({
          term: String((x && x.term) || '').trim().slice(0, 40),
          guess: String((x && x.guess) || '').trim().slice(0, 80),
          evidence: (Array.isArray(x && x.evidence) ? x.evidence : [])
            .map((e) => String(e == null ? '' : e).trim().slice(0, 120))
            .filter(Boolean)
            .slice(0, 3),
        }))
        .filter((x) => x.term.length >= 1);
    } catch { /* 试下一种 */ }
  }
  return [];
}

function readJsonSafe(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function createSlangExtractor(options) {
  const opts = options || {};
  const stateDir = opts.stateDir;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const loadMessages = opts.loadMessages;
  const askModel = opts.askModel;
  const onCandidate = opts.onCandidate;
  const minMessages = Number(opts.minMessages) > 0 ? Number(opts.minMessages) : 6;
  const maxBatch = Number(opts.maxBatch) > 0 ? Number(opts.maxBatch) : 60;
  const cooldownMs = Number(opts.cooldownMs) >= 0 ? Number(opts.cooldownMs) : 300000;

  const stateFile = path.join(stateDir, 'slang-extractor-state.json');
  let running = false;
  let lastRunAt = 0;
  const stats = { runs: 0, processed: 0, found: 0, failed: 0, lastError: null };

  function readState() {
    const s = readJsonSafe(stateFile, {});
    const cursors = s && typeof s.cursors === 'object' && s.cursors && !Array.isArray(s.cursors) ? s.cursors : {};
    return {
      version: Number(s && s.version) || EXTRACTOR_VERSION,
      cursors,
      seen: Array.isArray(s && s.seen) ? s.seen.slice(-500) : [],
      runs: Number(s && s.runs) || 0,
      lastRunAt: String((s && s.lastRunAt) || ''),
    };
  }

  function writeState(next) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      const tmp = stateFile + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, stateFile);
      return true;
    } catch (error) {
      log('[黑话提取] 状态写入失败：' + String((error && error.message) || error));
      return false;
    }
  }

  function status() {
    const s = readState();
    return {
      running,
      runs: stats.runs,
      processed: stats.processed,
      found: stats.found,
      failed: stats.failed,
      lastError: stats.lastError,
      cursors: s.cursors,
      lastRunAt: s.lastRunAt,
    };
  }

  async function runOnce(key, runOpts) {
    const force = !!(runOpts && runOpts.force);
    if (running) return { ok: false, skipped: 'busy' };
    if (!force && Date.now() - lastRunAt < cooldownMs) return { ok: false, skipped: 'cooldown' };
    if (typeof loadMessages !== 'function' || typeof askModel !== 'function') {
      return { ok: false, skipped: 'not-configured' };
    }
    running = true;
    stats.runs += 1;
    const state = readState();
    const cursor = Number(state.cursors[key] || 0);
    try {
      const loaded = loadMessages(key) || {};
      const all = Array.isArray(loaded.messages) ? loaded.messages : [];
      const fresh = all.filter((m) => Number((m && m.seq) || 0) > cursor);
      if (fresh.length < minMessages) return { ok: true, skipped: 'not-enough', processed: 0, found: 0 };

      const seqs = all.map((m) => Number((m && m.seq) || 0)).filter((n) => n > 0);
      const earliest = seqs.length ? Math.min.apply(null, seqs) : 0;
      if (cursor && earliest > cursor + 1) {
        log('[黑话提取] ' + key + ' 窗口有缺口（cursor=' + cursor + ', 最早=' + earliest + '），从最早一条继续');
      }

      const batch = fresh.slice(-maxBatch);
      const firstSeq = Number((batch[0] && batch[0].seq) || 0);
      const before = all.filter((m) => Number((m && m.seq) || 0) < firstSeq);
      const context = pickContext(before, 4);
      const prompt = buildExtractPrompt(batch, context);
      let text = '';
      try {
        text = await askModel(prompt);
      } catch (error) {
        stats.failed += 1;
        stats.lastError = String((error && error.message) || error).slice(0, 200);
        log('[黑话提取] 模型调用失败：' + stats.lastError);
        return { ok: false, skipped: 'model-failed' };
      }
      const terms = parseExtractedTerms(text);
      const seen = new Set(state.seen);
      const lastSeq = Number((batch[batch.length - 1] && batch[batch.length - 1].seq) || cursor);
      let added = 0;
      for (const term of terms) {
        if (seen.has(term.term)) continue;
        try {
          if (typeof onCandidate === 'function') onCandidate({ term: term.term, guess: term.guess, evidence: term.evidence, key, seq: lastSeq });
          seen.add(term.term);
          added += 1;
        } catch (error) {
          log('[黑话提取] 写候选失败 ' + term.term + '：' + String((error && error.message) || error));
        }
      }
      stats.processed += batch.length;
      stats.found += added;
      lastRunAt = Date.now();
      writeState({
        version: EXTRACTOR_VERSION,
        cursors: Object.assign({}, state.cursors, { [key]: lastSeq }),
        seen: Array.from(seen).slice(-500),
        runs: stats.runs,
        lastRunAt: new Date().toISOString(),
      });
      log('[黑话提取] ' + key + ' 处理 ' + batch.length + ' 条 → 候选 ' + added + ' 个（cursor → ' + lastSeq + '）');
      return { ok: true, processed: batch.length, found: added };
    } finally {
      running = false;
    }
  }

  function resetCursor(key) {
    const state = readState();
    const cursors = Object.assign({}, state.cursors);
    delete cursors[key];
    writeState({ version: state.version, cursors, seen: state.seen, runs: state.runs, lastRunAt: state.lastRunAt });
    return { ok: true, cursors };
  }

  return { status, runOnce, resetCursor };
}
