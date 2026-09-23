// lib/settings/routes.js — 设定库 HTTP 路由
//
// 统一用 route() 包装：业务函数只写逻辑，响应形状与错误处理由框架统一。

import { route, notFound } from "../respond.js";
import { getActiveSettings, injectSettings, shouldTrigger } from "./model.js";
import { stWorldBookToSettings, characterBookToSettings } from "./import.js";

export function registerSettingRoutes(app, settingRepo, conversationRepo) {
  // 列出所有设定。
  //   ?characterId=xxx → 该角色条目 + 全局条目（UI 分级展示用）
  //   ?scope=global    → 只看全局条目
  app.get("/settings", route(async (c) => {
    const characterId = (c.req.query("characterId") || "").trim();
    const scope = (c.req.query("scope") || "").trim();

    if (scope === "global") {
      const all = await settingRepo.list();
      return all.filter(s => !s.characterId);
    }
    if (characterId) {
      return settingRepo.listForCharacter(characterId);
    }
    return settingRepo.list();
  }));

  // 获取设定详情
  app.get("/settings/:id", route(async (c) => {
    const setting = await settingRepo.get(c.req.param("id"));
    if (!setting) throw notFound("Setting not found");
    return setting;
  }));

  // 创建设定
  app.post("/settings", route(async (c) => {
    return settingRepo.create(await c.req.json());
  }));

  // 更新设定
  app.put("/settings/:id", route(async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    return settingRepo.update(id, body);
  }));

  // 删除设定
  app.delete("/settings/:id", route(async (c) => {
    await settingRepo.delete(c.req.param("id"));
    return true;
  }));

  // 启用/禁用设定
  app.put("/settings/:id/toggle", route(async (c) => {
    const id = c.req.param("id");
    const { enabled } = await c.req.json();
    return settingRepo.toggle(id, enabled);
  }));

  // 批量导入设定
  app.post("/settings/import", route(async (c) => {
    const { settings } = await c.req.json();
    if (!Array.isArray(settings)) {
      throw new Error("settings array is required");
    }
    return settingRepo.importSettings(settings);
  }));

  // 获取活跃设定（基于上下文）
  app.post("/settings/active", route(async (c) => {
    const { text, variables, characterId, characterName, characterTags } = await c.req.json();
    const context = { text: text || "" };
    return settingRepo.getActive(context, variables, characterId
      ? { characterId, characterName, characterTags }
      : null);
  }));

  // 测试设定触发
  app.post("/settings/test", route(async (c) => {
    const { text, variables, settingId } = await c.req.json();
    const context = { text: text || "" };

    if (settingId) {
      const setting = await settingRepo.get(settingId);
      if (!setting) throw notFound("Setting not found");
      return { triggered: shouldTrigger(setting, context) };
    }

    const all = await settingRepo.list();
    const active = getActiveSettings(all, context, variables);
    return { active: active.map(s => ({ id: s.id, name: s.name })) };
  }));

  // 注入设定到系统提示
  app.post("/settings/inject", route(async (c) => {
    const { systemPrompt, text, variables } = await c.req.json();
    const context = { text: text || "" };
    const active = await settingRepo.getActive(context, variables);
    return {
      result: injectSettings(systemPrompt || "", active),
      activeCount: active.length
    };
  }));

  // 导入 SillyTavern 世界书
  app.post("/settings/import-st", route(async (c) => {
    const { worldBook } = await c.req.json();

    const settings = stWorldBookToSettings(worldBook, { source: "sillytavern" });
    if (settings.length === 0) {
      throw new Error("No importable entries found in world book");
    }

    const result = await settingRepo.importSettings(settings);
    return { ...result, format: "sillytavern", total: settings.length };
  }));

  // 导入角色卡内嵌的 character_book（ST 卡的设定就存在这里）
  app.post("/settings/import-character-book", route(async (c) => {
    const { characterBook, characterId, replace = false } = await c.req.json();

    const settings = characterBookToSettings(characterBook, { source: "character_book" });
    if (settings.length === 0) {
      return { added: 0, skipped: [], removed: 0, total: 0, note: "该角色卡未内嵌世界书" };
    }

    // 有角色归属时走 importCharacterBook：先清旧再导，重复导入不堆重复条目。
    if (characterId && replace) {
      const result = await settingRepo.importCharacterBook(characterId, settings);
      return { ...result, format: "character_book", total: settings.length };
    }

    if (characterId) {
      for (const s of settings) s.characterId = characterId;
    }

    const result = await settingRepo.importSettings(settings);
    return { ...result, removed: 0, format: "character_book", total: settings.length };
  }));
}
