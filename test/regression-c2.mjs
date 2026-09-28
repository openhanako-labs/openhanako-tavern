// test/regression-c2.mjs — C2 世界书导入回归
//
// 覆盖：ST 世界书字段映射 / character_book 导入 / position 编码 / selectiveLogic

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  stEntryToSetting,
  stWorldBookToSettings,
  characterBookToSettings,
  normalizeSelectiveLogic,
  mapPosition
} from "../lib/settings/import.js";
import { SettingRepo } from "../lib/settings/repo.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${e.message}`);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${e.message}`);
    failed++;
  }
}

console.log("\nC2 · 字段映射\n" + "─".repeat(50));

test("基础条目映射", () => {
  const s = stEntryToSetting({
    uid: 0,
    comment: "王都设定",
    content: "王都名为「银月城」，由议会统治。",
    key: ["王都", "银月城"],
    order: 150
  });
  assert.equal(s.name, "王都设定");
  assert.equal(s.content, "王都名为「银月城」，由议会统治。");
  assert.deepEqual(s.keywords, ["王都", "银月城"]);
  assert.equal(s.order, 150);
  assert.equal(s.source, "sillytavern");
  assert.equal(s.externalId, "0");
});

test("key 支持字符串（逗号分隔）", () => {
  const s = stEntryToSetting({ comment: "x", content: "c", key: "a, b, c" });
  assert.deepEqual(s.keywords, ["a", "b", "c"]);
});

test("constant=true → always 触发", () => {
  const s = stEntryToSetting({ comment: "常驻", content: "c", key: ["x"], constant: true });
  assert.equal(s.trigger.type, "always");
});

test("useRegex=true → regex 触发", () => {
  const s = stEntryToSetting({ comment: "正则", content: "c", key: ["/天气|climate/i"], useRegex: true });
  assert.equal(s.trigger.type, "regex");
  assert.ok(s.trigger.regex.includes("天气"));
});

test("disable → enabled=false", () => {
  const s = stEntryToSetting({ comment: "禁用", content: "c", disable: true });
  assert.equal(s.enabled, false);
});

test("副键与 selectiveLogic（数字编码）", () => {
  const s = stEntryToSetting({
    comment: "x", content: "c",
    key: ["主键"],
    keysecondary: ["副1", "副2"],
    selectiveLogic: 2,
    selective: true
  });
  assert.deepEqual(s.secondaryKeys, ["副1", "副2"]);
  assert.equal(s.selectiveLogic, "not_any", "数字 2 应为 not_any");
  assert.equal(s.selective, true);
});

test("selectiveLogic 四值全对", () => {
  assert.equal(normalizeSelectiveLogic(0), "and_any");
  assert.equal(normalizeSelectiveLogic(1), "not_all");
  assert.equal(normalizeSelectiveLogic(2), "not_any");
  assert.equal(normalizeSelectiveLogic(3), "and_all");
});

test("未知 selectiveLogic → 回退 and_any（不发明新模式）", () => {
  assert.equal(normalizeSelectiveLogic(99), "and_any");
  assert.equal(normalizeSelectiveLogic("乱写的"), "and_any");
  assert.equal(normalizeSelectiveLogic(null), "and_any");
});

test("position 数字编码映射", () => {
  assert.equal(mapPosition(0), "before_char");
  assert.equal(mapPosition(1), "after_char");
  assert.equal(mapPosition(2), "an_top");
  assert.equal(mapPosition(3), "an_bottom");
  assert.equal(mapPosition(4), "at_depth");
  assert.equal(mapPosition(5), "example_before");
  assert.equal(mapPosition(6), "example_after");
  assert.equal(mapPosition(7), "outlet");
});

test("无法映射的 position → anchor=null 但原值保留", () => {
  const s = stEntryToSetting({ comment: "x", content: "c", position: 42 });
  assert.equal(s.anchor, null, "不该硬塞一个错的 anchor");
  assert.equal(s.position, 42, "原值要保留");
  assert.equal(s.extensions._preserved_position, 42, "extensions 里也要留档");
});

test("递归标志保留", () => {
  const s = stEntryToSetting({
    comment: "x", content: "c",
    excludeRecursion: true,
    preventRecursion: true,
    delayUntilRecursion: true,
    recursionLevel: 3
  });
  assert.equal(s.excludeRecursion, true);
  assert.equal(s.preventRecursion, true);
  assert.equal(s.delayUntilRecursion, true);
  assert.equal(s.recursionLevel, 3);
});

test("匹配控制字段保留", () => {
  const s = stEntryToSetting({
    comment: "x", content: "c",
    matchWholeWords: true, caseSensitive: true, scanDepth: 5
  });
  assert.equal(s.matchWholeWords, true);
  assert.equal(s.caseSensitive, true);
  assert.equal(s.scanDepth, 5);
});

test("原始数据完整保留（不丢字段）", () => {
  const raw = { comment: "x", content: "c", key: ["k"], 某个未来字段: "值" };
  const s = stEntryToSetting(raw);
  assert.equal(s.extensions._raw.某个未来字段, "值");
});

console.log("\nC2 · 世界书文件解析\n" + "─".repeat(50));

test("entries 为数组", () => {
  const wb = {
    entries: [
      { comment: "A", content: "内容A", key: ["a"] },
      { comment: "B", content: "内容B", key: ["b"] }
    ]
  };
  const settings = stWorldBookToSettings(wb);
  assert.equal(settings.length, 2);
  assert.equal(settings[0].name, "A");
  assert.equal(settings[1].name, "B");
});

test("entries 为对象（key 为 uid）", () => {
  const wb = {
    entries: {
      "1": { comment: "B", content: "内容B", key: ["b"] },
      "0": { comment: "A", content: "内容A", key: ["a"] }
    }
  };
  const settings = stWorldBookToSettings(wb);
  assert.equal(settings.length, 2);
  assert.equal(settings[0].name, "A", "应按 uid 数字排序");
  assert.equal(settings[1].name, "B");
});

test("单条坏数据不中断整体导入", () => {
  const wb = {
    entries: [
      { comment: "好", content: "c", key: ["k"] },
      null,
      { comment: "也好", content: "c2", key: ["k2"] }
    ]
  };
  const settings = stWorldBookToSettings(wb);
  assert.equal(settings.length, 2, "坏数据应被跳过");
});

test("缺少 entries → 抛错", () => {
  assert.throws(() => stWorldBookToSettings({}), /missing entries/);
  assert.throws(() => stWorldBookToSettings(null), /not an object/);
});

test("character_book 导入（ST 卡内嵌）", () => {
  const book = {
    name: "卡内世界书",
    entries: [
      { comment: "地点", content: "北境森林", key: ["森林"], position: 0 },
      { comment: "人物", content: "村长", key: ["村长"], position: 1 }
    ]
  };
  const settings = characterBookToSettings(book);
  assert.equal(settings.length, 2);
  assert.equal(settings[0].source, "character_book");
  assert.equal(settings[0].anchor, "before_char");
  assert.equal(settings[1].anchor, "after_char");
});

test("character_book 为数组时也能处理", () => {
  const settings = characterBookToSettings([
    { comment: "x", content: "c", key: ["k"] }
  ]);
  assert.equal(settings.length, 1);
});

test("character_book 为 null → 空数组（不抛）", () => {
  assert.deepEqual(characterBookToSettings(null), []);
  assert.deepEqual(characterBookToSettings(undefined), []);
});

console.log("\nC2 · 落库\n" + "─".repeat(50));

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tavern-c2-"));

await testAsync("导入设定库后字段完整", async () => {
  const dir = path.join(tmpRoot, "repo");
  const repo = new SettingRepo(dir);
  await repo.init();

  const settings = characterBookToSettings({
    entries: [
      { comment: "测试条目", content: "内容", key: ["触发词"], keysecondary: ["副"], selectiveLogic: 3, position: 1 }
    ]
  });

  const result = await repo.importSettings(settings);
  assert.equal(result.added, 1);

  const list = await repo.list();
  assert.equal(list.length, 1);
  const s = list[0];
  assert.equal(s.name, "测试条目");
  assert.deepEqual(s.secondaryKeys, ["副"]);
  assert.equal(s.selectiveLogic, "and_all");
  assert.equal(s.anchor, "after_char");
  assert.equal(s.source, "character_book");
});

await testAsync("同名条目不重复导入", async () => {
  const dir = path.join(tmpRoot, "dedup");
  const repo = new SettingRepo(dir);
  await repo.init();

  const settings = stWorldBookToSettings({
    entries: [{ comment: "重复名", content: "c1", key: ["k"] }]
  });
  await repo.importSettings(settings);
  const second = await repo.importSettings(settings);

  assert.equal(second.added, 0);
  // 2026-09-27 判重从「名字」改成「身份」（源 + 原始 id，退了用内容指纹）。
  // 同一份内容重导：认出来、刷新，而不是当作全新的再塞一条——也不是
  // 「看到了但什么都不做」。计入 updated，不再计入 skipped。
  assert.equal(second.updated, 1);
  assert.equal(second.skipped.length, 0);
  assert.equal((await repo.list()).length, 1);
});

await fs.rm(tmpRoot, { recursive: true, force: true });

console.log("\n" + "=".repeat(50));
console.log(`通过 ${passed} / 失败 ${failed}`);
console.log("=".repeat(50));
process.exit(failed > 0 ? 1 : 0);
