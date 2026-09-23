// lib/atomic.js — 原子文件写入 / 安全读取 / 单进程写锁 / JSONL
//
// 为什么需要它：
//   原实现全是裸 fs.writeFile。写到一半崩溃 → 文件半截 → JSON 解析失败 → 数据不可见。
//   并发两个请求改同一个 index.json → 后写覆盖先写，丢更新。
//
// 分层设计（避免锁重入死锁）：
//   - 内部实现（#writeAtomicRaw / #mutateRaw）不加锁，只做实际的读写
//   - 公开 API（writeJsonAtomic / mutateJson）负责加锁，然后调用内部实现
//   - 这样 mutateJson 在锁内调用的是无锁版本，不会自己等自己
//
// 另外：withLock 支持嵌套同键（通过 AsyncLocalStorage 标记持锁上下文），
//       避免"持锁时又调用了加锁 API"造成的自锁。

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

// ── 写锁：path → Promise 链 ──
const _locks = new Map();

// 记录当前异步上下文已持有的锁键，用于同键重入检测
const _heldKeys = new AsyncLocalStorage();

/**
 * 按文件路径串行执行异步操作（单进程内互斥）。
 * 同一路径的多个调用会排队，前一个完成才轮到下一个。
 *
 * 可重入：若当前异步上下文已持有同一把锁，直接执行，不再排队（否则自锁死）。
 *
 * @template T
 * @param {string} filePath - 互斥键
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withLock(filePath, fn) {
  const key = path.resolve(filePath);

  // 同键重入：当前上下文已经持有这把锁，直接跑
  const held = _heldKeys.getStore();
  if (held && held.has(key)) {
    return fn();
  }

  const prev = _locks.get(key) || Promise.resolve();

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = prev.then(() => gate);
  _locks.set(key, tail);

  try {
    await prev; // 等前一个持锁者完成
    const nextHeld = new Set(held || []);
    nextHeld.add(key);
    return await _heldKeys.run(nextHeld, () => fn());
  } finally {
    release();
    // 仅当自己仍是链尾时才清理，避免误删后续等待者
    if (_locks.get(key) === tail) _locks.delete(key);
  }
}

/** 确保目录存在。 */
export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * 无锁的原子写实现。调用方必须已持有该路径的锁。
 * @param {string} filePath
 * @param {string} text
 */
async function writeAtomicRaw(filePath, text) {
  const dir = path.dirname(filePath);
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  try {
    await fs.writeFile(tmp, text, "utf8");
    await fs.rename(tmp, filePath);
  } catch (e) {
    try {
      await fs.rm(tmp, { force: true });
    } catch { /* ignore */ }
    throw e;
  }
}

/**
 * 原子写入 JSON：先写同目录临时文件，再 rename 覆盖。
 * rename 在同一文件系统内是原子操作——要么看到旧文件，要么看到新文件，不会看到半截。
 *
 * 自带写锁：同一路径的并发写会串行。
 * （Windows 上多个临时文件同时 rename 到同一目标会 EPERM，必须串行化。）
 *
 * @param {string} filePath
 * @param {unknown} data
 * @param {{ pretty?: boolean }} [opts]
 */
export async function writeJsonAtomic(filePath, data, opts = {}) {
  const { pretty = true } = opts;
  await ensureDir(path.dirname(filePath));
  const text = JSON.stringify(data, null, pretty ? 2 : 0);
  return withLock(filePath, () => writeAtomicRaw(filePath, text));
}

/**
 * 安全读取 JSON。文件不存在 / 内容损坏 → 返回 fallback（不抛异常）。
 *
 * @template T
 * @param {string} filePath
 * @param {T} fallback
 * @returns {Promise<T>}
 */
export async function readJsonSafe(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    if (e?.code === "ENOENT") return fallback;
    // 解析失败：把坏文件改名留证，返回 fallback，让系统继续可用
    try {
      const broken = `${filePath}.broken-${Date.now()}`;
      await fs.rename(filePath, broken);
      console.error(`[atomic] JSON 损坏，已备份到 ${broken}: ${e?.message}`);
    } catch { /* ignore */ }
    return fallback;
  }
}

/** 无锁的 read→mutate→write。调用方必须已持有该路径的锁。 */
async function mutateRaw(filePath, fallback, mutator) {
  const current = await readJsonSafe(filePath, fallback);
  const next = await mutator(current);
  if (next !== undefined) {
    await ensureDir(path.dirname(filePath));
    await writeAtomicRaw(filePath, JSON.stringify(next, null, 2));
  }
  return next === undefined ? current : next;
}

/**
 * 读 → 改 → 写 的原子组合（整个序列持锁）。
 *
 * @param {string} filePath
 * @param {unknown} fallback - 文件不存在时的初始值
 * @param {(current: unknown) => Promise<unknown>|unknown} mutator
 *   - 返回 undefined → 不写盘，返回原值
 *   - 返回其它值 → 写盘并返回该值
 */
export async function mutateJson(filePath, fallback, mutator) {
  return withLock(filePath, () => mutateRaw(filePath, fallback, mutator));
}

/** 原子写 + 加锁（语义同 writeJsonAtomic，保留旧名）。 */
export async function writeJsonLocked(filePath, data, opts = {}) {
  return writeJsonAtomic(filePath, data, opts);
}

/**
 * 追加一行 JSON（JSONL）。用于消息流 / 事件流这类只追加的场景。
 * 自带写锁，避免并发追加交错。
 */
export async function appendJsonl(filePath, record) {
  await ensureDir(path.dirname(filePath));
  const line = JSON.stringify(record) + "\n";
  return withLock(filePath, () => fs.appendFile(filePath, line, "utf8"));
}

/**
 * 读取 JSONL。损坏行跳过并计数，不整体失败。
 * @returns {Promise<{ records: unknown[], corrupted: number }>}
 */
export async function readJsonlSafe(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const records = [];
    let corrupted = 0;
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        records.push(JSON.parse(t));
      } catch {
        corrupted++;
      }
    }
    return { records, corrupted };
  } catch (e) {
    if (e?.code === "ENOENT") return { records: [], corrupted: 0 };
    throw e;
  }
}

/** 诊断用：当前有多少路径持锁。 */
export function lockCount() {
  return _locks.size;
}
