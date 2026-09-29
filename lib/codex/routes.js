// lib/codex/routes.js — 图鉴 HTTP 路由（C1 一期 + C3 二期）
//
// 五张表：persons / places / factions / relations / powers。
// 每张表四件：
//   GET    /codex/<table>?conversationId=…    合并两块盘
//   GET    /codex/<table>/:id                 单条
//   POST   /codex/<table>                     新建（body 里带 lifespan 决定落哪块盘）
//   PUT    /codex/<table>/:id                 更新（支持跨盘搬家）
//   DELETE /codex/<table>/:id                 删除
//
// 人物特有的追加制：
//   POST   /codex/persons/:id/notes            追加一条 notes
//
// 契约与仓库一致：route() 包装成 {ok:true,data} / {ok:false,error,code?}。

import { route, notFound } from "../respond.js";

const TABLES = ["persons", "places", "factions", "relations", "powers"];

export function registerCodexRoutes(app, codexRepo) {
  // ⚠️ 路径必须用字符串字面量，不能 `/codex/${table}` 模板字符串：
  //    test/check-ui-api-calls.mjs 靠正则扫后端注册表（只认字面量），
  //    模板字符串里 `/codex/${table}` 会扫不到真实路径，前端调用会被报"不对齐"。
  //    为了可读，把 handler 抽出来，注册处全部字面量。

  const crudHandlers = (table) => ({
    list: route(async (c) => {
      const conversationId = c.req.query("conversationId") || null;
      const world = await codexRepo.listWorld(table);
      const chat = await codexRepo.listChat(table, conversationId);
      return { world, chat, merged: [...world, ...chat] };
    }),
    single: route(async (c) => {
      const id = c.req.param("id");
      const conversationId = c.req.query("conversationId") || null;
      const item = await codexRepo.get(table, id, conversationId);
      if (!item) throw notFound(`Codex ${table} not found`);
      return item;
    }),
    create: route(async (c) => {
      const body = (await c.req.json().catch(() => ({}))) || {};
      const { conversationId, ...input } = body;
      return codexRepo.create(table, input, conversationId || null);
    }),
    update: route(async (c) => {
      const id = c.req.param("id");
      const body = (await c.req.json().catch(() => ({}))) || {};
      const { conversationId, ...updates } = body;
      const updated = await codexRepo.update(table, id, updates, conversationId || null);
      if (!updated) throw notFound(`Codex ${table} not found`);
      return updated;
    }),
    remove: route(async (c) => {
      const id = c.req.param("id");
      const conversationId = c.req.query("conversationId") || null;
      const removed = await codexRepo.delete(table, id, conversationId);
      if (!removed) throw notFound(`Codex ${table} not found`);
      return true;
    })
  });

  // ── 五张表 CRUD：逐一字面量注册 ────────────────────
  {
    const h = crudHandlers("persons");
    app.get("/codex/persons", h.list);
    app.get("/codex/persons/:id", h.single);
    app.post("/codex/persons", h.create);
    app.put("/codex/persons/:id", h.update);
    app.delete("/codex/persons/:id", h.remove);
  }
  {
    const h = crudHandlers("places");
    app.get("/codex/places", h.list);
    app.get("/codex/places/:id", h.single);
    app.post("/codex/places", h.create);
    app.put("/codex/places/:id", h.update);
    app.delete("/codex/places/:id", h.remove);
  }
  {
    const h = crudHandlers("factions");
    app.get("/codex/factions", h.list);
    app.get("/codex/factions/:id", h.single);
    app.post("/codex/factions", h.create);
    app.put("/codex/factions/:id", h.update);
    app.delete("/codex/factions/:id", h.remove);
  }
  {
    const h = crudHandlers("relations");
    app.get("/codex/relations", h.list);
    app.get("/codex/relations/:id", h.single);
    app.post("/codex/relations", h.create);
    app.put("/codex/relations/:id", h.update);
    app.delete("/codex/relations/:id", h.remove);
  }
  {
    const h = crudHandlers("powers");
    app.get("/codex/powers", h.list);
    app.get("/codex/powers/:id", h.single);
    app.post("/codex/powers", h.create);
    app.put("/codex/powers/:id", h.update);
    app.delete("/codex/powers/:id", h.remove);
  }

  // ── 人物特有：追加一条记录 ─────────────────────────
  //
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
