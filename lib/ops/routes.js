// lib/ops/routes.js — 操作与结算 HTTP 路由（C2）
//
// 契约与仓库一致：{ ok:true, data } / { ok:false, error }。
//
// ops 是世界级 CRUD（不接 conversationId，一份跨对话共享）。
// pending 挂在对话上：POST 新增，DELETE 划掉，GET 列表。

import { route, notFound } from "../respond.js";

export function registerOpsRoutes(app, opsRepo) {
  // ── 待执行项（对话级）──
  // 路由顺序重要：`/ops/pending` 必须在 `/ops/:id` 之前注册，
  // 否则会被 `:id="pending"` 当单条查，回 404。

  app.get("/ops/pending", route(async (c) => {
    const conversationId = c.req.query("conversationId") || null;
    if (!conversationId) return [];
    return opsRepo.listPending(conversationId);
  }));

  app.post("/ops/pending", route(async (c) => {
    const body = (await c.req.json().catch(() => ({}))) || {};
    const { conversationId, ...input } = body;
    if (!conversationId) throw new Error("pending 需要一个 conversationId");
    if (!input.opId) throw new Error("pending 需要一个 opId");
    return opsRepo.addPending(conversationId, input);
  }));

  app.delete("/ops/pending/:id", route(async (c) => {
    const id = c.req.param("id");
    const conversationId = c.req.query("conversationId") || null;
    if (!conversationId) throw new Error("conversationId required");
    const removed = await opsRepo.removePending(conversationId, id);
    if (!removed) throw notFound("Pending not found");
    return true;
  }));

  app.post("/ops/pending/clear", route(async (c) => {
    const body = (await c.req.json().catch(() => ({}))) || {};
    const conversationId = body.conversationId || c.req.query("conversationId") || null;
    if (!conversationId) throw new Error("conversationId required");
    return { removed: await opsRepo.clearPending(conversationId) };
  }));

  // ── 操作清单 CRUD（世界级）──

  app.get("/ops", route(async () => opsRepo.listOps()));

  app.get("/ops/:id", route(async (c) => {
    const op = await opsRepo.getOp(c.req.param("id"));
    if (!op) throw notFound("Op not found");
    return op;
  }));

  app.post("/ops", route(async (c) => {
    const body = (await c.req.json().catch(() => ({}))) || {};
    return opsRepo.createOp(body);
  }));

  app.put("/ops/:id", route(async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) || {};
    const updated = await opsRepo.updateOp(id, body);
    if (!updated) throw notFound("Op not found");
    return updated;
  }));

  app.delete("/ops/:id", route(async (c) => {
    const removed = await opsRepo.deleteOp(c.req.param("id"));
    if (!removed) throw notFound("Op not found");
    return true;
  }));
}
