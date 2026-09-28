// test/regression-st-export.mjs — 设定导出成 ST 世界书：来回一趟不许变形
//
// 为什么要有它：import 那条路是**单向**的——ST 世界书能进来，出不去。
// 于是"兼容老酒馆的卡"只成立一半：导进来看看可以，想拿回老酒馆用就不行。
//
// 判据是**往返**（round-trip）：
//   ST 世界书 → settingsToStWorldBook → 和原来那一份比
// 没动过的条目必须逐字一样（连我们不认识的键都得在），
// 动过的条目必须体现改动。
//
// 这个测试盯四件事：
//   ① 往返保真（没动过的条目，一个键都不许丢）
//   ② 改过的字段真的出得去
//   ③ 反向映射对得上（anchor→position 含 2/3、5/6 的分叉；名→数字；enabled→disable）
//   ④ 两边都别留别名（disable/disabled 并存会让 ST 读哪个都算对，也可能都算错）

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { stWorldBookToSettings, stEntryToSetting } = await import("../lib/settings/import.js");
const { settingsToStWorldBook, settingToStEntry } = await import("../lib/settings/export.js");

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log("  ✅ " + name); pass++; }
  catch (e) { console.log("  ❌ " + name + "\n     " + e.message); fail++; }
}

// 一份尽量"完整"的 ST 条目：把我们**不认识**的键也塞进去，
// 因为往返保真最容易被它们打破（只存认识的字段 = 悄悄丢一批）。
function stEntry(over = {}) {
  return {
    uid: 0,
    key: ["珂若尔", "珊瑚"],
    keysecondary: [],
    comment: "珂若尔与机甲",
    content: "珂若尔是一种在神经回路里流动的物质。",
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: 0,
    addMemo: true,
    order: 100,
    position: 0,
    disable: false,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: false,
    probability: 100,
    useProbability: true,
    depth: 4,
    group: "",
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    automationId: "",
    role: null,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    // 这一批是"我们还没有概念"的键，专门用来测保真
    extensions: { position: 0, exclude_recursion: false, display_index: 3 },
    displayIndex: 3,
    ...over
  };
}

function stBook(entries) {
  const obj = {};
  for (const e of entries) obj[String(e.uid)] = e;
  return { name: "测试世界", entries: obj };
}

console.log("\n=== ST 世界书导出（往返） ===\n");

// ── ① 往返保真 ────────────────────────────────────────
ok("往返一趟：每个 uid 的条目逐字相同（含我们不认识的键）", () => {
  const book = stBook([
    stEntry({ uid: 0, order: 100, position: 0 }),
    stEntry({ uid: 1, order: 90, position: 1, comment: "世界观", constant: true, key: [] })
  ]);
  const settings = stWorldBookToSettings(book);
  assert.strictEqual(settings.length, 2);

  const out = settingsToStWorldBook(settings);
  assert.deepStrictEqual(out.entries, book.entries);
});

ok("往返不动 uid 与 order 的数字（order 是 ST 的排位，不是我们的编号）", () => {
  const book = stBook([stEntry({ uid: 7, order: 250 })]);
  const out = settingsToStWorldBook(stWorldBookToSettings(book));
  assert.strictEqual(Number(out.entries["7"].uid), 7);
  assert.strictEqual(out.entries["7"].order, 250, "order 被我们的 1..N 编号顶掉了");
});

ok("往返保 selectiveLogic / position 的数字编码（不是名字）", () => {
  const book = stBook([
    stEntry({ uid: 0, order: 100, selectiveLogic: 3, position: 3 }),
    stEntry({ uid: 1, order: 90, selectiveLogic: 1, position: 6 })
  ]);
  const out = settingsToStWorldBook(stWorldBookToSettings(book));
  assert.strictEqual(out.entries["0"].selectiveLogic, 3);
  assert.strictEqual(out.entries["0"].position, 3, "position 3(an_bottom) 被写回去了 2 或别的");
  assert.strictEqual(out.entries["1"].selectiveLogic, 1);
  assert.strictEqual(out.entries["1"].position, 6);
});

// ── ② 改动出得去 ──────────────────────────────────────
ok("改过 content 的条目：导出的正文是新值，其余键仍保留", () => {
  const book = stBook([stEntry({ uid: 0, displayIndex: 3 })]);
  const settings = stWorldBookToSettings(book);
  settings[0].content = "改过了：珂若尔会随情绪变色。";

  const entry = 出(settingsToStWorldBook(settings), "0");
  assert.strictEqual(entry.content, "改过了：珂若尔会随情绪变色。");
  assert.strictEqual(entry.displayIndex, 3, "重建时把不认识的键丢了");
  assert.strictEqual(entry.addMemo, true, "重建时把不认识的键丢了");
});

function 出(book, uid) {
  const e = book.entries[String(uid)];
  assert.ok(e, "entries 里没有 uid=" + uid);
  return e;
}

ok("关掉的条目 → disable: true；开着 → false", () => {
  const settings = stWorldBookToSettings(stBook([stEntry({ uid: 0 })]));
  settings[0].enabled = false;
  assert.strictEqual(出(settingsToStWorldBook(settings), "0").disable, true);

  settings[0].enabled = true;
  assert.strictEqual(出(settingsToStWorldBook(settings), "0").disable, false);
});

ok("触发类型写回去：always→constant、regex→useRegex、keyword→两者皆 false", () => {
  const settings = stWorldBookToSettings(stBook([stEntry({ uid: 0 })]));

  settings[0].trigger = { type: "always", keywords: ["甲"] };
  let e = 出(settingsToStWorldBook(settings), "0");
  assert.strictEqual(e.constant, true);
  assert.strictEqual(e.useRegex, false);

  settings[0].trigger = { type: "regex", regex: "甲|乙", keywords: ["甲", "乙"] };
  e = 出(settingsToStWorldBook(settings), "0");
  assert.strictEqual(e.constant, false);
  assert.strictEqual(e.useRegex, true);
  assert.deepStrictEqual(e.key, ["甲", "乙"]);

  settings[0].trigger = { type: "keyword", keywords: ["甲"] };
  e = 出(settingsToStWorldBook(settings), "0");
  assert.strictEqual(e.constant, false);
  assert.strictEqual(e.useRegex, false);
});

ok("改了 anchor 就按新 anchor 出 position（不能还发着原码）", () => {
  const settings = stWorldBookToSettings(stBook([stEntry({ uid: 0, position: 3 })]));
  settings[0].anchor = "before_char";
  assert.strictEqual(出(settingsToStWorldBook(settings), "0").position, 0);
});

// ── ③ 别名与 uid ──────────────────────────────────────
ok("别名不留两份：disable 旁边不许再挂个 disabled", () => {
  const settings = stWorldBookToSettings(stBook([stEntry({ uid: 0, disabled: true, disable: undefined })]));
  settings[0].content = "改一下，逼它走重建";
  const e = 出(settingsToStWorldBook(settings), "0");
  assert.ok(!("disabled" in e), "disabled 别名还在");
  assert.ok(!("keys" in e), "keys 别名还在");
  assert.ok(!("secondary_keys" in e), "secondary_keys 别名还在");
  assert.strictEqual(e.disable, true);
});

ok("两条撞同一个 uid → 后一条顺延，不互相吃掉", () => {
  const a = stEntryToSetting(stEntry({ uid: 5 }), { order: 1 });
  const b = { ...stEntryToSetting(stEntry({ uid: 5, content: "另一条" }), { order: 2 }), externalId: "5" };
  const book = settingsToStWorldBook([a, b]);
  const uids = Object.keys(book.entries).map(Number).sort((x, y) => x - y);
  assert.strictEqual(uids.length, 2, "两条被压成一条了");
  assert.strictEqual(new Set(uids).size, 2);
});

ok("我们这边新建的条目（没有 _raw）也能出一条完整合法的 ST 条目", () => {
  const mine = {
    name: "新条目",
    content: "这是在这边新建的。",
    keywords: ["新"],
    trigger: { type: "keyword", keywords: ["新"] },
    enabled: true,
    order: 3,
    anchor: "after_char",
    probability: 80
  };
  const e = settingToStEntry(mine, { uid: 9 });
  assert.strictEqual(e.uid, 9);
  assert.deepStrictEqual(e.key, ["新"]);
  assert.strictEqual(e.comment, "新条目");
  assert.strictEqual(e.position, 1);
  assert.strictEqual(e.probability, 80);
  assert.strictEqual(e.disable, false);
  assert.strictEqual(e.constant, false);
  assert.strictEqual(e.selective, true);
  assert.strictEqual(typeof e.order, "number");
});

// ── ④ 形状 ────────────────────────────────────────────
ok("世界书写成 { entries: { \"<uid>\": {...} } }，key 是字符串 uid", () => {
  const book = settingsToStWorldBook(stWorldBookToSettings(stBook([stEntry({ uid: 12 })])));
  assert.ok(book.entries && !Array.isArray(book.entries), "entries 该是对象");
  assert.ok("12" in book.entries, "键该是字符串 uid");
  assert.strictEqual(book.entries["12"].uid, 12);
});

ok("空数组 / 坏数据不炸", () => {
  assert.deepStrictEqual(settingsToStWorldBook([]).entries, {});
  assert.deepStrictEqual(settingsToStWorldBook(null).entries, {});
  assert.deepStrictEqual(settingsToStWorldBook([null, 3, "x"]).entries, {});
});

// ── ⑤ 端到端：真路由走一遍 ─────────────────────────
async function okAsync(name, fn) {
  try { await fn(); console.log("  ✅ " + name); pass++; }
  catch (e) { console.log("  ❌ " + name + "\n     " + e.message); fail++; }
}

await okAsync("**契约（服务端）**：导进来的那一份，从 /settings/export-st 出去还是它", async () => {
  const os = await import("node:os");
  const { SettingRepo } = await import("../lib/settings/repo.js");
  const { makeApp, request } = await import("./lib/route-harness.mjs");
  const { registerSettingRoutes } = await import("../lib/settings/routes.js");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-stexp-"));
  const repo = new SettingRepo(tmp);
  await repo.init();

  const app = makeApp();
  registerSettingRoutes(app, repo, null);

  const book = stBook([
    stEntry({ uid: 0, order: 100, position: 0 }),
    stEntry({ uid: 1, order: 90, position: 1, comment: "世界观", constant: true, key: [] })
  ]);

  const imp = await request(app, "POST", "/settings/import-st", { body: { worldBook: book } });
  assert.strictEqual(imp.status, 200, "导入失败：" + (imp.error || ""));

  const out = await request(app, "GET", "/settings/export-st");
  assert.strictEqual(out.status, 200, "导出失败：" + (out.error || ""));
  const got = out.data?.worldBook;
  assert.ok(got && got.entries, "回话里没有 worldBook：" + JSON.stringify(out.data).slice(0, 120));
  assert.deepStrictEqual(got.entries, book.entries, "往返变形了");

  fs.rmSync(tmp, { recursive: true, force: true });
});

await okAsync("**契约（对侧）**：界面用 GET 调 export-st，且那颗按钮真绑上了", async () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, ...p.split("/")), "utf8");

  const ui = read("ui/assets/modules/settings.js");
  const at = ui.indexOf("settings/export-st");
  assert.ok(at > 0, "界面里找不到 export-st 调用");
  const around = ui.slice(Math.max(0, at - 200), at + 120);
  assert.ok(!/method:\s*"POST"/.test(around), "导出是读操作，别用 POST");
  assert.ok(/apiFetch/.test(around), "没走 apiFetch");

  const main = read("ui/assets/modules/main.js");
  assert.ok(main.includes('"export-st-btn"'), "main.js 没绑那颗按钮");
  assert.ok(main.includes("exportSTWorldBook"), "main.js 没引入导出函数");

  const html = read("ui/characters.html");
  assert.ok(html.includes('id="export-st-btn"'), "界面上没有那颗按钮");
});

console.log("\n通过 " + pass + " / 失败 " + fail + "\n");
if (fail > 0) process.exit(1);
