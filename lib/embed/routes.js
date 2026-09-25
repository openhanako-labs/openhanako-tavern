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
    const s = await status(bus(), { model });
    // typeError 是宿主 bus 的**原话**（可能带 providerId / 内部路径）。
    // 工具面留着—— Agent 要靠它诊断；HTTP 面只回它“有没有”，不回内容。
    const { typeError, ...rest } = s;
    return typeError ? { ...rest, typeError: true } : rest;
  }));

  // 真算。
  // 外面必须兜一层：embed 抛的错会一路走到宿主的 500 处理器，
  // 而那里面可能带着 provider 的地址。HTTP 面只回一句干净的话，
  // 细节留给工具面（Agent 那边拿得到，且不进任何响应体）。
  app.post("/embed", route(async (c) => {
    try {
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
    } catch (e) {
      return { error: `向量计算失败：${e?.message || e}`, dimension: null, vectors: [] };
    }
  }));
}
