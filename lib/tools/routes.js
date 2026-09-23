// lib/tools/routes.js — 工具管理 HTTP 路由

import { route, notFound } from "../respond.js";
import { listGroups, getGroup, toggleGroup, getEnabledTools, isToolEnabled } from "./group.js";

export function registerToolRoutes(app, sdk) {
  // 列出工具组
  app.get("/tools/groups", route(async () => {
    return listGroups();
  }));

  // 获取工具组详情
  app.get("/tools/groups/:id", route(async (c) => {
    const group = getGroup(c.req.param("id"));
    if (!group) throw notFound("Tool group not found");
    return group;
  }));

  // 启用/禁用工具组（持久化）
  app.put("/tools/groups/:id/toggle", route(async (c) => {
    const id = c.req.param("id");
    const { enabled } = await c.req.json();
    const group = await toggleGroup(id, enabled);
    if (!group) throw notFound("Tool group not found");
    return {
      ...group,
      note: "开关已持久化；工具注册在 App 重载后生效"
    };
  }));

  // 获取所有启用的工具
  app.get("/tools/enabled", route(async () => {
    return getEnabledTools();
  }));

  // 检查工具是否启用
  app.get("/tools/:name/enabled", route(async (c) => {
    return { enabled: isToolEnabled(c.req.param("name")) };
  }));

  // 工具信息（从 sdk 获取）
  app.get("/tools/info", route(async () => {
    try {
      return sdk?.tools?.list?.() || [];
    } catch {
      return [];
    }
  }));

  // 测试工具可用性
  app.post("/tools/test", route(async (c) => {
    const { toolName } = await c.req.json();
    if (!toolName) throw new Error("toolName is required");

    const enabled = isToolEnabled(toolName);
    let exists = false;
    try {
      const tools = sdk?.tools?.list?.() || [];
      exists = tools.some(t => t.name === toolName);
    } catch { /* sdk 不支持 list 时视为不存在 */ }

    return { name: toolName, enabled, exists, available: enabled && exists };
  }));
}
