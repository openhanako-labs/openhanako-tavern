// test/regression-regex-repo.mjs — 正则仓储 + 路由集成回归
//
// D2 的第二层：规则持久化与作用域过滤。

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { RegexRepo } from "../lib/regex/repo.js";
import {
  RegexScope,
  RegexSurface,
  createRegexRule,
  fromStRegexScripts,
  toStRegexScript
} from "../lib/regex/engine.js";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${e.message}`);
    failed++;
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tavern-regex-"));

async function freshRepo(name) {
  const dir = path.join(tmp, name);
  await fs.mkdir(dir, { recursive: true });
  const repo = new RegexRepo(dir);
  await repo.init();
  return repo;
}

console.log("\n正则仓储 · 增删改查\n" + "─".repeat(50));

await test("新建并读回", async () => {
  const repo = await freshRepo("crud");
  const created = await repo.create({ name: "去括号", pattern: "\\{\\{.*?\\}\\}", replacement: "" });
  assert.ok(created.id);

  const got = await repo.get(created.id);
  assert.equal(got.name, "去括号");
  assert.equal(got.scope, RegexScope.GLOBAL, "默认 global");
});

await test("列出按 order 排序", async () => {
  const repo = await freshRepo("order");
  await repo.create({ name: "后", pattern: "b", order: 200 });
  await repo.create({ name: "前", pattern: "a", order: 10 });

  const list = await repo.list();
  assert.equal(list[0].name, "前");
  assert.equal(list[1].name, "后");
});

await test("更新保留 id", async () => {
  const repo = await freshRepo("update");
  const c = await repo.create({ name: "旧", pattern: "a" });
  const u = await repo.update(c.id, { name: "新", id: "试图改id" });
  assert.equal(u.name, "新");
  assert.equal(u.id, c.id, "id 不可改");
});

await test("更新不存在的规则抛错", async () => {
  const repo = await freshRepo("update-missing");
  await assert.rejects(() => repo.update("nope", { name: "x" }));
});

await test("删除", async () => {
  const repo = await freshRepo("delete");
  const c = await repo.create({ name: "x", pattern: "a" });
  assert.equal(await repo.remove(c.id), true);
  assert.equal(await repo.get(c.id), null);
});

console.log("\n正则仓储 · 作用域过滤\n" + "─".repeat(50));

await test("listFor：global 永远命中", async () => {
  const repo = await freshRepo("scope-global");
  await repo.create({ name: "g", pattern: "a", scope: RegexScope.GLOBAL });
  const rules = await repo.listFor({ characterId: "c1" });
  assert.equal(rules.length, 1);
});

await test("listFor：character 需 id 一致", async () => {
  const repo = await freshRepo("scope-char");
  await repo.create({ name: "c", pattern: "a", scope: RegexScope.CHARACTER, scopeId: "c1" });

  assert.equal((await repo.listFor({ characterId: "c1" })).length, 1);
  assert.equal((await repo.listFor({ characterId: "c2" })).length, 0);
  assert.equal((await repo.listFor({})).length, 0, "没有 characterId 时不命中");
});

await test("listFor：preset 同理", async () => {
  const repo = await freshRepo("scope-preset");
  await repo.create({ name: "p", pattern: "a", scope: RegexScope.PRESET, scopeId: "p1" });
  assert.equal((await repo.listFor({ presetId: "p1" })).length, 1);
  assert.equal((await repo.listFor({ presetId: "p2" })).length, 0);
});

await test("listFor 排除 disabled", async () => {
  const repo = await freshRepo("scope-disabled");
  await repo.create({ name: "d", pattern: "a", disabled: true });
  assert.equal((await repo.listFor({})).length, 0);
});

console.log("\n正则仓储 · 导入\n" + "─".repeat(50));

await test("批量导入 ST scripts", async () => {
  const repo = await freshRepo("import");
  const rules = fromStRegexScripts([
    { scriptName: "a", findRegex: "/x/g", replaceString: "y" },
    { scriptName: "b", findRegex: "/z/g", replaceString: "w" }
  ], { scope: RegexScope.CHARACTER, scopeId: "c1" });

  const r = await repo.importRules(rules);
  assert.equal(r.added, 2);
  assert.equal((await repo.list()).length, 2);
});

await test("重复导入不产生副本", async () => {
  const repo = await freshRepo("import-dup");
  const rules = fromStRegexScripts([{ scriptName: "a", findRegex: "/x/g" }]);
  await repo.importRules(rules);
  const second = await repo.importRules(rules);
  assert.equal(second.added, 0, "同 id 不该重复添加");
});

await test("导出为 ST 格式", async () => {
  const repo = await freshRepo("export");
  await repo.create({ name: "n", pattern: "/a/g", replacement: "b" });
  const out = await repo.list().then(rs => rs.map(toStRegexScript));
  assert.equal(out[0].scriptName, "n");
  assert.equal(out[0].findRegex, "/a/g");
});

console.log("\n正则 · 端到端作用面\n" + "─".repeat(50));

await test("同一条规则在 Prompt 面生效、Display 面视 promptOnly 而定", async () => {
  const { applyRules } = await import("../lib/regex/engine.js");

  const r1 = createRegexRule({ pattern: "X", replacement: "Y", promptOnly: false });
  // promptOnly=false → Display 面也生效
  assert.equal(applyRules("X", [r1], { surface: RegexSurface.DISPLAY }).text, "Y");
  // Prompt 面：没标 markdownOnly → 生效
  assert.equal(applyRules("X", [r1], { surface: RegexSurface.PROMPT }).text, "Y");

  const r2 = createRegexRule({ pattern: "X", replacement: "Y", promptOnly: true });
  // promptOnly=true → Display 面不生效
  assert.equal(applyRules("X", [r2], { surface: RegexSurface.DISPLAY }).text, "X");
  assert.equal(applyRules("X", [r2], { surface: RegexSurface.PROMPT }).text, "Y");
});

await test("Stored 面需要 runOnEdit", async () => {
  const { applyRules } = await import("../lib/regex/engine.js");
  const off = createRegexRule({ pattern: "X", replacement: "Y", runOnEdit: false });
  const on = createRegexRule({ pattern: "X", replacement: "Y", runOnEdit: true });

  assert.equal(applyRules("X", [off], { surface: RegexSurface.STORED }).text, "X");
  assert.equal(applyRules("X", [on], { surface: RegexSurface.STORED }).text, "Y");
});

await test("仓储规则能直接喂给 applyRules", async () => {
  const { applyRules } = await import("../lib/regex/engine.js");
  const repo = await freshRepo("e2e");
  await repo.create({ name: "去星号", pattern: "\\*\\*(.+?)\\*\\*", replacement: "$1" });

  const rules = await repo.listFor({});
  const out = applyRules("这是**重点**内容", rules, { surface: RegexSurface.PROMPT });
  assert.equal(out.text, "这是重点内容");
});

console.log("\n正则仓储 · 作用面一致性\n" + "─".repeat(50));

// 这一组钉的是一处此前一直存在的不一致：
//   仓储存 `surfaces: ["prompt"|"display"|"stored"]`，
//   而引擎的 appliesToSurface() 读的是 ST 那三个老开关，**完全不看 surfaces**。
// 于是 surfaces 是摆设：界面写它、导入写它，真正应用规则的那段不读。
// 更阴的是 markdownOnly 以前根本不在 normalizeRule 的返回值里——存一次就丢。
// 现在 surfaces 是唯一真源，三个老开关是它的派生视图。

await test("surfaces 是唯一真源：三个老开关由它派生", async () => {
  const repo = await freshRepo("surfaces-derive");

  const p = await repo.create({ name: "只管请求", pattern: "a", surfaces: ["prompt"] });
  assert.equal(p.promptOnly, true, "不含 display → promptOnly 必须为真");
  assert.equal(p.markdownOnly, false, "含 prompt → markdownOnly 必须为假");
  assert.equal(p.runOnEdit, false);

  const b = await repo.create({ name: "两面", pattern: "b", surfaces: ["prompt", "display"] });
  assert.equal(b.promptOnly, false);
  assert.equal(b.markdownOnly, false);

  const s = await repo.create({ name: "也落盘", pattern: "c", surfaces: ["prompt", "stored"] });
  assert.equal(s.runOnEdit, true, "含 stored → runOnEdit 必须为真");
});

await test("surfaces 真的作用到引擎上（不再是摆设）", async () => {
  const { applyRules } = await import("../lib/regex/engine.js");

  const only = await freshRepo("surfaces-engine-only");
  await only.create({ name: "只管请求", pattern: "X", replacement: "Y", surfaces: ["prompt"] });
  const rules = await only.listFor({});

  assert.equal(applyRules("X", rules, { surface: RegexSurface.PROMPT }).text, "Y", "Prompt 面该生效");
  assert.equal(applyRules("X", rules, { surface: RegexSurface.DISPLAY }).text, "X",
    "surfaces 不含 display，显示面却生效了——说明 surfaces 又变回摆设了");
  assert.equal(applyRules("X", rules, { surface: RegexSurface.STORED }).text, "X");

  const both = await freshRepo("surfaces-engine-both");
  await both.create({ name: "两面", pattern: "X", replacement: "Y", surfaces: ["prompt", "display"] });
  const rules2 = await both.listFor({});
  assert.equal(applyRules("X", rules2, { surface: RegexSurface.DISPLAY }).text, "Y", "勾了显示时就该生效");
});

await test("ST 导入：老开关反推成 surfaces", async () => {
  const repo = await freshRepo("surfaces-st-import");
  const rules = fromStRegexScripts([
    { scriptName: "只提示词", findRegex: "/a/g", promptOnly: true },
    { scriptName: "也管显示", findRegex: "/b/g", promptOnly: false }
  ]);
  await repo.importRules(rules);

  const list = await repo.list();
  const p = list.find(r => r.name === "只提示词");
  const d = list.find(r => r.name === "也管显示");
  assert.deepEqual(p.surfaces, ["prompt"], `实为 ${JSON.stringify(p?.surfaces)}`);
  assert.ok(d.surfaces.includes("display"), `promptOnly=false 该反推出 display，实为 ${JSON.stringify(d?.surfaces)}`);
});

await test("markdownOnly 存一次不丢（它以前根本不在返回值里）", async () => {
  const repo = await freshRepo("markdown-only");
  const c = await repo.create({ name: "只管显示", pattern: "X", replacement: "Y", surfaces: ["display"] });
  assert.equal(c.markdownOnly, true, "不含 prompt → markdownOnly 必须为真");
  assert.equal(c.promptOnly, false);

  const got = await repo.get(c.id);
  assert.equal(got.markdownOnly, true, "存一次 markdownOnly 就丢了");
});

await test("导出回 ST 不改变性质（markdownOnly 不再写死 false）", async () => {
  const repo = await freshRepo("export-markdown");
  const c = await repo.create({ name: "只管显示", pattern: "X", replacement: "Y", surfaces: ["display"] });
  const st = toStRegexScript(c);
  assert.equal(st.markdownOnly, true);
  assert.equal(st.promptOnly, false);
});

await fs.rm(tmp, { recursive: true, force: true });

console.log("\n" + "=".repeat(50));
console.log(`通过 ${passed} / 失败 ${failed}`);
console.log("=".repeat(50));
process.exit(failed > 0 ? 1 : 0);
