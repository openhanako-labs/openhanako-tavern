// test/regression-settings-ownership.mjs — 设定条目的「归属」与「来源」分离
//
// 2026-09-27 修的一个真 bug：importCharacterBook 重导时按 characterId 清条目，
// 于是用户手动绑到该角色名下的设定（source="native"）会被一起删掉。
//
// 归属（对谁生效）和来源（谁带来的）是两件事：
//   · characterId 决定「这条对哪场对话生效」
//   · source      决定「这条是谁带来的」——删除只能按它判
//
// 这里钉住五条：卡带来的被替换、手建的必须活、ST 独立导入的必须活、
// 别人和全局的一律不动、source 缺失的老数据宁留不删。

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { createSettingRepo } from "../lib/settings/repo.js";

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

async function freshRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tavern-wb-owner-"));
  const repo = createSettingRepo(dir);
  await repo.init();
  return { dir, repo };
}

const CHAR = "char-A";
const OTHER = "char-B";

const cardEntry = (name, content = "来自卡") =>
  ({ name, content, source: "character_book" });

const namesOf = (list) => list.map(s => s.name).join("、");

console.log("\n设定条目 · 归属与来源");

await test("重导卡：卡带来的条目被替换，不堆重复", async () => {
  const { repo } = await freshRepo();
  await repo.importCharacterBook(CHAR, [cardEntry("卡带的", "v1")]);
  const r = await repo.importCharacterBook(CHAR, [cardEntry("卡带的", "v2")]);

  const all = await repo.list();
  const hit = all.filter(s => s.name === "卡带的");
  assert.equal(r.removed, 1, "该清掉卡先前带来的那一条");
  assert.equal(hit.length, 1, `不该堆重复，实际 ${hit.length} 条`);
  assert.equal(hit[0].content, "v2", "内容应被刷新");
});

await test("★ 用户手建的条目必须活下来（改坏点）", async () => {
  const { repo } = await freshRepo();
  // 用户给这个角色手写了一条设定——它绑在同一个角色上，但不来自卡
  await repo.create({ name: "我手写的背景", content: "手写", characterId: CHAR, source: "native" });

  const r = await repo.importCharacterBook(CHAR, [cardEntry("卡带的")]);

  const all = await repo.list();
  assert.ok(all.some(s => s.name === "我手写的背景"),
    `手建条目被误删了！现存：${namesOf(all)}`);
  assert.equal(r.removed, 0, "这次没有卡带来的旧条目，removed 应为 0");
});

await test("从 ST 独立世界书导入的条目也必须活下来", async () => {
  const { repo } = await freshRepo();
  await repo.create({ name: "独立世界书条目", content: "x", characterId: CHAR, source: "sillytavern" });
  await repo.importCharacterBook(CHAR, [cardEntry("卡带的")]);

  const all = await repo.list();
  assert.ok(all.some(s => s.name === "独立世界书条目"),
    `sillytavern 来源被误删！现存：${namesOf(all)}`);
});

await test("别的角色、全局条目一律不动", async () => {
  const { repo } = await freshRepo();
  await repo.importCharacterBook(CHAR, [cardEntry("A 卡的")]);
  await repo.importCharacterBook(OTHER, [cardEntry("B 卡的")]);
  await repo.create({ name: "全局条目", content: "g", characterId: "", source: "native" });

  // 重导 A 卡
  await repo.importCharacterBook(CHAR, [cardEntry("A 卡的", "改过")]);

  const all = await repo.list();
  assert.ok(all.some(s => s.name === "B 卡的"), "B 卡的条目不该被动");
  assert.ok(all.some(s => s.name === "全局条目"), "全局条目不该被动");
  const a = all.filter(s => s.name === "A 卡的");
  assert.equal(a.length, 1, "A 卡的仍应只有一条");
  assert.equal(a[0].content, "改过", "A 卡的内容应刷新");
});

await test("source 缺失的老数据一律保留（宁可留着，不可误删）", async () => {
  const { dir, repo } = await freshRepo();
  // 造一条「source 字段还没诞生时」写下的老条目：直接落盘，绕过 createSetting 的默认值
  await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify([
    { id: "legacy-1", name: "上古条目", content: "old", characterId: CHAR,
      keywords: [], enabled: true, order: 1, priority: 100 }
  ]), "utf8");

  const r = await repo.importCharacterBook(CHAR, [cardEntry("卡带的")]);

  const all = await repo.list();
  assert.ok(all.some(s => s.name === "上古条目"),
    `source 缺失的条目被当成卡带来的删了！现存：${namesOf(all)}`);
  assert.equal(r.removed, 0, "没有明确 character_book 来源的旧条目，不该被算作 removed");
});

// ── 判重看身份，不看名字 ─────────────────────────────

await test("重导同一份世界书：认出同一条并刷新内容（不是跳过）", async () => {
  const { repo } = await freshRepo();
  const book = (content) => [{ name: "世界观", content, source: "sillytavern", externalId: "e1" }];

  const r1 = await repo.importSettings(book("v1"));
  assert.equal(r1.added, 1, "首次应新增");

  const r2 = await repo.importSettings(book("v2"));
  assert.equal(r2.added, 0, "第二次不该新增");
  assert.equal(r2.updated, 1, "第二次应是更新，而不是静默跳过");

  const all = await repo.list();
  assert.equal(all.length, 1, "不该堆出重复");
  assert.equal(all[0].content, "v2", "内容应被刷新");
});

await test("同名但内容不同：两条各自留下，不互相吞", async () => {
  const { repo } = await freshRepo();
  // 两份独立世界书里都有一条叫「世界观」，内容不同、也没有 uid
  await repo.importSettings([{ name: "世界观", content: "版本甲", source: "sillytavern" }]);
  const r = await repo.importSettings([{ name: "世界观", content: "版本乙", source: "sillytavern" }]);

  const all = await repo.list();
  assert.equal(all.length, 2, `同名不同内容应各自留下，实际 ${all.length} 条`);
  assert.equal(r.added, 1, "第二条应算新增，而不是被吞");
});

await test("有原始 id 时按 id 认——改名也认得出是同一条", async () => {
  const { repo } = await freshRepo();
  await repo.importSettings([{ name: "旧名", content: "c", source: "sillytavern", externalId: "u9" }]);
  const r = await repo.importSettings([{ name: "新名", content: "c", source: "sillytavern", externalId: "u9" }]);

  const all = await repo.list();
  assert.equal(all.length, 1, "同 uid 应认作同一条，而不是堆两份");
  assert.equal(r.updated, 1);
  assert.equal(all[0].name, "新名", "名字应跟着刷新");
});

await test("更新时不覆盖用户手动关掉的开关", async () => {
  const { repo } = await freshRepo();
  await repo.importSettings([{ name: "条目", content: "v1", source: "sillytavern", externalId: "e2" }]);
  const first = (await repo.list())[0];
  await repo.toggle(first.id, false); // 用户手动关掉这一条

  await repo.importSettings([{ name: "条目", content: "v2", source: "sillytavern", externalId: "e2" }]);

  const after = (await repo.list())[0];
  assert.equal(after.content, "v2", "内容应刷新");
  assert.equal(after.enabled, false, "用户关掉的开关不该被导入刷回来");
});

console.log(`\n通过 ${passed} / 失败 ${failed}`);
process.exit(failed > 0 ? 1 : 0);
