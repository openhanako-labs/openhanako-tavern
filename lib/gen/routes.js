// lib/gen/routes.js — 生成器的 HTTP 面
//
// 三条路由，对应界面上的三个动作：
//   GET  /gen/sources    先体检：今天哪条来源通（不通就别白等）
//   POST /gen/jobs       提交生成（立即返回 id）
//   GET  /gen/jobs/:id   轮询进度与结果

import { route, notFound } from "../respond.js";
import { checkAvailability } from "./sources/index.js";
import { createJob, getJob, runJob, snapshot } from "./job.js";

/**
 * @param {object} app 路由 shim
 * @param {{llm: object|null, net: object|null}} deps
 */
export function registerGenRoutes(app, { llm = null, net = null } = {}) {
  app.get("/gen/sources", route(async () => {
    return { sources: await checkAvailability(net) };
  }));

  app.post("/gen/jobs", route(async (c) => {
    const body = (await c.req.json().catch(() => ({}))) || {};
    const query = String(body.query || "").trim();
    if (!query) throw new Error("query is required");

    if (!llm || typeof llm.generate !== "function") throw new Error("模型服务未就绪");

    const job = createJob({
      query,
      sources: body.sources,
      docsPerSource: Number(body.docsPerSource) || 3
    });

    // fire-and-forget：请求立刻返回 id，进度靠轮询。
    // 这里刻意不 await —— await 的话前端只能干等几十秒，
    // 而且「还在跑」和「超时挂了」会变成同一种表现。
    void runJob(job.id, { net, llm });

    return { id: job.id, state: job.state, phase: job.phase };
  }));

  app.get("/gen/jobs/:id", route(async (c) => {
    const id = c.req.param("id");
    const job = getJob(id);
    if (!job) throw notFound("任务不存在（可能已随进程重启清空）");
    return snapshot(job);
  }));
}
