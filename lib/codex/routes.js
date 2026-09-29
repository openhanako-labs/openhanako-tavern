// lib/codex/routes.js — 图鉴 HTTP 路由（C1 一期）
//
// 三张表：persons / places / factions。每张表四件：
//   GET    /codex/<table>?conversationId=…    合并两块盘
//   POST   /codex/<table>                      新建（body 里带 lifespan 决定落哪块盘）
//   PUT    /codex/<table>/:id                  更新（支持跨盘搬家）
//   DELETE /codex/<table>/:id                  删除
//
// 人物特有的追加制：
//   POST   /codex/persons/:id/notes            追加一条 notes
//
// 契约与仓库一致：route() 包装成 {ok:true,data} / {ok:false,error,code?}。

import { route, notFound } from "../respond.js";

const TABLES = ["persons", "places", "factions", "relations", "powers"];

function validTable(name) {
  return TABLES.includes(name) ? name : null;
}

export function registerCodexRoutes(app, codexRepo) {
  // ── 三张表通用的 CRUD 循环 ─────────────────────────

  for (const table of TABLES) {
    // 列：world + chat + merged。
    // 与 /board/cells 同形：前端要 merged 一张表，调试时能看出哪条落在哪块盘。
    app.get(`/codex/${table}`, route(async (c) => {
      const conversationId = c.req.query("conversationId") || null;
      const world = await codexRepo.listWorld(table);
      const chat = await codexRepo.listChat(table, conversationId);
      return { world, chat, merged: [...world, ...chat] };
    }));

    // 单条
    app.get(`/codex/${table}/:id`, route(async (c) => {
      const id = c.req.param("id");
      const conversationId = c.req.query("conversationId") || null;
      const item = await codexRepo.get(table, id, conversationId);
      if (!item) throw notFound(`Codex ${table} not found`);
      return item;
    }));

    // 新建
    app.post(`/codex/${table}`, route(async (c) => {
      const body = (await c.req.json().catch(() => ({}))) || {};
      const { conversationId, ...input } = body;
      return codexRepo.create(table, input, conversationId || null);
    }));

    // 更新
    app.put(`/codex/${table}/:id`, route(async (c) => {
      const id = c.req.param("id");
      const body = (await c.req.json().catch(() => ({}))) || {};
      const { conversationId, ...updates } = body;
      const updated = await codexRepo.update(table, id, updates, conversationId || null);
      if (!updated) throw notFound(`Codex ${table} not found`);
      return updated;
    }));

    // 删除
    app.delete(`/codex/${table}/:id`, route(async (c) => {
      const id = c.req.param("id");
      const conversationId = c.req.query("conversationId") || null;
      const removed = await codexRepo.delete(table, id, conversationId);
      if (!removed) throw notFound(`Codex ${table} not found`);
      return true;
    }));
  }

  // ── 人物特有：追加一条记录 ─────────────────────────

  // 记录是追加制——图鉴的价值在时间纵深，覆写等于失忆。
  // 只有 POST /codex/persons/:id/notes 这一条能加，别的路径都不能改 notes 数组。
  // PUT 里如果传了 notes 会被 normalize 接收，但**建议 UI 只走这条**。
  app.post("/codex/persons/:id/notes", route(async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) || {};
    const { conversationId, ...note } = body;
    const updated = await codexRepo.appendNote(id, note, conversationId || null);
    if (!updated) throw notFound("Codex person not found");
    return updated;
  }));
}
