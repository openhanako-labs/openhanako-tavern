// test/regression-st-v3-compat.mjs — ST v3 兼容：v3-无-ccv3 卡的书 + v3 命名映射
//
// 为什么要有它：
//   ① spec=chara_card_v3 但没有 ccv3 字段的卡（如 96958ffa「无职转生 - 沙盒」），
//      书藏在 data.character_book（202 条），顶层 character_book 是 null。
//      以前 detectCardFormat 三条 ST 分支全不中这种卡，判成 native，
//      normalizeCard 原样返回——import-book 路由读裸存的顶层字段，
//      永远拿到「该角色卡未内嵌世界书」。
//   ② v3 条目用 enabled（false=禁用）和 insertion_order（顺序）；
//      v2 命名是 disable/disabled（true=禁用）和 order。以前只认 v2 命名——
//      enabled:false 的常驻条目会被错导成「开启」，书内顺序丢失。
//
// 盯四件事：
//   ① 格式识别：v3-无-ccv3 → st-v3（不是 native）；原有判定一个不踩
//   ② normalizeCard：书从 data.character_book 提到顶层
//   ③ 命名映射：enabled 反转（v2 优先）、insertion_order → order（单条+整批）
//   ④ HTTP：POST /characters/:id/import-book 吃下裸存的 v3-无-ccv3 卡

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const { detectCardFormat, normalizeCard } = await import("../lib/characters/formats.js");
const { characterBookToSettings, stEntryToSetting, stWorldBookToSettings } =
  await import("../lib/settings/import.js");
const { CharacterRepo } = await import("../lib/characters/repo.js");
const { SettingRepo } = await import("../lib/settings/repo.js");
const { makeApp, request } = await import("./lib/route-harness.mjs");

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== ST v3 兼容（v3-无-ccv3 卡 + v3 命名） ===\n");

// ── ① 格式识别 ───────────────────────────────────────────
ok("spec=chara_card_v3 无 ccv3 但有 data → st-v3（不是 native）", () => {
  const card = {
    spec: "chara_card_v3", spec_version: "3",
    name: "测试", description: "d", first_mes: "f",
    character_book: null,
    data: { name: "测试", description: "d", first_mes: "f", character_book: { entries: {} } }
  };
  assert.strictEqual(detectCardFormat(card), "st-v3");
});

ok("原有判定不踩：v3带ccv3 / v2 / native / ccv3裸字段 / unknown", () => {
  assert.strictEqual(detectCardFormat({ spec: "chara_card_v3", ccv3: { name: "x" } }), "st-v3");
  assert.strictEqual(detectCardFormat({ spec: "chara_card_v2", data: { name: "x" } }), "st-v2");
  assert.strictEqual(detectCardFormat({ name: "x", description: "d", first_mes: "f" }), "native");
  assert.strictEqual(detectCardFormat({ ccv3: { name: "x" } }), "st-v3");
  assert.strictEqual(detectCardFormat(null), "unknown");
});

// ── ② normalizeCard：书从 data.character_book 提上来 ───────
ok("normalizeCard：v3-无-ccv3 卡的书从 data.character_book 提到顶层", () => {
  const book = { entries: { 0: { id: 0, keys: ["a"], content: "c", enabled: true, insertion_order: 1 } } };
  const card = {
    spec: "chara_card_v3", spec_version: "3",
    name: "测试", description: "d", first_mes: "f",
    character_book: null,
    data: { name: "测试", description: "d", first_mes: "f", character_book: book }
  };
  const normalized = normalizeCard(card);
  assert.strictEqual(normalized.character_book, book, "书要在顶层（同引用）");
  assert.strictEqual(normalized.name, "测试");
});

ok("normalizeCard：顶层无书也无 data.character_book → character_book=null（不装）", () => {
  const card = {
    spec: "chara_card_v3", spec_version: "3",
    name: "测试", description: "d", first_mes: "f",
    character_book: null,
    data: { name: "测试", description: "d", first_mes: "f" }
  };
  assert.strictEqual(normalizeCard(card).character_book, null);
});

// ── ③ v3 命名映射：enabled / insertion_order ──────────────
ok("v3 enabled:false → enabled=false（以前被错导成开启）", () => {
  assert.strictEqual(stEntryToSetting({ id: 1, keys: ["a"], content: "c", enabled: false }).enabled, false);
  assert.strictEqual(stEntryToSetting({ id: 1, keys: ["a"], content: "c", enabled: true }).enabled, true);
  assert.strictEqual(stEntryToSetting({ id: 1, keys: ["a"], content: "c" }).enabled, true);
});

ok("v2 disable 优先于 v3 enabled（同现不互踩）", () => {
  assert.strictEqual(
    stEntryToSetting({ id: 1, keys: ["a"], content: "c", disable: true, enabled: true }).enabled, false,
    "disable:true（v2）要赢");
  assert.strictEqual(
    stEntryToSetting({ id: 1, keys: ["a"], content: "c", disable: false, enabled: false }).enabled, true,
    "disable:false（v2）也要赢，enabled:false 不能再反转");
});

ok("v2 命名不受影响：disable/disabled 照旧", () => {
  assert.strictEqual(stEntryToSetting({ id: 1, keys: ["a"], content: "c", disable: true }).enabled, false);
  assert.strictEqual(stEntryToSetting({ id: 1, keys: ["a"], content: "c", disabled: true }).enabled, false);
});

ok("v3 insertion_order → order：单条", () => {
  assert.strictEqual(stEntryToSetting({ id: 1, keys: ["a"], content: "c", insertion_order: 42 }).order, 42);
  assert.strictEqual(
    stEntryToSetting({ id: 1, keys: ["a"], content: "c", order: 7, insertion_order: 42 }).order, 7,
    "v2 order 优先");
  assert.strictEqual(stEntryToSetting({ id: 1, keys: ["a"], content: "c" }).order, 100);
});

ok("v3 insertion_order → order：整批按它降序编号（还原 prompt 顺序）", () => {
  const wb = { entries: [
    { id: 1, keys: ["a"], content: "甲", insertion_order: 100 },
    { id: 2, keys: ["b"], content: "乙", insertion_order: 300 },
    { id: 3, keys: ["c"], content: "丙", insertion_order: 200 }
  ] };
  const list = stWorldBookToSettings(wb);
  assert.deepStrictEqual(list.map(s => s.content), ["乙", "丙", "甲"],
    "insertion_order 大的先进 prompt");
  assert.deepStrictEqual(list.map(s => s.order), [1, 2, 3]);
});

ok("v2 order 整批排序不变（v3 改动不踩 v2）", () => {
  const wb = { entries: [
    { uid: 1, key: ["a"], content: "甲", order: 100 },
    { uid: 2, key: ["b"], content: "乙", order: 300 },
    { uid: 3, key: ["c"], content: "丙", order: 200 }
  ] };
  const list = stWorldBookToSettings(wb);
  assert.deepStrictEqual(list.map(s => s.content), ["乙", "丙", "甲"]);
});

ok("characterBookToSettings 吃下 v3 命名整本书（形状+命名都过）", () => {
  const book = {
    entries: {
      0: { id: 0, keys: ["塔"], content: "甲", enabled: false, insertion_order: 10 },
      1: { id: 1, keys: ["血"], content: "乙", enabled: true, insertion_order: 20 }
    }
  };
  const settings = characterBookToSettings(book);
  assert.strictEqual(settings.length, 2);
  assert.deepStrictEqual(settings.map(s => s.content), ["乙", "甲"], "insertion_order 大的先");
  const disabled = settings.find(s => s.content === "甲");
  assert.strictEqual(disabled.enabled, false, "v3 enabled:false 要导成禁用");
});

// ── ④ HTTP：import-book 吃下裸存的 v3-无-ccv3 卡 ──────────
await okAsync("POST /characters/:id/import-book（replace=true）：裸存的 v3-无-ccv3 卡能补导", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-v3compat-"));
  try {
    const charRepo = new CharacterRepo(path.join(tmp, "chars"));
    const settingRepo = new SettingRepo(path.join(tmp, "settings"));
    await charRepo.init();
    await settingRepo.init();

    // 裸存的卡：v3-无-ccv3，顶层 character_book=null，书在 data.character_book（v3 命名）
    const rawCard = {
      spec: "chara_card_v3", spec_version: "3",
      name: "无职转生 - 沙盒（测试替身）", description: "d", first_mes: "f",
      character_book: null,
      data: {
        name: "无职转生 - 沙盒（测试替身）", description: "d", first_mes: "f",
        character_book: {
          entries: {
            0: { id: 0, keys: ["塔"], content: "常驻·禁用", constant: true, enabled: false, insertion_order: 10, position: 0 },
            1: { id: 1, keys: ["血"], content: "常驻·开启", constant: true, enabled: true, insertion_order: 30, position: 0 },
            2: { id: 2, keys: ["霜"], content: "关键词·中序", enabled: true, insertion_order: 20, position: 0 }
          }
        }
      }
    };
    const saved = await charRepo.create(rawCard);

    const app = makeApp();
    const { registerCharacterRoutes } = await import("../lib/characters/routes.js");
    registerCharacterRoutes(app, charRepo, null, settingRepo);

    const r = await request(app, "POST", `/characters/${saved.id}/import-book`, { body: { replace: true } });
    assert.strictEqual(r.status, 200, `状态 ${r.status}（${r.error || ""}）`);
    assert.strictEqual(r.data.added, 3, `应导入 3 条：${JSON.stringify(r.data)}`);
    assert.strictEqual(r.data.total, 3);
    assert.strictEqual(r.data.format, "character_book");

    // 落库核对：禁用状态 + 顺序
    const list = (await settingRepo.list()).filter(s => s.characterId === saved.id);
    assert.strictEqual(list.length, 3, "3 条都要落库");
    const off = list.find(s => s.content === "常驻·禁用");
    assert.strictEqual(off.enabled, false, "v3 enabled:false 导入后要禁用");
    assert.strictEqual(off.trigger.type, "always", "constant:true → always");
    const on = list.find(s => s.content === "常驻·开启");
    assert.strictEqual(on.enabled, true);
    assert.deepStrictEqual(list.map(s => s.content), ["常驻·开启", "关键词·中序", "常驻·禁用"],
      "insertion_order 大的先进 prompt（30/20/10）");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await okAsync("POST /characters/:id/import-book：真没书的卡仍回「未内嵌世界书」", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-v3nobook-"));
  try {
    const charRepo = new CharacterRepo(path.join(tmp, "chars"));
    const settingRepo = new SettingRepo(path.join(tmp, "settings"));
    await charRepo.init();
    await settingRepo.init();
    const saved = await charRepo.create({ name: "无书卡", description: "d", first_mes: "f" });

    const app = makeApp();
    const { registerCharacterRoutes } = await import("../lib/characters/routes.js");
    registerCharacterRoutes(app, charRepo, null, settingRepo);

    const r = await request(app, "POST", `/characters/${saved.id}/import-book`, { body: {} });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.added, 0);
    assert.match(r.data.note, /未内嵌世界书/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
