// 定时提醒调度器（2026-11-03）
//
// 和 wakeConfig/sleepUntil 分开：提醒是用户明确要求的一次性任务，不受沉睡前观察、
// 当前对话活跃度、其他唤醒抢占的影响。wake=false 到点直接发文本；wake=true 到点唤醒模型。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_TIMEOUT_MS = 100009;
const RETRY_MS = 60_000;
const MAX_ATTEMPTS = 3;

function nowMs() { return Date.now(); }

function newId() {
  return 'rm_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

/**
 * @param {{
 *   file?: string,
 *   log?: Function,
 *   sendText?: (key:string, text:string, reminder:object) => Promise<boolean>|boolean,
 *   wake?: (key:string, text:string, reminder:object) => Promise<boolean>|boolean,
 *   now?: () => number,
 *   graceMs?: number
 * }} options
 */
export function createReminderScheduler(options) {
  const opts = options || {};
  const file = opts.file || '';
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const sendText = typeof opts.sendText === 'function' ? opts.sendText : null;
  const wake = typeof opts.wake === 'function' ? opts.wake : null;
  const now = typeof opts.now === 'function' ? opts.now : nowMs;
  const graceMs = Number(opts.graceMs) >= 0 ? Number(opts.graceMs) : 30 * 60 * 1000;

  const reminders = new Map();
  const timers = new Map();
  let closed = false;

  function publicReminder(r) {
    return { id: r.id, key: r.key, at: r.at, text: r.text, wake: r.wake === true, attempts: r.attempts || 0 };
  }

  function persist() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      const data = { reminders: [...reminders.values()].map((r) => ({
        id: r.id, key: r.key, at: r.at, text: r.text, wake: r.wake === true,
        createdAt: r.createdAt, attempts: r.attempts || 0
      })) };
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
      fs.renameSync(tmp, file);
    } catch (error) {
      log('[提醒] 保存失败：' + String(error?.message ?? error));
    }
  }

  function clearTimer(id) {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
  }

  function remove(id) {
    clearTimer(id);
    reminders.delete(id);
    persist();
  }

  function arm(r) {
    clearTimer(r.id);
    const until = Date.parse(r.at);
    if (!Number.isFinite(until)) return;
    const delay = until - now();
    if (delay <= 0) {
      void fire(r, 0);
      return;
    }
    // 远未来分段续期，避免 setTimeout 溢出。
    if (delay > MAX_TIMEOUT_MS) {
      timers.set(r.id, setTimeout(() => { timers.delete(r.id); arm(r); }, MAX_TIMEOUT_MS).unref?.());
      return;
    }
    timers.set(r.id, setTimeout(() => { timers.delete(r.id); void fire(r, 0); }, delay).unref?.());
  }

  function scheduleRetry(r) {
    clearTimer(r.id);
    timers.set(r.id, setTimeout(() => {
      timers.delete(r.id);
      void fire(r, Math.max(0, now() - Date.parse(r.at)));
    }, RETRY_MS).unref?.());
  }

  async function fire(r, lateMs) {
    if (closed || !r || r.firing) return;
    const late = Math.max(0, Number(lateMs) || 0);
    if (late > graceMs) {
      log(`[提醒] 已过期 ${Math.round(late / 60000)} 分钟，跳过：${r.id}（${r.key}）`);
      remove(r.id);
      return;
    }
    r.firing = true;
    r.attempts = (r.attempts || 0) + 1;
    try {
      const payload = { ...publicReminder(r), lateMs: late };
      const text = late >= 60_000
        ? `（补发，原定 ${new Date(r.at).toLocaleString('zh-CN', { hour12: false })}）${r.text}`
        : r.text;
      const fn = r.wake ? wake : sendText;
      if (!fn) throw new Error(r.wake ? 'wake 未配置' : 'sendText 未配置');
      const ok = await fn(r.key, text, payload);
      if (ok === false) throw new Error('投递失败');
      remove(r.id);
      log(`[提醒] 已触发 ${r.id}（${r.key}，wake=${r.wake ? 'true' : 'false'}）`);
    } catch (error) {
      r.firing = false;
      r.lastError = String(error?.message ?? error);
      if (r.attempts >= MAX_ATTEMPTS) {
        log(`[提醒] 触发失败 ${r.attempts} 次，放弃 ${r.id}（${r.key}）：${r.lastError}`);
        remove(r.id);
      } else {
        persist();
        log(`[提醒] 触发失败（第 ${r.attempts} 次），${RETRY_MS / 1000}s 后重试 ${r.id}：${r.lastError}`);
        scheduleRetry(r);
      }
    }
  }

  function load(loadOptions = {}) {
    if (!file || !fs.existsSync(file)) return { loaded: 0, dropped: 0 };
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
      log('[提醒] 读取失败（将忽略旧文件）：' + String(error?.message ?? error));
      return { loaded: 0, dropped: 0 };
    }
    const list = Array.isArray(raw?.reminders) ? raw.reminders : [];
    let loaded = 0;
    let dropped = 0;
    const t = now();
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const at = Date.parse(String(item.at || ''));
      const key = String(item.key || '').trim();
      const text = String(item.text || '').trim();
      if (!Number.isFinite(at) || !key || !text) { dropped += 1; continue; }
      if (at <= t && t - at > graceMs) { dropped += 1; continue; }
      const r = {
        id: String(item.id || newId()),
        key,
        at: new Date(at).toISOString(),
        text: text.slice(0, 500),
        wake: item.wake === true,
        createdAt: Number(item.createdAt) || t,
        attempts: Number(item.attempts) || 0
      };
      reminders.set(r.id, r);
      loaded += 1;
      if (at <= t) {
        if (loadOptions.fireOverdue !== false) void fire(r, t - at);
      } else {
        arm(r);
      }
    }
    if (dropped) persist();
    return { loaded, dropped };
  }

  function set(input) {
    const p = input || {};
    const key = String(p.key || '').trim();
    const text = String(p.text || '').trim();
    const at = Date.parse(String(p.at || ''));
    if (!key) return { ok: false, error: 'key 不能为空' };
    if (!text) return { ok: false, error: 'text 不能为空' };
    if (!Number.isFinite(at)) return { ok: false, error: 'at 必须是 ISO 时间' };
    if (at <= now() + 1000) return { ok: false, error: 'at 必须晚于当前时间' };
    const r = {
      id: newId(),
      key,
      at: new Date(at).toISOString(),
      text: text.slice(0, 500),
      wake: p.wake === true,
      createdAt: now(),
      attempts: 0
    };
    reminders.set(r.id, r);
    persist();
    arm(r);
    return { ok: true, reminder: publicReminder(r) };
  }

  function cancel(id) {
    const key = String(id || '').trim();
    if (!key || !reminders.has(key)) return { ok: false, error: '提醒不存在' };
    remove(key);
    return { ok: true, canceled: key };
  }

  function list(key) {
    const filter = String(key || '').trim();
    return [...reminders.values()]
      .filter((r) => !filter || r.key === filter)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .map(publicReminder);
  }

  /** 测试/补偿用：触发所有到点的提醒，返回这次触发的 promise。 */
  function checkDue(at) {
    const t = Number(at) || now();
    const tasks = [];
    for (const r of reminders.values()) {
      if (r.firing) continue;
      const until = Date.parse(r.at);
      if (Number.isFinite(until) && until <= t) tasks.push(fire(r, t - until));
    }
    return Promise.all(tasks);
  }

  function close() {
    closed = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  return { load, set, cancel, list, checkDue, close, stats: () => ({ total: reminders.size }) };
}
