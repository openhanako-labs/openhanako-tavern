// lib/migration/export.js — 完整数据导出

import fs from "node:fs/promises";
import path from "node:path";
import { CharacterRepo } from "../characters/repo.js";
import { ConversationRepo } from "../conversations/repo.js";
import { VariableRepo } from "../variables/repo.js";
import { SettingRepo } from "../settings/repo.js";

export class MigrationExporter {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.characterRepo = new CharacterRepo(dataDir);
    this.conversationRepo = new ConversationRepo(dataDir);
    this.variableRepo = new VariableRepo(dataDir);
    this.settingRepo = new SettingRepo(dataDir);
  }

  // 导出完整数据
  async exportAll() {
    const exportData = {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      characters: [],
      conversations: [],
      variables: [],
      settings: []
    };

    // 导出角色卡
    const characters = await this.characterRepo.list();
    for (const charSummary of characters) {
      const card = await this.characterRepo.get(charSummary.id);
      if (card) exportData.characters.push(card);
    }

    // 导出对话
    const conversations = await this.conversationRepo.list();
    for (const convSummary of conversations) {
      const conv = await this.conversationRepo.get(convSummary.id);
      if (conv) exportData.conversations.push(conv);
    }

    // 导出变量
    exportData.variables = await this.variableRepo.listDefinitions();

    // 导出设定
    exportData.settings = await this.settingRepo.list();

    return exportData;
  }

  // 导出为文件
  async exportToFile(filePath) {
    const data = await this.exportAll();
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
    return {
      path: filePath,
      characters: data.characters.length,
      conversations: data.conversations.length,
      variables: data.variables.length,
      settings: data.settings.length
    };
  }
}
