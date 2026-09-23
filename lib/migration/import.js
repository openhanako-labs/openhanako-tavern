// lib/migration/import.js — 完整数据导入

import fs from "node:fs/promises";
import { CharacterRepo } from "../characters/repo.js";
import { ConversationRepo } from "../conversations/repo.js";
import { VariableRepo } from "../variables/repo.js";
import { SettingRepo } from "../settings/repo.js";

export class MigrationImporter {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.characterRepo = new CharacterRepo(dataDir);
    this.conversationRepo = new ConversationRepo(dataDir);
    this.variableRepo = new VariableRepo(dataDir);
    this.settingRepo = new SettingRepo(dataDir);
  }

  // 预览导入数据（从文件）
  async preview(filePath) {
    const content = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(content);
    return this.previewData(data);
  }

  // 预览导入数据（从对象）
  previewData(data) {
    return {
      version: data.version,
      exportedAt: data.exportedAt,
      characters: data.characters?.length || 0,
      conversations: data.conversations?.length || 0,
      variables: data.variables?.length || 0,
      settings: data.settings?.length || 0,
      valid: this.#validateData(data)
    };
  }

  // 导入数据（从文件）
  async importFrom(filePath, options = {}) {
    const content = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(content);
    return this.importData(data, options);
  }

  // 导入数据（从对象）
  async importData(data, options = {}) {
    const { skipExisting = false } = options;

    const results = {
      characters: { added: 0, skipped: 0, errors: [] },
      conversations: { added: 0, skipped: 0, errors: [] },
      variables: { added: 0, skipped: 0, errors: [] },
      settings: { added: 0, skipped: 0, errors: [] }
    };

    // 导入角色卡
    if (data.characters) {
      for (const card of data.characters) {
        try {
          if (skipExisting && (await this.characterRepo.get(card.id))) {
            results.characters.skipped++;
            continue;
          }
          await this.characterRepo.create(card);
          results.characters.added++;
        } catch (e) {
          results.characters.errors.push({ id: card.id, error: e.message });
        }
      }
    }

    // 导入对话
    if (data.conversations) {
      for (const conv of data.conversations) {
        try {
          if (skipExisting && (await this.conversationRepo.get(conv.id))) {
            results.conversations.skipped++;
            continue;
          }
          // 用 restore 而非 create：导入必须保留原 id，否则对话与
          // 角色卡的关联就断了（玩家会看到「聊了很久的对话不见了」）。
          // 已存在则跳过（skipExisting 时），否则覆盖。
          await this.conversationRepo.restore(conv);
          results.conversations.added++;
        } catch (e) {
          results.conversations.errors.push({ id: conv.id, error: e.message });
        }
      }
    }

    // 导入变量
    if (data.variables) {
      for (const variable of data.variables) {
        try {
          if (skipExisting && (await this.variableRepo.getDefinition(variable.id))) {
            results.variables.skipped++;
            continue;
          }
          await this.variableRepo.createDefinition(variable);
          results.variables.added++;
        } catch (e) {
          results.variables.errors.push({ id: variable.id, error: e.message });
        }
      }
    }

    // 导入设定
    if (data.settings) {
      for (const setting of data.settings) {
        try {
          if (skipExisting && (await this.settingRepo.get(setting.id))) {
            results.settings.skipped++;
            continue;
          }
          await this.settingRepo.create(setting);
          results.settings.added++;
        } catch (e) {
          results.settings.errors.push({ id: setting.id, error: e.message });
        }
      }
    }

    return results;
  }

  // 验证数据格式
  #validateData(data) {
    const errors = [];

    if (!data.version) errors.push("缺少 version 字段");
    if (!data.exportedAt) errors.push("缺少 exportedAt 字段");
    if (data.characters && !Array.isArray(data.characters)) errors.push("characters 必须是数组");
    if (data.conversations && !Array.isArray(data.conversations)) errors.push("conversations 必须是数组");
    if (data.variables && !Array.isArray(data.variables)) errors.push("variables 必须是数组");
    if (data.settings && !Array.isArray(data.settings)) errors.push("settings 必须是数组");

    return errors.length === 0 ? null : errors;
  }
}
