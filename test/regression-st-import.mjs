// test/regression-st-import.mjs — ST 世界书导入：映射 + 原字段保留 + 契约
//
// 为什么要有它：这条路**从来没用过**就坏了——界面向路由发 multipart，
// 而路由 `c.req.json()` 读 JSON，两边契约从来没对上；
// 而它弹的是原生文件框，自动化里没人能替它选文件，于是**整条路是盲区**。
// 一次真世界书端到端（tools/verify-st-import.mjs）才把它撞出来。
//
// 所以这个测试盯三件事：
//   ① 字段映射对不对（position→anchor、disable→enabled、uid、副键逻辑）
//   ② 原字段有没有丢（ST 兼容的命脉：extensions._raw 原样保留）
//   ③ 契约（界面发 JSON、路由读 JSON）——这条是"两边各自都对、接缝没人看"那一类，
//      要靠一条**跨侧**的断言钉住，否则下次改一边又会静默断掉

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const { stWorldBookToSettings, stEntryToSetting, mapPosition, normalizeSelectiveLogic } =
  await import("../lib/settings/import.js");
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

console.log("\n=== ST 世界书导入 ===\n");

// ── ① position → anchor（表里的八档逐个对） ──────────────
ok("position 0..7 各自映到 anchor；未知码返回 null 而不是猜一个", () => {
  const table = {
    0: "before_char", 1: "after_char", 2: "an_top", 3: "an_bottom",
    4: "at_depth", 5: "example_before", 6: "example_after", 7: "outlet"
  };
  for (const [n, anchor] of Object.entries(table)) {
    assert.strictEqual(mapPosition(Number(n)), anchor, `position ${n}`);
  }
  assert.strictEqual(mapPosition(99), null, "未知 position 不该被猜成一个锚点");
});

ok("未知 position 的原值不丢（落在 extensions）", () => {
  const s = stEntryToSetting({ uid: 1, key: ["x"], content: "c", position: 99 });
  assert.strictEqual(s.anchor, null);
  assert.strictEqual(s.position, 99, "原始编码要留着，不能静默丢弃");
  assert.strictEqual(s.extensions._preserved_position, 99);
});

// ── ② 触发类型 + 键 + 开关 ──────────────────────────────
ok("constant=true → always；use_regex → regex；否则 keyword", () => {
  assert.strictEqual(stEntryToSetting({ key: ["a"], content: "c", constant: true }).trigger.type, "always");
  assert.strictEqual(stEntryToSetting({ key: ["a"], content: "c", use_regex: true }).trigger.type, "regex");
  assert.strictEqual(stEntryToSetting({ key: ["a"], content: "c" }).trigger.type, "keyword");
});

ok("key / keys 都可；字符串按逗号切", () => {
  assert.deepStrictEqual(stEntryToSetting({ keys: ["甲", "乙"], content: "c" }).keywords, ["甲", "乙"]);
  assert.deepStrictEqual(stEntryToSetting({ key: "甲, 乙 ,,丙", content: "c" }).keywords, ["甲", "乙", "丙"]);
});

ok("disable / disabled → enabled=false", () => {
  assert.strictEqual(stEntryToSetting({ key: ["a"], content: "c", disable: true }).enabled, false);
  assert.strictEqual(stEntryToSetting({ key: ["a"], content: "c" }).enabled, true);
});

ok("uid → externalId（溯源靠它）", () => {
  assert.strictEqual(stEntryToSetting({ uid: 86, key: ["a"], content: "c" }).externalId, "86");
});

ok("selectiveLogic 数字 → 规范名；未知值回退 and_any（不发明新模式）", () => {
  assert.strictEqual(normalizeSelectiveLogic(0), "and_any");
  assert.strictEqual(normalizeSelectiveLogic(1), "not_all");
  assert.strictEqual(normalizeSelectiveLogic(2), "not_any");
  assert.strictEqual(normalizeSelectiveLogic(3), "and_all");
  assert.strictEqual(normalizeSelectiveLogic(7), "and_any", "未知值要回退，不是编一个新模式");
});

// ── ③ 原字段保留（ST 兼容的命脉） ────────────────────────
ok("**原字段一个不丢**：extensions._raw 与输入逐字相等", () => {
  const entry = {
    uid: 12, key: ["面子"], keysecondary: ["甲"], comment: "面子果实",
    content: "正文", constant: false, selectiveLogic: 1, order: 8,
    position: 4, disable: false, probability: 70,
    excludeRecursion: true, delayUntilRecursion: true, recursionLevel: 2,
    一个我们完全不认识的字段: "也要留着"
  };
  const s = stEntryToSetting(entry);
  assert.deepStrictEqual(s.extensions._raw, entry, "原字段必须原样保留");
  assert.strictEqual(s.extensions._raw.一个我们完全不认识的字段, "也要留着");
});

// ── ④ 整批：对象形式按 uid 排序 + 坏数据不中断 ────────────
ok("entries 是对象（key 为 uid）→ 按 uid 排序，不按对象的键序", () => {
  const wb = {
    entries: {
      10: { uid: 10, key: ["c"], content: "第三" },
      2: { uid: 2, key: ["a"], content: "第一" },
      5: { uid: 5, key: ["b"], content: "第二" }
    }
  };
  const list = stWorldBookToSettings(wb);
  assert.deepStrictEqual(list.map((s) => s.content), ["第一", "第二", "第三"]);
});

// ── order：批量导入要还原 ST 的 prompt 顺序 ────────────────
//
// ST 那边进 prompt 的顺序是 `(a,b) => b.order - a.order`（大的先，world-info.js:88），
// 而我们的 entrySortKey 是**升序**（小的先）——方向相反。
// 所以批量导入必须**先按 ST 的 order 降序排一遍再编号**，
// 否则用户排好的顺序会被“创建顺序”（uid）顶掉，而且哪一步都不报错。
ok("批量导入按 ST 的 order 降序编号（不是创建顺序）", () => {
  const wb = {
    entries: [
      { uid: 1, comment: "最先建的", key: ["ka"], content: "甲", order: 100 },
      { uid: 2, comment: "最后建的但排最前", key: ["kb"], content: "乙", order: 300 },
      { uid: 3, comment: "中间", key: ["kc"], content: "丙", order: 200 }
    ]
  };
  const list = stWorldBookToSettings(wb);
  assert.deepStrictEqual(list.map((s) => s.content), ["乙", "丙", "甲"],
    "ST 里 order 大的先进 prompt → 我们的 order（升序）要还原它");
  assert.deepStrictEqual(list.map((s) => s.order), [1, 2, 3]);
});

// 缺 order 时按默认 100，且保持原顺序（排序是稳定的）
ok("没有 order 字段时保持原顺序（默认 100）", () => {
  const wb = { entries: [
    { uid: 1, key: ["a"], content: "甲" },
    { uid: 2, key: ["b"], content: "乙" },
    { uid: 3, key: ["c"], content: "丙" }
  ] };
  assert.deepStrictEqual(stWorldBookToSettings(wb).map((s) => s.content), ["甲", "乙", "丙"]);
});

// 单条转换仍然尊重条目自己的 order。
// 这条曾经被我判成“不可能走到”——测试当场纠正了那个判断。
ok("单条转换 stEntryToSetting 尊重 entry.order", () => {
  assert.strictEqual(stEntryToSetting({ uid: 1, key: ["a"], content: "c", order: 150 }).order, 150);
  assert.strictEqual(stEntryToSetting({ uid: 1, key: ["a"], content: "c" }).order, 100);
});

ok("单条坏数据不中断整批（坏的那条跳过）", () => {
  const wb = { entries: [{ uid: 1, key: ["a"], content: "好" }, null, { uid: 3, key: ["c"], content: "也好" }] };
  const list = stWorldBookToSettings(wb);
  assert.strictEqual(list.length, 2, "整批不该因为一条坏数据全丢");
});

ok("缺 entries / 不是对象 → 报错说清（不是默默回空数组）", () => {
  assert.throws(() => stWorldBookToSettings(null), /not an object/);
  assert.throws(() => stWorldBookToSettings({ foo: 1 }), /missing entries/);
});

// ── ⑤ 契约：界面发 JSON、路由读 JSON ─────────────────────
ok("**契约**：界面调 settings/import-st 时必须发 JSON（不是 multipart）", () => {
  const src = fs.readFileSync(path.join(ROOT, "ui", "assets", "modules", "settings.js"), "utf8");
  const idx = src.indexOf("settings/import-st");
  assert.ok(idx > 0, "找不到界面里调用 import-st 的地方");
  // 取该调用前后的一段来判
  const around = src.slice(Math.max(0, idx - 400), idx + 200);
  assert.ok(!/FormData/.test(around), "又用 FormData 了——路由读的是 c.req.json()，multipart 会拿不到 worldBook");
  assert.ok(/JSON\.stringify/.test(around), "没看到 JSON.stringify：路由要的是 { worldBook }");
});

await okAsync("**契约（服务端）**：POST /settings/import-st 收 { worldBook } 并真的写进去", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-stimp-"));
  const repo = new SettingRepo(tmp);
  await repo.init();

  const app = makeApp();
  const { registerSettingRoutes } = await import("../lib/settings/routes.js");
  registerSettingRoutes(app, repo, null);

  const wb = { entries: { 0: { uid: 0, key: ["月台"], content: "站台的灯忽明忽暗。", position: 0 } } };
  const r = await request(app, "POST", "/settings/import-st", { body: { worldBook: wb } });
  assert.strictEqual(r.status, 200, `状态 ${r.status}（${r.error || ""}）`);
  assert.strictEqual(r.data.added ?? r.data.total, 1, `回话不对：${JSON.stringify(r.data)}`);

  const list = await repo.list();
  assert.strictEqual(list.length, 1, "没写进去");
  assert.strictEqual(list[0].anchor, "before_char");

  fs.rmSync(tmp, { recursive: true, force: true });
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
