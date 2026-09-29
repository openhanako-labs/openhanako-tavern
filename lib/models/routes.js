// lib/models/routes.js — 模型按用途分选的 HTTP 面
//
// 三条路，各自只做一件事：
//   GET /models           有哪些 chat 模型可选（给设置面板画下拉）
//   GET /models/config    当前配置（含每用途当前生效的目标）
//   PUT /models/config    改配置（缺字段 = 不改，显式 null = 清空）
//
// 为什么不把「模型列表」和「配置」塞进一个端点：
//   模型目录有 60 秒缓存（llm/service.js CATALOG_TTL_MS），配置几乎不动。
//   两个节奏不同的东西分开走，前端可以各自按需拉。
//
// 模型目录过滤：用 `pickChatTargets`。宿主目录里第一项常常是 BAAI/bge-m3
// （embedding），盲选会让生成失败——service 那侧早已踩过，这里也一样。

import { route } from "../respond.js";
import { readConfig, writeConfig, mergeConfig, publicConfig } from "./config.js";
import { pickChatTargets } from "../llm/service.js";

export function registerModelRoutes(app, { llmService = null, dataDir = null } = {}) {
  app.get("/models", route(async () => {
    if (!llmService) {
      // 宿主没起模型能力：如实回空数组，UI 自己显示"未就绪"
      return { available: false, targets: [] };
    }
    try {
      const catalog = await llmService.listModels();
      const targets = pickChatTargets(catalog);
      return {
        available: true,
        // 把 provider + model 打包回前端：前端不拼字符串，直接把整份发回 PUT
        targets: targets.map(t => ({ provider: t.provider, model: t.model, info: t.info || null })),
        total: catalog?.length || 0
      };
    } catch (e) {
      return { available: false, targets: [], error: e?.message || String(e) };
    }
  }));

  app.get("/models/config", route(async () => {
    if (!dataDir) {
      throw new Error("模型配置未就绪（数据目录不可用）");
    }
    return publicConfig(await readConfig(dataDir));
  }));

  app.put("/models/config", route(async (c) => {
    if (!dataDir) {
      throw new Error("模型配置未就绪（数据目录不可用）");
    }
    const patch = (await c.req.json().catch(() => ({}))) || {};
    const prev = await readConfig(dataDir);
    const next = mergeConfig(prev, patch);
    await writeConfig(dataDir, next);
    return publicConfig(next);
  }));
}
