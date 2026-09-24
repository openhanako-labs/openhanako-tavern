// test/regression-variable-meta.mjs — 变量展示元数据的黄金断言
//
// 黑板上的「条」和「格」不是另造一套属性系统，是变量加了一层展示元数据：
//   min / max / kind / group / order
// 五件事必须钉死：
//   1. 新建的定义自带这五项，默认值确定
//   2. 老文件（没有这些字段）读得出来，且盘上文件不被改写——不要求迁移
//   3. 写进去能读回来，且 0 不被当成"没填"
//   4. 非法的 kind 退回 text——界面上画不出坏东西
//   5. bar 缺上下限时退回 number——否则会画出一根没有刻度的条
// 少了任何一条，展示元数据都可能被"顺手"改回硬编码而没人发现。

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { VariableRepo } = await import("../lib/variables/repo.js");
const { DisplayKind, normalizeVariableDefinition } = await import("../lib/variables/model.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 变量展示元数据 ===\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-varmeta-"));
const repo = new VariableRepo(tmp);
await repo.init();

// 场景 1：新建自带五项
await okAsync("新建的定义自带 min / max / kind / group / order", async () => {
  const def = await repo.createDefinition({ name: "信任", type: "number" });
  assert.strictEqual(def.kind, DisplayKind.TEXT, "默认展示形式是文本");
  assert.strictEqual(def.min, null);
  assert.strictEqual(def.max, null);
  assert.strictEqual(def.group, "");
  assert.strictEqual(def.order, 0);
});

// 场景 2：老文件不迁移也能读
await okAsync("老定义文件（无展示字段）读得出来，且盘上文件不被改写", async () => {
  const file = path.join(tmp, "variable-definitions.json");
  const legacy = [
    { id: "legacy-1", name: "好感", type: "number", scope: "conversation", defaultValue: 0 }
  ];
  fs.writeFileSync(file, JSON.stringify(legacy), "utf8");
  const before = fs.readFileSync(file, "utf8");

  const list = await repo.listDefinitions();
  const one = list.find(d => d.id === "legacy-1");
  assert.ok(one, "老定义必须读得出来");
  assert.strictEqual(one.kind, DisplayKind.TEXT, "缺 kind 时补默认");
  assert.strictEqual(one.min, null, "缺 min 时补 null");
  assert.strictEqual(one.order, 0, "缺 order 时补 0");
  assert.strictEqual(one.name, "好感", "原有字段不能被碰坏");

  assert.strictEqual(fs.readFileSync(file, "utf8"), before, "读取不应改写文件（不做迁移）");
});

// 场景 3：写进去能读回来，0 不是"没填"
await okAsync("写入展示元数据 → 读回一致（min=0 不被当成没填）", async () => {
  const def = await repo.createDefinition({ name: "生命", type: "number" });
  await repo.updateDefinition(def.id, { kind: "bar", min: 0, max: 100, group: "会话状态", order: 10 });
  const back = await repo.getDefinition(def.id);
  assert.strictEqual(back.kind, DisplayKind.BAR);
  assert.strictEqual(back.min, 0, "0 是合法边界值，不能被真值判断吃掉");
  assert.strictEqual(back.max, 100);
  assert.strictEqual(back.group, "会话状态");
  assert.strictEqual(back.order, 10);
});

// 场景 4：非法 kind 退回 text
await okAsync("非法 kind → 退回 text", async () => {
  const def = await repo.createDefinition({ name: "乱七八糟", kind: "sparkline" });
  assert.strictEqual(def.kind, DisplayKind.TEXT);
});

// 场景 5：bar 缺上下限 → 退回 number
await okAsync("bar 缺上下限 → 退回 number；齐全才留 bar", async () => {
  const half = normalizeVariableDefinition({ name: "半条", kind: "bar", min: 0 });
  assert.strictEqual(half.kind, DisplayKind.NUMBER, "只有下限画不出条");

  const full = normalizeVariableDefinition({ name: "全条", kind: "bar", min: 0, max: 100 });
  assert.strictEqual(full.kind, DisplayKind.BAR, "上下限齐全就该是条");

  const noBounds = normalizeVariableDefinition({ name: "空条", kind: "bar" });
  assert.strictEqual(noBounds.kind, DisplayKind.NUMBER);
});

// 场景 6：order 传字符串也认
await okAsync("order 允许字符串数字，落成 number", async () => {
  const def = await repo.createDefinition({ name: "排序测试", order: "7" });
  assert.strictEqual(def.order, 7);
  assert.strictEqual(typeof def.order, "number");
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
