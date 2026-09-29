// lib/memory/routes.js — 记忆面板的 HTTP 面
//
// 两条路，各自只做一件事：
//   GET /memory/config    当前配置 + 默认值 + 上下限
//   PUT /memory/config    改配置（缺字段 = 不改；summaryPrompt 空串 = 回默认模板）
//
// 为什么不塞进 /settings：settings 里是世界书条目，语义不同。
// 与 lib/models/routes.js 同层、同样的响应契约（{ ok:true,data } / { ok:false,error }）。

import { route } from "../respond.js";
import { readConfig, writeConfig, mergeConfig, publicConfig } from "./config.js";

export function registerMemoryRoutes(app, { dataDir = null } = {}) {
  app.get("/memory/config", route(async () => {
    if (!dataDir) {
      throw new Error("记忆配置未就绪（数据目录不可用）");
    }
    return publicConfig(await readConfig(dataDir));
  }));

  app.put("/memory/config", route(async (c) => {
    if (!dataDir) {
      throw new Error("记忆配置未就绪（数据目录不可用）");
    }
    const patch = (await c.req.json().catch(() => ({}))) || {};
    const prev = await readConfig(dataDir);
    const next = mergeConfig(prev, patch);
    await writeConfig(dataDir, next);
    return publicConfig(next);
  }));
}
