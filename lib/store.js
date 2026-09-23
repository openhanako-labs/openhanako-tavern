// lib/store.js — 索引型仓储基类
//
// 解决三个问题：
//   1. O(n²)：原实现每写一条记录就"读整个 index → 改 → 写回"，导入 100 张卡 = 100 次全量读写
//   2. 并发覆盖：两个请求同时改 index → 后写覆盖先写
//   3. 半截写入：写到一半崩 → index 损坏 → 全部数据不可见
//
// 设计：
//   - 索引常驻内存（首次访问时加载一次），写操作只改内存 + 落盘
//   - 所有落盘走 withLock，串行化
//   - 落盘走 writeJsonAtomic，杜绝半截文件
//   - 提供批量提交（batch），一次落盘替代 N 次

import path from "node:path";
import {
  ensureDir,
  readJsonSafe,
  writeJsonAtomic,
  withLock
} from "./atomic.js";

export class IndexedStore {
  /**
   * @param {string} dataDir - 数据根目录
   * @param {string} subDir - 子目录名（如 "characters"）
   * @param {string} [indexName] - 索引文件名
   */
  constructor(dataDir, subDir, indexName = "index.json") {
    this.dataDir = dataDir;
    this.dir = path.join(dataDir, subDir);
    this.indexFile = path.join(this.dir, indexName);
    this._index = null;      // 内存索引（数组）
    this._loading = null;    // 防并发重复加载
  }

  /** 初始化目录 + 索引文件。 */
  async init() {
    await ensureDir(this.dir);
    await this.#loadIndex();
    return this;
  }

  /** 记录文件的完整路径。 */
  recordPath(id, filename) {
    return path.join(this.dir, filename ?? `${id}.json`);
  }

  /** 加载索引到内存（幂等，并发安全）。 */
  async #loadIndex() {
    if (this._index) return this._index;
    if (this._loading) return this._loading;

    this._loading = (async () => {
      const data = await readJsonSafe(this.indexFile, []);
      this._index = Array.isArray(data) ? data : [];
      this._loading = null;
      return this._index;
    })();

    return this._loading;
  }

  /** 读取索引（返回副本，调用方改不到内部状态）。 */
  async load() {
    const idx = await this.#loadIndex();
    return idx.slice();
  }

  /** 强制从磁盘重载（外部改了文件时用）。 */
  async reload() {
    this._index = null;
    return this.#loadIndex();
  }

  /**
   * 落盘索引。整个"写临时文件 + rename"在锁内。
   * 注意：内存索引是权威，落盘只是持久化。
   */
  async persist() {
    const snapshot = (this._index || []).slice();
    await withLock(this.indexFile, () => writeJsonAtomic(this.indexFile, snapshot));
  }

  /**
   * 在锁内做一次"读索引 → 改 → 落盘"。
   * 用于需要原子性的复合操作。
   *
   * @param {(index: unknown[]) => Promise<unknown[]|void>} mutator
   */
  async mutateIndex(mutator) {
    return withLock(this.indexFile, async () => {
      await this.#loadIndex();
      const next = await mutator(this._index);
      if (Array.isArray(next)) this._index = next;
      await writeJsonAtomic(this.indexFile, this._index.slice());
      return this._index;
    });
  }

  /**
   * 插入或更新一条索引项（按 id 匹配）。
   * 只改内存，不立刻落盘——由调用方决定何时 persist。
   */
  upsert(entry) {
    if (!this._index) this._index = [];
    const i = this._index.findIndex(e => e.id === entry.id);
    if (i >= 0) {
      this._index[i] = { ...this._index[i], ...entry };
    } else {
      this._index.push(entry);
    }
  }

  /** 从索引移除。 */
  remove(id) {
    if (!this._index) return false;
    const before = this._index.length;
    this._index = this._index.filter(e => e.id !== id);
    return this._index.length !== before;
  }

  /** 按 id 查索引项。 */
  find(id) {
    return (this._index || []).find(e => e.id === id) || null;
  }

  /**
   * 批量操作：一次落盘替代 N 次。
   * @param {(index: unknown[]) => Promise<void>} fn - 在内存索引上批量改动
   */
  async batch(fn) {
    await this.#loadIndex();
    await fn(this._index);
    await this.persist();
    return this._index.slice();
  }

  /** 校验 id 是否可安全用作文件名。 */
  static assertSafeId(id, label = "id") {
    if (!id || typeof id !== "string") {
      throw new Error(`Invalid ${label}`);
    }
    if (id.includes("..") || id.includes("/") || id.includes("\\")) {
      throw new Error(`Invalid ${label} (path traversal)`);
    }
    return id;
  }
}
