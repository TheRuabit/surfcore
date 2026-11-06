/**
 * 桥接侧命令插件宿主。
 *
 * 插件包只依赖这里暴露的受控 API；命令在桥接进程执行，不经过 DSH。
 * 失败（权限/未知/禁用/异常/限流）由调用方写 Log Terminal，不自动回 QQ。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ID_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const RESERVED = new Set(['reset', 'new', 'status', 'role', 'silent', 'quiet', 'active', 'speak']);
const DEFAULT_RATE_PER_MINUTE = 30;
const DEFAULT_HANDLER_TIMEOUT_MS = 5000;

function text(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeName(value) {
  return text(value, 32).toLowerCase();
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function normalizeManifest(raw, dir, source) {
  if (!raw || typeof raw !== 'object') throw new Error('manifest 必须是对象');
  const id = String(raw.id ?? path.basename(dir)).trim();
  if (!ID_RE.test(id)) throw new Error('manifest.id 格式不合法');
  const entry = String(raw.entry ?? 'index.js').trim();
  if (!entry || entry.length > 80) throw new Error('manifest.entry 不合法');
  const entryPath = path.resolve(dir, entry);
  const dirPath = path.resolve(dir);
  if (entryPath !== dirPath && !entryPath.startsWith(`${dirPath}${path.sep}`)) {
    throw new Error('manifest.entry 不能跳出插件目录');
  }
  return {
    id,
    name: text(raw.name ?? id, 60),
    version: text(raw.version ?? '0.0.0', 20),
    description: text(raw.description ?? '', 300),
    entry,
    entryPath,
    enabled: raw.enabled === true,
    capabilities: Array.isArray(raw.capabilities) ? raw.capabilities.map(String).slice(0, 20) : [],
    platforms: Array.isArray(raw.platforms) ? raw.platforms.map(String).slice(0, 10) : [],
    author: text(raw.author ?? 'local', 60),
    dir: dirPath,
    source,
  };
}

function validateSpec(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('command 必须是对象');
  const name = text(raw.name, 32);
  if (!name) throw new Error('command.name 不能为空');
  const aliases = Array.isArray(raw.aliases) ? raw.aliases.map((item) => text(item, 32)).filter(Boolean).slice(0, 12) : [];
  const permission = raw.permission === 'admin' ? 'admin' : 'user';
  const scopes = Array.isArray(raw.scopes)
    ? raw.scopes.map(String).filter((item) => item === 'group' || item === 'private')
    : ['group', 'private'];
  if (typeof raw.handler !== 'function') throw new Error('command.handler 必须是函数');
  return {
    name,
    aliases,
    permission,
    scopes: scopes.length ? scopes : ['group', 'private'],
    description: text(raw.description ?? '', 160),
    handler: raw.handler,
  };
}

export function createCommandHost({
  dirs = [],
  stateFile,
  dataRoot,
  commandLog = null,
  shared = null,
  log = () => {},
  sendReply = async () => {},
  activeMembers = async () => [],
  now = Date.now,
  ratePerMinute = DEFAULT_RATE_PER_MINUTE,
  handlerTimeoutMs = DEFAULT_HANDLER_TIMEOUT_MS,
} = {}) {
  if (!stateFile) throw new Error('command-host 需要 stateFile');
  if (!dataRoot) throw new Error('command-host 需要 dataRoot');
  const statePath = path.resolve(stateFile);
  const root = path.resolve(dataRoot);
  const pluginDirs = dirs.map((dir) => path.resolve(dir));
  const perMinute = Math.max(1, Math.min(300, Number(ratePerMinute) || DEFAULT_RATE_PER_MINUTE));
  const handlerMs = Math.max(500, Math.min(60_000, Number(handlerTimeoutMs) || DEFAULT_HANDLER_TIMEOUT_MS));

  let state = readState();
  const active = new Map();   // id -> { manifest, commands: Map(normalized -> spec), dispose }
  const known = new Map();    // normalized -> { spec, pluginId, manifest }
  const loadErrors = new Map(); // id -> error
  const rate = new Map();     // bucket -> timestamps[]

  function readState() {
    const raw = readJson(statePath, {}) ?? {};
    return {
      enabled: raw.enabled && typeof raw.enabled === 'object' ? raw.enabled : {},
      config: raw.config && typeof raw.config === 'object' ? raw.config : {},
    };
  }

  function saveState() {
    writeJsonAtomic(statePath, state);
  }

  function discover() {
    const plugins = [];
    const errors = [];
    const seen = new Map();
    for (const dir of pluginDirs) {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pluginDir = path.join(dir, entry.name);
        let manifest;
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));
          manifest = normalizeManifest(raw, pluginDir, dir === pluginDirs[0] ? 'builtin' : 'user');
        } catch (error) {
          errors.push({ id: entry.name, source: dir, error: text(error?.message ?? error, 200) });
          continue;
        }
        const previous = seen.get(manifest.id);
        if (previous) {
          previous.error = 'duplicate-id';
          errors.push({ id: manifest.id, source: manifest.source, error: 'duplicate-id' });
          continue;
        }
        seen.set(manifest.id, manifest);
        plugins.push(manifest);
      }
    }
    return { plugins, errors };
  }

  function isEnabled(manifest) {
    if (state.enabled[manifest.id] === true) return true;
    if (state.enabled[manifest.id] === false) return false;
    // 用户目录插件必须显式启用；不能靠 manifest 自报 enabled 绕过设置页。
    if (manifest.source === 'user') return false;
    return manifest.enabled === true;
  }

  function dataDirFor(id) {
    return path.join(root, id);
  }

  function logEntry({ ctx, spec, pluginId, outcome, code, hint, reply = false, durationMs = 0, message = '', level }) {
    const entry = {
      level: level || (outcome === 'error' ? 'error' : (outcome === 'ok' ? 'info' : 'warn')),
      outcome,
      code,
      hint,
      key: ctx?.key ?? '',
      actorId: ctx?.userId ?? '',
      actorName: ctx?.senderName ?? '',
      raw: ctx?.raw ?? '',
      command: spec?.name ?? '',
      plugin: pluginId ?? '',
      permission: spec?.permission ?? '',
      reply: reply === true,
      durationMs,
      message,
    };
    if (commandLog) {
      try { commandLog.append(entry); } catch (error) { log(`[commands] 日志写入失败：${text(error?.message ?? error)}`); }
    } else {
      log(`[commands] ${outcome}/${code} ${entry.raw}`);
    }
    return entry;
  }

  function makeApi(manifest, specs) {
    const dataDir = dataDirFor(manifest.id);
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch { /* ignore */ }
    const api = {
      id: manifest.id,
      manifest,
      dataDir,
      log: (...args) => log(`[ext:${manifest.id}]`, ...args),
      config: {
        get: () => state.config[manifest.id] ?? {},
        set: (value) => {
          state.config[manifest.id] = value && typeof value === 'object' ? value : {};
          saveState();
          return state.config[manifest.id];
        },
      },
      commands: {
        register: (spec) => {
          const normalized = validateSpec(spec);
          specs.push(normalized);
          return normalized;
        },
      },
      qq: {
        activeMembers: async ({ key, days = 30, limit = 100 } = {}) => {
          try {
            return await activeMembers({ key: String(key ?? ''), days, limit });
          } catch (error) {
            log(`[ext:${manifest.id}] activeMembers 失败：${text(error?.message ?? error)}`);
            return [];
          }
        },
      },
      shared: shared ? {
        get: (key, fallback = null) => shared.get(manifest.id, key, fallback),
        set: (key, value) => shared.set(manifest.id, key, value),
        merge: (patch) => shared.merge(manifest.id, patch),
        list: () => shared.list(manifest.id),
      } : null,
      crypto: { randomUUID: () => crypto.randomUUID() },
    };
    return api;
  }

  async function activate(manifest) {
    const previous = active.get(manifest.id);
    if (previous) await deactivate(manifest.id);
    for (const [key, item] of known) {
      if (item.pluginId === manifest.id || !active.has(item.pluginId)) known.delete(key);
    }
    loadErrors.delete(manifest.id);
    const specs = [];
    let mod;
    try {
      mod = await import(`${pathToFileURL(manifest.entryPath).href}?v=${crypto.randomUUID()}`);
    } catch (error) {
      const message = text(error?.message ?? error, 300);
      loadErrors.set(manifest.id, message);
      log(`[commands] 插件 ${manifest.id} 加载失败：${message}`);
      return { ok: false, error: message };
    }
    try {
      const activateFn = mod.activate ?? mod.default?.activate ?? mod.default;
      if (typeof activateFn !== 'function') throw new Error('入口没有导出 activate(api)');
      await activateFn(makeApi(manifest, specs));
    } catch (error) {
      const message = text(error?.message ?? error, 300);
      try { mod.dispose?.(); } catch { /* ignore */ }
      loadErrors.set(manifest.id, message);
      log(`[commands] 插件 ${manifest.id} 激活失败：${message}`);
      return { ok: false, error: message };
    }
    const normalized = new Map();
    try {
      for (const spec of specs) {
        for (const name of [spec.name, ...spec.aliases]) {
          const key = normalizeName(name);
          if (!key) throw new Error('命令名为空');
          if (RESERVED.has(key)) throw new Error(`命令 ${name} 与内置管理命令冲突`);
          if (known.has(key) || normalized.has(key)) throw new Error(`命令 ${name} 冲突`);
          normalized.set(key, spec);
        }
      }
    } catch (error) {
      const message = text(error?.message ?? error, 300);
      try { mod.dispose?.(); } catch { /* ignore */ }
      loadErrors.set(manifest.id, message);
      log(`[commands] 插件 ${manifest.id} 命令冲突：${message}`);
      return { ok: false, error: message };
    }
    for (const [key, spec] of normalized) known.set(key, { spec, pluginId: manifest.id, manifest });
    active.set(manifest.id, {
      manifest,
      commands: normalized,
      dispose: typeof mod.dispose === 'function' ? mod.dispose : null,
    });
    loadErrors.delete(manifest.id);
    log(`[commands] 已启用 ${manifest.name}（${manifest.id}，${specs.length} 条命令）`);
    return { ok: true, commands: specs.length };
  }

  async function deactivate(id) {
    const record = active.get(id);
    if (!record) return { ok: true, already: true };
    try { record.dispose?.(); } catch (error) { log(`[commands] 插件 ${id} 卸载异常：${text(error?.message ?? error)}`); }
    active.delete(id);
    log(`[commands] 已停用 ${id}`);
    return { ok: true };
  }

  async function load() {
    for (const id of [...active.keys()]) await deactivate(id);
    known.clear();
    loadErrors.clear();
    const { plugins, errors } = discover();
    for (const manifest of plugins) {
      if (manifest.error) continue;
      if (!isEnabled(manifest)) continue;
      await activate(manifest);
    }
    return list();
  }

  function list() {
    const { plugins, errors } = discover();
    return {
      ok: true,
      dirs: pluginDirs,
      plugins: plugins.map((manifest) => {
        const record = active.get(manifest.id);
        const commands = record
          ? [...new Set([...record.commands.values()].map((spec) => spec.name))]
            .map((name) => {
              const spec = [...record.commands.values()].find((item) => item.name === name);
              return { name: spec.name, aliases: spec.aliases, permission: spec.permission, scopes: spec.scopes, description: spec.description };
            })
          : [];
        return {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          source: manifest.source,
          enabled: isEnabled(manifest),
          loaded: Boolean(record),
          capabilities: manifest.capabilities,
          platforms: manifest.platforms,
          author: manifest.author,
          dir: manifest.dir,
          dataDir: dataDirFor(manifest.id),
          error: manifest.error || loadErrors.get(manifest.id) || '',
          config: state.config[manifest.id] ?? {},
          commands,
        };
      }),
      errors,
    };
  }

  async function setEnabled(id, enabled) {
    const { plugins } = discover();
    const manifest = plugins.find((item) => item.id === id && !item.error);
    if (!manifest) throw new Error(`插件不存在或不可用：${id}`);
    if (enabled === true) {
      // 先激活再落盘：激活失败时状态文件不能留下 enabled:true，否则 UI 显示"已启用/未加载"，
      // 重启后反复失败，且用户无法通过停用按钮恢复到干净状态。
      const result = await activate(manifest);
      if (!result.ok) throw new Error(result.error);
      state.enabled[id] = true;
      saveState();
    } else {
      state.enabled[id] = false;
      saveState();
      await deactivate(id);
    }
    return list();
  }

  function setConfig(id, config) {
    state.config[id] = config && typeof config === 'object' ? config : {};
    saveState();
    return state.config[id];
  }

  async function reload(id) {
    if (id) {
      const record = active.get(id);
      const manifest = record?.manifest ?? discover().plugins.find((item) => item.id === id);
      if (!manifest) throw new Error(`插件不存在：${id}`);
      if (!isEnabled(manifest)) return list();
      await deactivate(id);
      const result = await activate(manifest);
      if (!result.ok) throw new Error(result.error);
      return list();
    }
    return load();
  }

  function rateLimited(ctx, spec) {
    const key = `${ctx.key}|${ctx.userId}|${spec.name}`;
    const current = now();
    const times = (rate.get(key) ?? []).filter((at) => current - at < 60_000);
    if (times.length >= perMinute) {
      rate.set(key, times);
      return true;
    }
    times.push(current);
    rate.set(key, times);
    if (rate.size > 500) {
      for (const [bucket, list] of rate) {
        if (!list.length || current - list[list.length - 1] > 60_000) rate.delete(bucket);
      }
    }
    return false;
  }

  async function dispatch(ctx = {}) {
    const raw = String(ctx.raw ?? '').trim();
    if (!raw.startsWith('/')) return { matched: false };
    const first = raw.slice(1).trim().split(/\s+/)[0] ?? '';
    const key = normalizeName(first);
    if (!key) return { matched: false };
    const hit = known.get(key);
    if (!hit) {
      // 斜杠命令未注册：留痕，让 Log Terminal 能看到谁发了什么、为什么没执行。
      logEntry({
        ctx: { ...ctx, raw },
        spec: null,
        pluginId: '',
        outcome: 'unknown',
        code: 'unknown-command',
        hint: '未注册的命令；在设置 → Log Terminal 查看已启用插件',
      });
      return { matched: true, outcome: 'unknown', code: 'unknown-command' };
    }
    const { spec, pluginId, manifest } = hit;
    const started = now();
    const commandCtx = {
      ...ctx,
      command: spec.name,
      plugin: pluginId,
      permission: spec.permission,
      args: raw.slice(1).trim().slice(first.length).trim(),
      raw,
    };
    const scopes = Array.isArray(spec.scopes) && spec.scopes.length ? spec.scopes : ['group', 'private'];
    const scope = ctx.kind === 'private' ? 'private' : 'group';
    if (!scopes.includes(scope)) {
      logEntry({ ctx: commandCtx, spec, pluginId, outcome: 'denied', code: 'scope-mismatch', hint: `命令只在这些场景可用：${scopes.join('/')}` });
      return { matched: true, outcome: 'denied', command: spec.name, plugin: pluginId };
    }
    if (spec.permission === 'admin' && ctx.isOwner !== true) {
      logEntry({ ctx: commandCtx, spec, pluginId, outcome: 'denied', code: 'not-owner', hint: '仅管理员可用；群友失败只记日志，不回 QQ' });
      return { matched: true, outcome: 'denied', command: spec.name, plugin: pluginId };
    }
    if (!active.has(pluginId)) {
      logEntry({ ctx: commandCtx, spec, pluginId, outcome: 'denied', code: 'plugin-disabled', hint: '在设置 → Log Terminal 启用该插件' });
      return { matched: true, outcome: 'denied', command: spec.name, plugin: pluginId };
    }
    if (rateLimited(commandCtx, spec)) {
      logEntry({ ctx: commandCtx, spec, pluginId, outcome: 'rate-limited', code: 'rate-limited', hint: `每个用户每分钟最多 ${perMinute} 次` });
      return { matched: true, outcome: 'rate-limited', command: spec.name, plugin: pluginId };
    }
    try {
      // 超时保护：命令挂在入站主链上，慢插件会卡住整个会话。
      const result = await Promise.race([
        Promise.resolve().then(() => spec.handler(commandCtx, commandCtx.args)),
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(Object.assign(new Error('插件处理超时'), { code: 'plugin-timeout' })), handlerMs);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
      const silent = result == null || result === false || result?.silent === true;
      let replied = false;
      if (!silent) {
        try {
          await sendReply(ctx.key, result);
          replied = true;
        } catch (error) {
          logEntry({ ctx: commandCtx, spec, pluginId, outcome: 'error', code: 'reply-error', hint: '检查桥接日志/SnowLuma 发送状态', durationMs: now() - started, message: text(error?.message ?? error, 300) });
          return { matched: true, outcome: 'error', command: spec.name, plugin: pluginId };
        }
      }
      logEntry({ ctx: commandCtx, spec, pluginId, outcome: 'ok', code: '', hint: '', reply: replied, durationMs: now() - started });
      return { matched: true, outcome: 'ok', command: spec.name, plugin: pluginId, reply: replied };
    } catch (error) {
      const timedOut = error?.code === 'plugin-timeout';
      logEntry({
        ctx: commandCtx,
        spec,
        pluginId,
        outcome: 'error',
        code: timedOut ? 'plugin-timeout' : 'plugin-error',
        hint: timedOut
          ? `插件处理超过 ${handlerMs}ms；查插件里的同步 IO 或外部请求`
          : '查看 bridge.log 的插件堆栈；修正后重载插件',
        durationMs: now() - started,
        message: text(error?.message ?? error, 300),
      });
      return { matched: true, outcome: 'error', command: spec.name, plugin: pluginId };
    }
  }

  return {
    load,
    dispatch,
    list,
    setEnabled,
    setConfig,
    reload,
    deactivate,
    close: async () => { for (const id of [...active.keys()]) await deactivate(id); },
    statePath,
    dataRoot: root,
    dirs: pluginDirs,
  };
}
