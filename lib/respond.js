// lib/respond.js — 统一响应契约
//
// 解决的问题：
//   1. 每个 handler 都手写 try/catch + c.json({ok,data}) —— 30 处重复样板
//   2. 前端要猜 5 种响应形状（res / res.data / res.exports / res.items / res.results）
//
// 契约（全 App 唯一）：
//   成功: { ok: true,  data: <any> }
//   失败: { ok: false, error: "<人话>", code?: "<机器码>" }
//
// 用法：
//   app.get("/characters", route(async () => repo.list()));
//   app.post("/characters", route(async (c) => repo.create(await c.req.json())));
//   app.get("/raw", route(async () => raw(bytes, { contentType: "image/png" })));
//
// handler 只需返回数据（或抛错）。返回 raw(...) 表示绕过 JSON 包装（用于图片等）。

const RAW = Symbol("respond.raw");

/**
 * 标记一个原始响应（绕过 {ok,data} 包装）。用于返回二进制 / SSE / 自定义 header。
 * @param {Response|string|Uint8Array} body
 * @param {{status?: number, contentType?: string, headers?: Record<string,string>}} [opts]
 */
export function raw(body, opts = {}) {
  return { [RAW]: true, body, opts };
}

/**
 * 把业务 handler 包装成 Hono handler：自动 try/catch + 统一响应形状。
 *
 * @param {(c: any) => Promise<any>} fn - 业务函数，返回数据即成功，抛错即失败
 * @param {{ errorStatus?: number }} [opts]
 */
export function route(fn, opts = {}) {
  const { errorStatus = 400 } = opts;

  return async (c) => {
    try {
      const result = await fn(c);

      // 原始响应（图片 / SSE / 自定义）
      if (result && typeof result === "object" && result[RAW]) {
        const { body, opts: o = {} } = result;
        if (body instanceof Response) return body;
        const headers = { ...(o.headers || {}) };
        if (o.contentType) headers["Content-Type"] = o.contentType;
        return c.body(body, o.status ?? 200, headers);
      }

      // 约定：handler 可返回 { __status, ... } 指定状态码
      if (result && typeof result === "object" && typeof result.__status === "number") {
        const { __status, ...rest } = result;
        return c.json({ ok: true, data: rest }, __status);
      }

      return c.json({ ok: true, data: result ?? null });
    } catch (e) {
      const message = e?.message || String(e);
      const code = e?.code;
      // 404 语义：显式标记 notFound 的错误
      const status = e?.notFound ? 404 : (e?.status || errorStatus);
      const payload = { ok: false, error: message };
      if (code) payload.code = code;
      return c.json(payload, status);
    }
  };
}

/** 抛出一个 404 错误（route 会映射成 404 状态码）。 */
export function notFound(message = "Not found") {
  const e = new Error(message);
  e.notFound = true;
  return e;
}

/** 抛出一个指定状态码的错误。 */
export function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}
