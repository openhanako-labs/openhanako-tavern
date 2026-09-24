// lib/board/routes.js — 黑板 HTTP 路由

import { route, notFound } from "../respond.js";
import { cellApplies } from "./model.js";

export function registerBoardRoutes(app, boardRepo) {
  // 列出格子：world / chat / merged 三份一起给。
  // （前端"世界"页要 merged 排序后的全表；调试时要能看出哪一格落在哪块盘。）
  app.get("/board/cells", route(async (c) => {
    const conversationId = c.req.query("conversationId") || null;
    const world = await boardRepo.listWorldCells();
    const chat = conversationId ? await boardRepo.listChatCells(conversationId) : [];
    return { world, chat, merged: [...world, ...chat] };
  }));

  // 这一轮该上场的格子——按观察者过滤。
  //
  // 这是引擎的"裁决面"：管道想问"这条该不该进上下文"，问这里。
  // 带上 characterId 就是那个角色的视角；不带就是用户自己的视角。
  app.get("/board/visible", route(async (c) => {
    const conversationId = c.req.query("conversationId") || null;
    const characterId = c.req.query("characterId") || null;
    const text = c.req.query("text") || "";
    const viewer = characterId ? { characterId } : {};

    const cells = await boardRepo.listCells(conversationId);
    return cells
      .filter(cell => cellApplies(cell, { text, viewer }))
      .map(cell => ({ id: cell.id, title: cell.title, lifespan: cell.lifespan, visible: cell.visible }));
  }));

  // 新建一格
  app.post("/board/cells", route(async (c) => {
    const body = (await c.req.json()) || {};
    const { conversationId, ...cellInput } = body;
    return boardRepo.createCell(cellInput, conversationId || null);
  }));

  // 改一格
  app.put("/board/cells/:id", route(async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json()) || {};
    const { conversationId, ...updates } = body;
    const updated = await boardRepo.updateCell(id, updates, conversationId || null);
    if (!updated) throw notFound("Board cell not found");
    return updated;
  }));

  // 开关一格（不传 enabled 就取反）
  app.put("/board/cells/:id/toggle", route(async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) || {};
    const updated = await boardRepo.toggleCell(id, body.enabled, body.conversationId || null);
    if (!updated) throw notFound("Board cell not found");
    return updated;
  }));

  // 删一格
  app.delete("/board/cells/:id", route(async (c) => {
    const conversationId = c.req.query("conversationId") || null;
    const removed = await boardRepo.deleteCell(c.req.param("id"), conversationId);
    if (!removed) throw notFound("Board cell not found");
    return true;
  }));
}
