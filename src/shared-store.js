/**
 * 插件共享存储：按 namespace 分文件，原子写。
 *
 * 用途是跨插件/跨进程共享少量结构化状态（身份映射、插件摘要），
 * 不是 AI 记忆卡；不要把聊天原文或密钥写进来。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NS_RE = /^[a-z][a-z0-9_-]{1,31}$/;

function defaultDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'surfcore', 'shared');
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function createSharedStore({ dir = defaultDir(), log = () => {} } = {}) {
  const root = path.resolve(dir);

  function fileFor(namespace) {
    const ns = String(namespace ?? '').trim();
    if (!NS_RE.test(ns)) throw new Error('shared namespace 必须是 2~32 位小写字母/数字/下划线');
    return path.join(root, `${ns}.json`);
  }

  function read(namespace) {
    const file = fileFor(namespace);
    const raw = readJson(file, {});
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  }

  function get(namespace, key, fallback = null) {
    const data = read(namespace);
    return Object.prototype.hasOwnProperty.call(data, String(key)) ? data[String(key)] : fallback;
  }

  function set(namespace, key, value) {
    const data = read(namespace);
    data[String(key)] = value;
    writeJsonAtomic(fileFor(namespace), data);
    return value;
  }

  function merge(namespace, patch) {
    const data = read(namespace);
    const next = { ...data, ...(patch && typeof patch === 'object' ? patch : {}) };
    writeJsonAtomic(fileFor(namespace), next);
    return next;
  }

  function list(namespace) {
    return read(namespace);
  }

  function remove(namespace, key) {
    const data = read(namespace);
    delete data[String(key)];
    writeJsonAtomic(fileFor(namespace), data);
    return { ok: true };
  }

  return { dir: root, get, set, merge, list, remove };
}

export function sharedDir() {
  return defaultDir();
}
