// lib/characters/transfer.js — 角色卡导入导出
//
// 支持导入 SillyTavern 格式（JSON/PNG），导出为多种格式。
// 使用 token 机制管理导入流程（预览 → 确认 → 提交）。

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { detectCardFormat, convertStV2Card, convertStV3Card, toStV2Card, normalizeCard } from "./formats.js";
import { readPngText, writePngText } from "./png.js";

const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8MB
const TOKEN_TTL = 60000; // 60 秒

export class CharacterTransfer {
  constructor(repo) {
    this.repo = repo;
    this.importTokens = new Map(); // token → import data
  }

  /**
   * 准备导入：扫描文件，生成预览
   * @param {string[]} files - 文件路径列表
   * @returns {object} { token, preview }
   */
  async prepareImport(files) {
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error("No files provided");
    }

    const preview = [];
    const token = crypto.randomUUID();
    const importData = {
      files,
      preview,
      token,
      expires: Date.now() + TOKEN_TTL
    };

    for (const filePath of files) {
      try {
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_FILE_SIZE) {
          preview.push({
            path: filePath,
            name: path.basename(filePath),
            importable: false,
            error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max 8MB)`
          });
          continue;
        }

        const buffer = await fs.readFile(filePath);
        const isPng = this.#isPng(buffer);
        const card = await this.#parseCard(buffer, isPng);
        const format = detectCardFormat(card);
        const normalized = normalizeCard(card);

        preview.push({
          path: filePath,
          name: path.basename(filePath),
          importable: true,
          format,
          size: stat.size,
          preview: {
            name: normalized.name || "（无名称）",
            description: normalized.description?.slice(0, 100) || "（无描述）",
            has_book: !!normalized.character_book,
            has_alternate_greetings: normalized.alternate_greetings?.length > 0
          }
        });
      } catch (e) {
        preview.push({
          path: filePath,
          name: path.basename(filePath),
          importable: false,
          error: e.message
        });
      }
    }

    importData.preview = preview;
    this.importTokens.set(token, importData);

    // 清理过期 token
    this.#cleanupExpiredTokens();

    return { token, preview };
  }

  /**
   * 提交导入：将预览中的角色卡写入仓储
   * @param {string} token - prepareImport 返回的 token
   * @returns {object[]} 导入结果列表
   */
  async commitImport(token) {
    const importData = this.importTokens.get(token);
    if (!importData) {
      throw new Error("Invalid or expired import token");
    }
    if (Date.now() > importData.expires) {
      this.importTokens.delete(token);
      throw new Error("Import token expired");
    }

    const results = [];

    for (const item of importData.preview) {
      if (!item.importable) {
        results.push({
          path: item.path,
          name: item.name,
          success: false,
          error: item.error
        });
        continue;
      }

      try {
        const buffer = await fs.readFile(item.path);
        const isPng = this.#isPng(buffer);
        const card = await this.#parseCard(buffer, isPng);
        const normalized = normalizeCard(card);

        const saved = await this.repo.create(normalized);
        results.push({
          path: item.path,
          name: item.name,
          success: true,
          id: saved.id
        });
      } catch (e) {
        results.push({
          path: item.path,
          name: item.name,
          success: false,
          error: e.message
        });
      }
    }

    this.importTokens.delete(token);
    return results;
  }

  /**
   * 取消导入
   * @param {string} token - 要取消的 token
   */
  discardImport(token) {
    this.importTokens.delete(token);
  }

  /**
   * 导出角色卡
   * @param {string} id - 角色卡 ID
   * @param {string} format - 导出格式：'json' | 'st-v2' | 'st-v3' | 'png'
   * @param {Buffer} [pngBuffer] - 如果是 PNG 格式，需要传入原始 PNG buffer
   * @returns {string|Buffer} 导出内容
   */
  async exportCard(id, format = "json", pngBuffer = null) {
    const card = await this.repo.get(id);
    if (!card) {
      throw new Error(`Character not found: ${id}`);
    }

    switch (format) {
      case "json":
        return JSON.stringify(card, null, 2);

      case "st-v2":
        return JSON.stringify(toStV2Card(card), null, 2);

      case "st-v3":
        return JSON.stringify({
          spec: "chara_card_v3",
          spec_version: "3",
          ccv3: this.#toStV3Data(card)
        }, null, 2);

      case "png":
        if (!pngBuffer) {
          throw new Error("PNG export requires pngBuffer");
        }
        return writePngText(pngBuffer, { chara: card });

      default:
        throw new Error(`Unsupported export format: ${format}`);
    }
  }

  /**
   * 导出角色卡到文件
   * @param {string} id - 角色卡 ID
   * @param {string} outputPath - 输出文件路径
   * @param {string} format - 导出格式
   */
  async exportToFile(id, outputPath, format = "json") {
    let content;

    if (format === "png") {
      // 需要原始 PNG buffer，这里简化处理
      throw new Error("PNG export requires original image buffer");
    }

    content = await this.exportCard(id, format);
    await fs.writeFile(outputPath, content, "utf8");
    return outputPath;
  }

  /**
   * 保存头像。
   *
   * 存的形状：<charDir>/avatar.<ext>，与 card.json 同级。
   * 用字符 id 而非文件名——同一角色反复换头像不该堆出一串文件。
   *
   * @returns {Promise<string>} 落盘的文件名（avatar.<ext>）
   */
  async saveAvatar(id, buffer, ext = "png") {
    const card = await this.repo.get(id);
    if (!card) throw new Error(`Character not found: ${id}`);
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new Error("avatar buffer is empty");
    }

    const safeExt = String(ext || "png").replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
    const dir = path.join(this.repo.dir, id);
    await fs.mkdir(dir, { recursive: true });

    // 同 id 的旧头像先清掉：扩展名变了（png→webp）会留下孤儿文件
    for (const old of await fs.readdir(dir).catch(() => [])) {
      if (/^avatar\.[a-z0-9]+$/i.test(old) && old !== `avatar.${safeExt}`) {
        await fs.rm(path.join(dir, old), { force: true });
      }
    }

    const filename = `avatar.${safeExt}`;
    await fs.writeFile(path.join(dir, filename), buffer);
    return filename;
  }

  /**
   * 读回头像。
   * @returns {Promise<{buffer: Buffer, ext: string, path: string}|null>} 没有则 null
   */
  async readAvatar(id) {
    const dir = path.join(this.repo.dir, id);
    let files;
    try { files = await fs.readdir(dir); } catch { return null; }

    const hit = files.find(f => /^avatar\.[a-z0-9]+$/i.test(f));
    if (!hit) return null;

    const p = path.join(dir, hit);
    return {
      buffer: await fs.readFile(p),
      ext: hit.split(".").pop().toLowerCase(),
      path: p
    };
  }

  /**
   * 删掉头像（角色卡删除时由调用方触发；这里单独暴露，便于「取消头像」）。
   */
  async deleteAvatar(id) {
    const dir = path.join(this.repo.dir, id);
    let files;
    try { files = await fs.readdir(dir); } catch { return false; }
    let removed = false;
    for (const f of files) {
      if (/^avatar\.[a-z0-9]+$/i.test(f)) {
        await fs.rm(path.join(dir, f), { force: true });
        removed = true;
      }
    }
    return removed;
  }

  /**
   * 检查是否为 PNG 文件（公开）
   */
  isPng(buffer) {
    return buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }

  /**
   * 检查是否为 PNG 文件（私有）
   */
  #isPng(buffer) {
    return this.isPng(buffer);
  }

  /**
   * 解析卡片内容（JSON 或 PNG）（公开）
   */
  async parseCard(buffer, isPng) {
    if (isPng) {
      const pngData = readPngText(buffer);
      return pngData.chara || pngData.comment || pngData;
    }

    try {
      const content = buffer.toString("utf8");
      return JSON.parse(content);
    } catch (e) {
      throw new Error(`Invalid JSON: ${e.message}`);
    }
  }

  /**
   * 解析卡片内容（JSON 或 PNG）（私有）
   */
  async #parseCard(buffer, isPng) {
    return this.parseCard(buffer, isPng);
  }

  /**
   * 转换为 ST V3 数据格式
   */
  #toStV3Data(card) {
    return {
      name: card.name,
      description: card.description,
      personality: card.personality,
      scenario: card.scenario,
      first_mes: card.first_mes,
      mes_example: card.mes_example,
      system_prompt: card.system_prompt,
      post_history_instructions: card.post_history_instructions,
      creator: card.creator,
      creator_notes: card.creator_notes,
      character_version: card.character_version,
      tags: card.tags,
      alternate_greetings: card.alternate_greetings,
      character_book: card.character_book,
      extensions: card.extensions,
      scene: card.scene,
      system_prompt_enabled: card.system_prompt_enabled
    };
  }

  /**
   * 清理过期 token
   */
  #cleanupExpiredTokens() {
    const now = Date.now();
    for (const [token, data] of this.importTokens) {
      if (now > data.expires) {
        this.importTokens.delete(token);
      }
    }
  }
}

// 导出单例工厂
export function createCharacterTransfer(repo) {
  return new CharacterTransfer(repo);
}
