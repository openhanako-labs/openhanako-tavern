// lib/embed/routes.js — embedding 的 HTTP 面（App 内部用）
//
// 和工具的区别：工具给我（Agent）调，路由给界面/引擎调。
// 两条路共用同一个 service，所以纪律只有一份。
//
// 返回里**绝不含凭据**。

import { route } from "../respond.js";
import { embed, status } from "./service.js";

export function registerEmbedRoutes(app, sdk) {
  const bus = () => sdk?.bus;

  // 能不能用——只查不动手
  app.get("/embed/status", route(async (c) => {
    const model = c.req.query("model") || null;
    return status(bus(), { model });
  }));

  // 真算
  app.post("/embed", route(async (c) => {
    const body = (await c.req.json()) || {};
    const texts = Array.isArray(body.texts)
      ? body.texts
      : (typeof body.text === "string" ? [body.text] : []);
    if (texts.length === 0) {
      return { error: "texts 为空", dimension: null, vectors: [] };
    }
    const r = await embed(bus(), texts, { model: body.model || null });
    return {
      providerId: r.providerId,
      model: r.model,
      dimension: r.dimension,
      count: r.vectors.length,
      vectors: r.vectors
    };
  }));
}
