// lib/regex/routes.js — 正则规则 HTTP 路由
//
// 后台导入（开局导入）与迁移工具本身并不经过这里，
// 但「把别人的规则搬进来」常伴随 igl 命名习惯 ——
// 这里对导入字段名做宽松兼容，只标注不报错。

import { route, notFound } from "../respond.js";

function readImportItem(raw) {
  if (!raw || typeof raw !== "object") throw new Error("每条规则必须是对象");
  const item = {
    name: raw.name ?? raw.title ?? null,
    pattern: raw.pattern
      ?? raw.find_regex?.pattern ?? raw.pattern_raw ?? null,
    replacement: raw.replacement
      ?? raw.find_regex?.replacement ?? raw.replace_regex ?? null,
    placement: raw.placement ?? "prompt",
    characterIds: raw.characterIds ?? (raw.character_id ? [raw.character_id] : []),
    presetIds: raw.presetIds ?? [],
    enabled: raw.enabled ?? raw.disabled === false ? true : true
    // 注意：外部条目一律按「已启用」收，用户可在界面一键关
  };
  return item;
}

export function registerRegexRoutes(app, regexRepo) {
  if (!regexRepo) return;

  app.get("/regex-rules", route(async () => {
    return regexRepo.list();
  }));

  app.get("/regex-rules/:id", route(async (c) => {
    const r = await regexRepo.get(c.req.param("id"));
    if (!r) return notFound("regex rule", c.req.param("id"));
    return r;
  }));

  app.post("/regex-rules", route(async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return regexRepo.saveRule(body);
  }));

  app.put("/regex-rules/:id", route(async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return regexRepo.saveRule({ ...body, id: c.req.param("id") });
  }));

  app.patch("/regex-rules/:id", route(async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.enabled !== "boolean") throw new Error("需要 { enabled: boolean }");
    return regexRepo.setEnabled(c.req.param("id"), body.enabled);
  }));

  app.delete("/regex-rules/:id", route(async (c) => {
    await regexRepo.deleteRule(c.req.param("id"));
    return { ok: true };
  }));

  // 批量导入
  app.post("/regex-rules/import", route(async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const rawList = Array.isArray(body) ? body : (Array.isArray(body?.rules) ? body.rules : null);
    if (!rawList) throw new Error("需要规则数组");

    const results = [];
    for (const raw of rawList) {
      try {
        results.push({ ok: true, rule: await regexRepo.saveRule(readImportItem(raw)) });
      } catch (e) {
        results.push({ ok: false, name: raw?.name ?? null, error: e.message });
      }
    }
    return results;
  }));
}
