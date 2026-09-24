// lib/regex/routes.js — 正则规则 HTTP 路由
//
// 后台导入（开局导入）与迁移工具本身并不经过这里，
// 但「把别人的规则搬进来」常伴随 igl 命名习惯 ——
// 这里对导入字段名做宽松兼容，只标注不报错。

import { route, notFound } from "../respond.js";
import { normalizeRule } from "./repo.js";

function readImportItem(raw) {
  if (!raw || typeof raw !== "object") throw new Error("每条规则必须是对象");
  const item = {
    // ST 导出的 regex_scripts 用的是 scriptName / findRegex / replaceString，
    // 以前这条链只认 find_regex.pattern、不认 findRegex —— 而 findRegex
    // 才是 ST 的正牌字段名，也就是「别人的规则」最常见的那个形状。
    // 「宽松兼容」得先认牌，再认变体。
    name: raw.name ?? raw.title ?? raw.scriptName ?? null,
    pattern: raw.pattern
      ?? raw.find_regex?.pattern ?? raw.pattern_raw
      ?? raw.findRegex
      ?? null,
    replacement: raw.replacement
      ?? raw.find_regex?.replacement ?? raw.replace_regex
      ?? raw.replaceString
      ?? null,
    placement: raw.placement ?? "prompt",
    characterIds: raw.characterIds ?? (raw.character_id ? [raw.character_id] : []),
    presetIds: raw.presetIds ?? [],
    // 三个作用面开关原样透传：不给的话（均为 undefined）仓储侧会落到
    // 缺省的「只作用于发请求前」，把一条管显示面的规则改成只管请求。
    promptOnly: raw.promptOnly,
    markdownOnly: raw.markdownOnly,
    runOnEdit: raw.runOnEdit,
    surfaces: raw.surfaces,
    enabled: raw.enabled ?? raw.disabled === false ? true : true
    // 注意：外部条目一律按「已启用」收，用户可在界面一键关
  };
  // 全是 undefined 时剔除，让仓储侧看到的是「没给」而不是「给了 undefined」
  for (const k of ["promptOnly", "markdownOnly", "runOnEdit", "surfaces"]) {
    if (item[k] === undefined) delete item[k];
  }
  return item;
}

export function registerRegexRoutes(app, regexRepo) {
  if (!regexRepo) return;

  app.get("/regex-rules", route(async () => {
    return regexRepo.list();
  }));

  app.get("/regex-rules/:id", route(async (c) => {
    const id = c.req.param("id");
    const r = await regexRepo.get(id);
    // 必须是 throw，不能是 return。notFound() 返回的是一个 Error 对象，
    // return 出去会被 route() 当成「成功的返回值」包成 {ok:true,data:{}}，
    // 于是查一条不存在的规则得到的是 **200**——前端只看得到「数据是空的」，
    // 无从区分「没有这条」与「有这条但字段全空」。
    if (!r) throw notFound(`规则不存在: ${id}`);
    return r;
  }));

  // ── 试跑 ──
  //
  // 规则是「对文本做的替换」，写错的代价是角色说出不属于自己的话——
  // 而那种错**没人会立刻发现**（仓储注释里就是这么写的）。
  // 所以这一页必须能当场看效果，不能只让人对着正则发呆。
  //
  // 三种入参：
  //   { rule: {...} }  → 试一条**未保存的草稿**（编辑器里「试一下」走这条）
  //   { id }           → 试一条已存的
  //   {}               → 按当前上下文（characterId / presetId）试全部
  //
  // 一个坦白：这里**不看 disabled**。试跑问的是「这条会对文本做什么」，
  // 不是「它现在生效吗」；一条关着的规则恰恰最需要先看清楚再打开。
  app.post("/regex-rules/test", route(async (c) => {
    const body = (await c.req.json().catch(() => ({}))) || {};
    const text = String(body.text ?? "");
    if (!text) throw new Error("需要 { text }：得有一段文本才知道规则做了什么");

    const characterId = body.characterId || null;
    const presetId = body.presetId || null;
    const surface = body.surface || "prompt";

    let rules;
    if (body.rule && typeof body.rule === "object") {
      rules = [normalizeRule(body.rule, null)];
    } else if (body.id) {
      const r = await regexRepo.get(body.id);
      if (!r) throw notFound(`规则不存在: ${body.id}`);
      rules = [r];
    } else {
      rules = await regexRepo.listFor({ characterId, presetId });
    }

    const { applyRules } = await import("./engine.js");
    const res = applyRules(text, rules, { surface, characterId, presetId });

    return {
      before: text,
      after: res.text,
      changed: res.text !== text,
      applied: res.applied,
      failed: res.failed,
      // applied 为空时，光看「没变化」是查不出来的：可能是没命中，
      // 也可能是 scope / surface 把它排掉了。把分歧点直接说出来。
      hint: res.applied.length === 0
        ? "没有命中：要么 pattern 没匹配上，要么 scope / 作用面把这条排除了"
        : null
    };
  }));

  // ⚠️ 下面这三条曾调 `regexRepo.saveRule(...)`——仓储里**根本没有这个方法**
  //（它有 create / update / importRules / setEnabled / deleteRule）。
  // 于是创建与修改正则的 API 从来没能工作过，一路报
  // 「saveRule is not a function」；而没有界面，所以从没人碰到过。
  //
  // 教训：静态检查看得见路由的**路径**（check-route-order），
  // 看不见它调的方法名存不存在——那一类只有真跑才能发现。
  app.post("/regex-rules", route(async (c) => {
    const body = (await c.req.json().catch(() => ({}))) || {};
    // create 拒绝显式 id（id 由仓储生成），把外面带的 id 剔掉
    const { id: _ignored, ...rest } = body;
    return regexRepo.create(rest);
  }));

  app.put("/regex-rules/:id", route(async (c) => {
    const id = c.req.param("id");
    if (!(await regexRepo.get(id))) throw notFound(`规则不存在: ${id}`);
    const body = (await c.req.json().catch(() => ({}))) || {};
    return regexRepo.update(id, body);
  }));

  app.patch("/regex-rules/:id", route(async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) || {};
    if (typeof body.enabled !== "boolean") throw new Error("需要 { enabled: boolean }");
    if (!(await regexRepo.get(id))) throw notFound(`规则不存在: ${id}`);
    return regexRepo.setEnabled(id, body.enabled);
  }));

  app.delete("/regex-rules/:id", route(async (c) => {
    const id = c.req.param("id");
    if (!(await regexRepo.get(id))) throw notFound(`规则不存在: ${id}`);
    await regexRepo.deleteRule(id);
    return true;
  }));

  // 批量导入
  //
  // 逐条**新建**。仓储里另有一条 importRules 能按 id 去重，
  // 但外部条目根本没有 id（id 要在这里生成），所以重复导入会产生副本——
  // 这是这条路的已知代价：它本来是「把别人的规则搬过来一次」用的。
  app.post("/regex-rules/import", route(async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const rawList = Array.isArray(body) ? body : (Array.isArray(body?.rules) ? body.rules : null);
    if (!rawList) throw new Error("需要规则数组");

    const results = [];
    for (const raw of rawList) {
      try {
        results.push({ ok: true, rule: await regexRepo.create(readImportItem(raw)) });
      } catch (e) {
        results.push({ ok: false, name: raw?.name ?? null, error: e.message });
      }
    }
    return results;
  }));
}
