// test/regression-presets.mjs — 提示词预设：块组装 / 排序 / 开关 / 求值
//
// 这组测试锁住「拼接顺序数据化」这件事：
// 过去顺序写死在 composeSystemPrompt 里，用户改不了；
// 现在由预设的块顺序决定。

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const M = await import("../lib/presets/model.js");
const { PresetRepo } = await import("../lib/presets/repo.js");

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 预设回归 ===\n");

// ── 1. 模型层 ──
ok("默认预设含内置标记与基础块", () => {
  const p = M.createDefaultPreset();
  assert.strictEqual(p.builtin, true);
  assert.ok(p.blocks.length >= 5);
  assert.ok(p.blocks.some(b => b.source === M.BlockSource.DESCRIPTION));
});

ok("validatePreset 拒绝缺 name", () => {
  const errs = M.validatePreset({ name: "", blocks: [] });
  assert.ok(errs.some(e => /name/.test(e)));
});

ok("validatePreset 拒绝非法 source", () => {
  const errs = M.validatePreset({ name: "x", blocks: [{ source: "不存在" }] });
  assert.ok(errs.some(e => /source/.test(e)));
});

ok("validatePreset 拒绝非法 position", () => {
  const errs = M.validatePreset({ name: "x", blocks: [{ source: "main", position: "哪里" }] });
  assert.ok(errs.some(e => /position/.test(e)));
});

ok("validatePreset 拒绝 literal 块缺 content", () => {
  const errs = M.validatePreset({ name: "x", blocks: [{ source: "literal" }] });
  assert.ok(errs.some(e => /literal/.test(e)));
});

ok("validatePreset 拒绝越界 temperature", () => {
  const errs = M.validatePreset({ name: "x", blocks: [], sampling: { temperature: 9 } });
  assert.ok(errs.some(e => /temperature/.test(e)));
});

ok("validatePreset 通过合法预设", () => {
  assert.deepStrictEqual(M.validatePreset(M.createDefaultPreset()), []);
});

// ── 2. 排序 ──
ok("orderedBlocks 按 order 升序", () => {
  const p = { blocks: [
    { id: "c", source: "main", order: 30 },
    { id: "a", source: "main", order: 10 },
    { id: "b", source: "main", order: 20 }
  ]};
  assert.deepStrictEqual(M.orderedBlocks(p).map(b => b.id), ["a", "b", "c"]);
});

ok("order 相同时保持原顺序（稳定排序）", () => {
  const p = { blocks: [
    { id: "x", source: "main", order: 0 },
    { id: "y", source: "main", order: 0 },
    { id: "z", source: "main", order: 0 }
  ]};
  assert.deepStrictEqual(M.orderedBlocks(p).map(b => b.id), ["x", "y", "z"]);
});

// ── 3. 块求值 ──
ok("description 块从角色卡取文本", () => {
  const t = M.resolveBlockText({ source: M.BlockSource.DESCRIPTION }, {
    character: { description: "一位占星师" }
  });
  assert.strictEqual(t, "一位占星师");
});

ok("personality 块带「性格：」前缀", () => {
  const t = M.resolveBlockText({ source: M.BlockSource.PERSONALITY }, {
    character: { personality: "冷静" }
  });
  assert.ok(t.includes("冷静") && t.startsWith("性格"));
});

ok("scenario 块带「场景：」前缀", () => {
  const t = M.resolveBlockText({ source: M.BlockSource.SCENARIO }, {
    character: { scenario: "雨夜" }
  });
  assert.ok(t.startsWith("场景"));
});

ok("main 块优先用角色卡 system_prompt", () => {
  const t = M.resolveBlockText({ source: M.BlockSource.MAIN }, {
    character: { system_prompt: "角色专属提示", system_prompt_enabled: true },
    mainPrompt: "预设主提示"
  });
  assert.strictEqual(t, "角色专属提示");
});

ok("system_prompt_enabled=false 时 main 块回退预设主提示", () => {
  const t = M.resolveBlockText({ source: M.BlockSource.MAIN }, {
    character: { system_prompt: "角色专属提示", system_prompt_enabled: false },
    mainPrompt: "预设主提示"
  });
  assert.strictEqual(t, "预设主提示");
});

ok("literal 块直接返回 content", () => {
  const t = M.resolveBlockText({ source: M.BlockSource.LITERAL, content: "固定文本" }, {});
  assert.strictEqual(t, "固定文本");
});

ok("未知 source 返回空串（不抛错）", () => {
  assert.strictEqual(M.resolveBlockText({ source: "???" }, {}), "");
});

// ── 4. 组装 ──
ok("composeFromPreset 按顺序拼接 system 块", () => {
  const preset = { blocks: [
    { id: "a", source: M.BlockSource.LITERAL, content: "第一", order: 0 },
    { id: "b", source: M.BlockSource.LITERAL, content: "第二", order: 10 }
  ]};
  const r = M.composeFromPreset(preset, {});
  assert.strictEqual(r.systemPrompt, "第一\n\n第二");
  assert.deepStrictEqual(r.used, ["a", "b"]);
});

ok("enabled=false 的块被跳过", () => {
  const preset = { blocks: [
    { id: "a", source: M.BlockSource.LITERAL, content: "进", order: 0 },
    { id: "b", source: M.BlockSource.LITERAL, content: "不进", order: 10, enabled: false }
  ]};
  const r = M.composeFromPreset(preset, {});
  assert.strictEqual(r.systemPrompt, "进");
  assert.deepStrictEqual(r.used, ["a"]);
});

ok("空内容的块被跳过（不留空行）", () => {
  const preset = { blocks: [
    { id: "a", source: M.BlockSource.LITERAL, content: "有", order: 0 },
    { id: "b", source: M.BlockSource.DESCRIPTION, order: 10 }  // 无角色卡
  ]};
  const r = M.composeFromPreset(preset, {});
  assert.strictEqual(r.systemPrompt, "有");
});

ok("世界书块带「## 世界设定」小标题", () => {
  const preset = { blocks: [{ id: "lore", source: M.BlockSource.LORE, order: 0 }] };
  const r = M.composeFromPreset(preset, { loreText: "设定内容" });
  assert.ok(r.systemPrompt.startsWith("## 世界设定"));
});

ok("in_chat 块不进 systemPrompt，单列出来", () => {
  const preset = { blocks: [
    { id: "sys", source: M.BlockSource.LITERAL, content: "系统", order: 0 },
    { id: "note", source: M.BlockSource.LITERAL, content: "插话", order: 10,
      position: M.BlockPosition.IN_CHAT, depth: 3 }
  ]};
  const r = M.composeFromPreset(preset, {});
  assert.strictEqual(r.systemPrompt, "系统");
  assert.strictEqual(r.inChatBlocks.length, 1);
  assert.strictEqual(r.inChatBlocks[0].depth, 3);
});

ok("in_chat 块未指定 depth 时默认 4", () => {
  const preset = { blocks: [
    { id: "n", source: M.BlockSource.LITERAL, content: "x", position: M.BlockPosition.IN_CHAT }
  ]};
  const r = M.composeFromPreset(preset, {});
  assert.strictEqual(r.inChatBlocks[0].depth, 4);
});

ok("调整 order 真的改变输出顺序", () => {
  const base = [
    { id: "a", source: M.BlockSource.LITERAL, content: "A" },
    { id: "b", source: M.BlockSource.LITERAL, content: "B" }
  ];
  const p1 = { blocks: base.map((b, i) => ({ ...b, order: i * 10 })) };
  const p2 = { blocks: base.map((b, i) => ({ ...b, order: (1 - i) * 10 })) };
  assert.strictEqual(M.composeFromPreset(p1, {}).systemPrompt, "A\n\nB");
  assert.strictEqual(M.composeFromPreset(p2, {}).systemPrompt, "B\n\nA");
});

// ── 5. 仓储 ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-preset-"));

await okAsync("init 自动建内置默认预设", async () => {
  const repo = new PresetRepo(tmp);
  await repo.init();
  const def = await repo.get("default");
  assert.ok(def, "默认预设应存在");
  assert.strictEqual(def.builtin, true);
});

await okAsync("builtin 排在最前", async () => {
  const repo = new PresetRepo(tmp);
  await repo.init();
  await repo.create({ name: "自定义" });
  const list = await repo.list();
  assert.strictEqual(list[0].id, "default");
});

await okAsync("内置预设不可删除", async () => {
  const repo = new PresetRepo(tmp);
  await repo.init();
  let threw = false;
  try { await repo.delete("default"); } catch { threw = true; }
  assert.ok(threw, "应拒绝删除内置预设");
});

await okAsync("duplicate 产生非内置副本", async () => {
  const repo = new PresetRepo(tmp);
  await repo.init();
  const copy = await repo.duplicate("default");
  assert.strictEqual(copy.builtin, false);
  assert.ok(copy.name.includes("副本"));
  assert.notStrictEqual(copy.id, "default");
});

await okAsync("create 拒绝非法预设", async () => {
  const repo = new PresetRepo(tmp);
  await repo.init();
  let threw = false;
  try { await repo.create({ name: "", blocks: [] }); } catch { threw = true; }
  assert.ok(threw, "应拒绝无名预设");
});

await okAsync("update 不能把预设改成 builtin", async () => {
  const repo = new PresetRepo(tmp);
  await repo.init();
  const p = await repo.create({ name: "普通" });
  const updated = await repo.update(p.id, { name: "改名", builtin: true });
  assert.strictEqual(updated.builtin, false, "builtin 不该被外部改写");
  assert.strictEqual(updated.name, "改名");
});

await okAsync("importPresets 幂等：同 id 覆盖而非重复", async () => {
  const repo = new PresetRepo(tmp);
  await repo.init();
  const created = await repo.create({ name: "待导入" });
  const r1 = await repo.importPresets([{ ...created, name: "覆盖后" }]);
  assert.strictEqual(r1[0].mode, "update");
  const after = await repo.get(created.id);
  assert.strictEqual(after.name, "覆盖后");
});

await okAsync("importPresets 报出非法条目而不中断", async () => {
  const repo = new PresetRepo(tmp);
  await repo.init();
  const results = await repo.importPresets([
    { name: "", blocks: [] },
    { name: "合法", blocks: [{ source: "main" }] }
  ]);
  assert.strictEqual(results[0].ok, false);
  assert.strictEqual(results[1].ok, true);
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail > 0 ? 1 : 0);
