// lib/presets/routes.js — 提示词预设 HTTP 路由

import { route, notFound } from "../respond.js";
import { composeFromPreset, resolveBlockText, orderedBlocks } from "./model.js";

export function registerPresetRoutes(app, presetRepo) {
  // 列出预设
  app.get("/presets", route(async () => {
    return presetRepo.list();
  }));

  /**
   * 导入。
   *
   * ⚠ 必须注册在 /presets/:id 之前——否则 "import" 会被当成 id 吃掉。
   * 静态段优先于参数段，这条顺序是硬约束。
   */
  app.post("/presets/import", route(async (c) => {
    const body = await c.req.json();
    const list = Array.isArray(body) ? body : body?.presets;
    if (!Array.isArray(list)) throw new Error("presets array is required");
    return presetRepo.importPresets(list);
  }));

  // 获取单个
  app.get("/presets/:id", route(async (c) => {
    const p = await presetRepo.get(c.req.param("id"));
    if (!p) throw notFound("Preset not found");
    return p;
  }));

  // 创建
  app.post("/presets", route(async (c) => {
    return presetRepo.create(await c.req.json());
  }));

  // 更新
  app.put("/presets/:id", route(async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    return presetRepo.update(id, body);
  }));

  // 删除（内置的会被 repo 拒绝）
  app.delete("/presets/:id", route(async (c) => {
    await presetRepo.delete(c.req.param("id"));
    return true;
  }));

  // 复制
  app.post("/presets/:id/duplicate", route(async (c) => {
    return presetRepo.duplicate(c.req.param("id"));
  }));

  /**
   * 预览：给定角色卡与上下文，看这套预设会组装出什么。
   *
   * 这是「预设为什么长这样」的可复核手段——不预览，用户只能靠猜。
   */
  app.post("/presets/:id/preview", route(async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));

    const preset = await presetRepo.get(id);
    if (!preset) throw notFound("Preset not found");

    const result = composeFromPreset(preset, {
      character: body.character || null,
      mainPrompt: body.mainPrompt || "",
      loreText: body.loreText || "",
      persona: body.persona || "",
      authorNote: body.authorNote || ""
    });

    // 逐块明细：让用户看到「哪块进了、哪块被跳过、为什么」
    const detail = orderedBlocks(preset).map(b => {
      const text = resolveBlockText(b, {
        character: body.character || null,
        mainPrompt: body.mainPrompt || "",
        loreText: body.loreText || "",
        persona: body.persona || "",
        authorNote: body.authorNote || ""
      });
      return {
        id: b.id,
        source: b.source,
        position: b.position || "system",
        enabled: b.enabled !== false,
        order: b.order ?? 0,
        chars: String(text || "").length,
        skipped: b.enabled === false || !String(text || "").trim()
      };
    });

    return {
      systemPrompt: result.systemPrompt,
      inChatBlocks: result.inChatBlocks,
      used: result.used,
      detail
    };
  }));
}
