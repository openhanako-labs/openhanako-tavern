// lib/simulation/routes.js — 模拟经营 HTTP 面（第 9 期）
//
//   GET  /simulation                —— 当前农场（先惰性 tick 结算）
//   POST /simulation/plant          —— 种下/上架 {cell, kind, item, stock?}
//   POST /simulation/harvest        —— 收获 {cell}（产出写进对话变量）
//   POST /simulation/clear          —— 摘除 {cell}
//
// 农场挂对话上（conv.simulation）——经营是这一场世界里的产业，不是全局的。
// 环境数据从黑板/对话状态取（天气/时段），影响 tick 速率。

import { route } from "../respond.js";
import { ensureFarm, tick, plant, harvest, clearCell } from "./core.js";

export function registerSimulationRoutes(app, { conversationRepo = null } = {}) {
  const needRepo = () => {
    if (!conversationRepo) throw new Error("对话仓储未就绪");
    return conversationRepo;
  };

  /** 取对话 + 惰性 tick（环境数据从 conv.status 或黑板摘要取，缺省空）。 */
  async function loadFarmed(convId) {
    const repo = needRepo();
    const conv = await repo.get(convId);
    if (!conv) throw new Error("对话不存在");
    const farm = ensureFarm(conv);
    const env = conv.environmentData || {};
    const events = tick(farm, env);
    if (events.length > 0) await repo.update(convId, { simulation: conv.simulation });
    return { conv, farm, events };
  }

  app.get("/conversations/:id/simulation", route(async (c) => {
    const { farm, events } = await loadFarmed(c.req.param("id"));
    return { farm, events };
  }));

  app.post("/conversations/:id/simulation/plant", route(async (c) => {
    const convId = c.req.param("id");
    const { farm, events } = await loadFarmed(convId);
    const body = await c.req.json().catch(() => ({})) || {};
    const slot = plant(farm, Number(body.cell), body);
    await needRepo().update(convId, { simulation: conv2farm(farm) });
    return { slot, events };
  }));

  app.post("/conversations/:id/simulation/harvest", route(async (c) => {
    const convId = c.req.param("id");
    const { conv, farm, events } = await loadFarmed(convId);
    const body = await c.req.json().catch(() => ({})) || {};
    const r = harvest(farm, Number(body.cell));
    // 产量进对话变量（var-diff 账自然出）
    const vars = { ...(conv.variables || {}) };
    vars[r.item] = (Number(vars[r.item]) || 0) + r["yield"];
    await needRepo().update(convId, { simulation: conv2farm(farm), variables: vars });
    return { ...r, events };
  }));

  app.post("/conversations/:id/simulation/clear", route(async (c) => {
    const convId = c.req.param("id");
    const { farm, events } = await loadFarmed(convId);
    const body = await c.req.json().catch(() => ({})) || {};
    const removed = clearCell(farm, Number(body.cell));
    await needRepo().update(convId, { simulation: conv2farm(farm) });
    return { removed, events };
  }));
}

function conv2farm(farm) { return farm; }

export default { registerSimulationRoutes };
