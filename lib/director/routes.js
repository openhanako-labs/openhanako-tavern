// lib/director/routes.js — 导演实体的 HTTP 路由
//
// 统一用 route() 包装（同 settings / board）：业务函数只写逻辑。
//
// 一个约定：保存时**校验不过就抛**，并把问题清单挂在错误上。
// 规则写错的后果不是崩，是那条规则从此静默失效——剧情照走，只是永远不按
// 作者想的走。这种错必须挡在保存那一步，不能等到读者看不见的地方。

import { route, notFound } from "../respond.js";
import { createDirectorEntity, initialDirectorState, normalizeDirectorState, validateDirectorEntity } from "./model.js";
import { settle, describeState } from "./engine.js";
import { renderDirectorBlock } from "./prompt.js";
import { parseDirectorReport } from "./report.js";

export function registerDirectorRoutes(app, directorRepo) {
  // 列全部配方
  app.get("/directors", route(async () => {
    return directorRepo.list();
  }));

  app.get("/directors/:id", route(async (c) => {
    const one = await directorRepo.get(c.req.param("id"));
    if (!one) throw notFound("配方不存在");
    return one;
  }));

  app.post("/directors", route(async (c) => {
    return directorRepo.create(await c.req.json());
  }));

  /*
   * 校验一份草稿。**不落地、不需要 id**——新建时还没有 id，
   * 而「写的时候不知道对不对」恰恰是新建时最容易发生的事。
   *
   * 它回答三件事：名字对不对（引用）、语法认不认（结构）、
   * 按这一场现在的进度会往模型面前摆什么（语义）。
   *
   * 第三条才是最要紧的：结构全对但语义错了（比如两条阈值互相挡着、
   * 高的那条永远轮不到），只看 problems 是看不出来的——
   * 所以校验通过时连注入块一起给出来，让作者自己看一眼。
   */
  app.post("/directors/validate", route(async (c) => {
    const body = (await c.req.json()) || {};
    const entity = createDirectorEntity({
      state: body.state && typeof body.state === "object" ? body.state : {},
      rules: Array.isArray(body.rules) ? body.rules : [],
      freeform: typeof body.freeform === "string" ? body.freeform : "",
      enabled: body.enabled !== false
    });

    const problems = validateDirectorEntity(entity);
    const state = normalizeDirectorState(
      entity,
      body.previewState && typeof body.previewState === "object"
        ? body.previewState
        : initialDirectorState(entity)
    );

    return {
      ok: problems.length === 0,
      problems,
      state,
      ruleCount: entity.rules.length,
      briefCount: entity.rules.filter(r => String(r?.brief || "").trim()).length,
      summary: describeState(entity, state),
      // 结构没对就不渲染注入块：给一份跑不起来的样例比不给更误导人
      block: problems.length === 0 ? renderDirectorBlock(entity, state) : ""
    };
  }));

  app.put("/directors/:id", route(async (c) => {
    return directorRepo.update(c.req.param("id"), await c.req.json());
  }));

  app.delete("/directors/:id", route(async (c) => {
    const gone = await directorRepo.remove(c.req.param("id"));
    if (!gone) throw notFound("配方不存在");
    return true;
  }));

  /*
   * 试算：不落盘、不碰对话，只回答一个问题——
   * 「按现在这份配方，这一轮会怎么走」。
   *
   * 没有它，作者改完规则只能开一场真对话去试，而真对话会写状态、会花 token；
   * 试错的代价高到没人愿意试，规则就只能靠猜。
   */
  app.post("/directors/:id/simulate", route(async (c) => {
    const one = await directorRepo.get(c.req.param("id"));
    if (!one) throw notFound("配方不存在");

    const body = (await c.req.json()) || {};
    const state = normalizeDirectorState(
      one,
      body.state && typeof body.state === "object" ? body.state : initialDirectorState(one)
    );

    const parsed = parseDirectorReport(String(body.text ?? ""));
    const result = settle(one, state, parsed.reports);

    return {
      state,
      next: result.state,
      changes: result.changes,
      rejected: result.rejected,
      badTokens: parsed.bad,
      summary: describeState(one, state),
      block: renderDirectorBlock(one, state)
    };
  }));
}
