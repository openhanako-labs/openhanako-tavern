// lib/appearance/repo.js — 外观配置与背景图的落盘
//
// 布局：dataDir/appearance/
//   · config.json       —— { image, veil, blur, updatedAt }
//   · bg-<ts>.<ext>     —— 背景图片（只有一个"当前"图）
//
// 写操作全部用 withLock 串行化，避免并发覆盖与半截文件。
// 写盘失败一律抛出可读的错误，不静默吞。

import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, writeJsonAtomic, readJsonSafe, withLock } from '../atomic.js';
import {
  normalizeAppearance, mimeOf, newImageFilename,
  MAX_IMAGE_BYTES, ALLOWED_EXTS
} from './model.js';

const APPEARANCE_DIR = 'appearance';
const CONFIG_FILE = 'config.json';

export class AppearanceRepo {
  /**
   * @param {string} dataDir — App 数据目录（sdk.dataDir）
   */
  constructor(dataDir) {
    if (!dataDir) throw new Error('dataDir is required');
    this.dataDir = dataDir;
    this.dir = path.join(dataDir, APPEARANCE_DIR);
    this.configFile = path.join(this.dir, CONFIG_FILE);
  }

  async init() {
    await ensureDir(this.dir);
    return this;
  }

  /** 读当前配置。文件不存在/损坏 → 返回默认值。 */
  async read() {
    const raw = await readJsonSafe(this.configFile, null);
    return normalizeAppearance(raw);
  }

  /** 写配置。会做归一化。 */
  async write(config) {
    const next = normalizeAppearance(config);
    await writeJsonAtomic(this.configFile, next);
    return next;
  }

  /**
   * 存一张新图，更新 config，删掉旧图。
   *
   * 整个"写新图 + 改 config"在 config 文件锁内串行执行，
   * 避免并发 saveImage 各自写完图再抢 config，最后留下孤儿文件。
   *
   * @param {Buffer} buffer
   * @param {string} ext — 扩展名（必须在白名单里）
   * @returns {Promise<object>} 归一化后的完整配置
   */
  async saveImage(buffer, ext) {
    if (!ext || !ALLOWED_EXTS.has(ext)) {
      throw new Error(`不支持的扩展名：${ext}（只接受 ${[...ALLOWED_EXTS].join('/')}`);
    }
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new Error('上传的文件为空');
    }
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new Error('图太大了，换一张 12MB 以内的');
    }

    const filename = newImageFilename(ext);
    const filePath = path.join(this.dir, filename);

    return withLock(this.configFile, async () => {
      await ensureDir(this.dir);

      // 写新图（先写再改 config，保证 config 更新时图一定在盘上）
      await fs.writeFile(filePath, buffer);

      // 读现有 config，删旧图
      const cur = await this.read();
      if (cur.image && cur.image !== filename) {
        await fs.rm(path.join(this.dir, cur.image), { force: true }).catch(() => {});
      }

      const next = normalizeAppearance({
        ...cur,
        image: filename,
        updatedAt: new Date().toISOString()
      });
      await writeJsonAtomic(this.configFile, next);
      return next;
    });
  }

  /** 清空背景图：删文件 + 置 image:null。没有图时也是幂等的。 */
  async clearImage() {
    return withLock(this.configFile, async () => {
      const cur = await this.read();
      if (cur.image) {
        await fs.rm(path.join(this.dir, cur.image), { force: true }).catch(() => {});
      }
      const next = normalizeAppearance({
        ...cur,
        image: null,
        updatedAt: new Date().toISOString()
      });
      await writeJsonAtomic(this.configFile, next);
      return next;
    });
  }

  /**
   * 读背景图字节。
   * @returns {Promise<{buffer:Buffer, ext:string, mime:string}|null>} 没有图 → null
   */
  async getImage() {
    const cfg = await this.read();
    if (!cfg.image) return null;
    const filePath = path.join(this.dir, cfg.image);
    try {
      const buf = await fs.readFile(filePath);
      const ext = (path.extname(cfg.image).slice(1) || '').toLowerCase();
      return { buffer: buf, ext, mime: mimeOf(ext) };
    } catch (e) {
      // 文件确实不在了（被外部删了）：当"没图"处理，不 500
      if (e && e.code === 'ENOENT') return null;
      throw e;
    }
  }
}
