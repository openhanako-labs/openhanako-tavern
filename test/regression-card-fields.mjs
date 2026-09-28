// test/regression-card-fields.mjs — 角色卡必填规则
//
// 2026-09-27 把必填从 [name, description, first_mes] 放宽到只剩 name。
// 理由：真实的 ST 卡经常不写 description（有名字、有世界书，就是没描述），
// 用必填硬拒等于把「导入别人的卡」这个入口废掉。
//
// 但放宽不能变成「什么都不管」，所以这里同时钉住三头：
//   1. 只有 name 的卡存得下去（放宽生效）
//   2. 没有 name 的卡照样被拒（红线还在）
//   3. 缺 description / first_mes 的旧卡，改别的字段也存得下去（兼容旧卡）

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  validateCharacter,
  missingRecommended,
  createEmptyCharacter
} from "../lib/characters/model.js";
import { CharacterRepo } from "../lib/characters/repo.js";

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

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tavern-card-fields-"));
const repo = new CharacterRepo(tmpDir);
await repo.init();

console.log("\n角色卡必填规则");

await test("只有名称的卡通过校验（放宽生效）", async () => {
  assert.deepEqual(validateCharacter({ name: "装甲核心" }), []);
});

await test("没有名称的卡仍然被拒（红线还在）", async () => {
  assert.deepEqual(validateCharacter({ description: "d", first_mes: "f" }), ["name is required"]);
  await assert.rejects(
    () => repo.create({ description: "d", first_mes: "f" }),
    /name is required/
  );
});

await test("缺描述 / 开场白算「推荐缺失」，不算错误", async () => {
  assert.deepEqual(missingRecommended({ name: "A" }), ["description", "first_mes"]);
  assert.deepEqual(missingRecommended({ name: "A", description: "d", first_mes: "f" }), []);
});

await test("导入来的旧卡（没有描述）能直接存进库", async () => {
  const saved = await repo.create({ name: "旧卡", first_mes: "你好" });
  assert.ok(saved.id, "该拿到 id");
  const back = await repo.get(saved.id);
  assert.equal(back.name, "旧卡");
  assert.equal(back.description, "");
});

await test("兼容旧卡：缺字段的卡改一个标签也存得下去", async () => {
  // 这是放宽最实际的收益——以前改一个标签会被必填校验拦下，
  // 于是旧卡只能看不能动。
  const saved = await repo.create({ name: "老卡", description: "", first_mes: "" });
  const updated = await repo.update(saved.id, { tags: ["奇幻"] });
  assert.deepEqual(updated.tags, ["奇幻"]);
  assert.equal(updated.description, "");
  assert.equal(updated.name, "老卡", "没动过的字段不该被抹掉");
});

await test("建卡模板仍然带齐全部字段（结构不回归）", async () => {
  const blank = createEmptyCharacter();
  for (const f of ["name", "description", "first_mes", "personality", "scenario", "mes_example", "character_book"]) {
    assert.ok(f in blank, `${f} 不该从模板里消失`);
  }
});

console.log(`\n通过 ${passed} / 失败 ${failed}`);
process.exit(failed > 0 ? 1 : 0);
