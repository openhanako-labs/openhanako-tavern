// test/regression-p3.mjs — P3 接线层回归
//
// 这一批锁的是「零件之间连没连上」，不是零件本身对不对：
//   1. 世界书角色隔离——绑定到 A 的条目不能在 B 的对话里激活
//   2. importSettings 去重键必须带归属——两张卡同名的世界书条目不能互吞
//   3. importCharacterBook 幂等——改卡重导不堆重复条目
//   4. getActive 的 scope 过滤
//   5. 摘要写回：合并 / 复用 / 预算变宽后失效重算
//   6. 人设字段能落盘且不被 update() 带上车

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { SettingRepo } = await import("../lib/settings/repo.js");
const { filterForCharacter, matchesCharacterFilter } = await import("../lib/settings/model.js");
const { stWorldBookToSettings, characterBookToSettings } = await import("../lib/settings/import.js");
const { trimHistory, prepareHistory, buildSummary, mergeSummary } = await import("../lib/llm/history.js");
const { ConversationRepo } = await import("../lib/conversations/repo.js");
const { createEmptyConversation } = await import("../lib/conversations/model.js");

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-p3-"));

console.log("\n=== P3 · 世界书角色隔离 ===\n");

await t("绑定条目只对本角色可见", async () => {
  const list = [
    { name: "全局", content: "c", characterId: "" },
    { name: "A的", content: "c", characterId: "charA" },
    { name: "B的", content: "c", characterId: "charB" }
  ];
  const forA = filterForCharacter(list, { characterId: "charA" });
  assert.deepEqual(forA.map(s => s.name), ["全局", "A的"]);
  const forB = filterForCharacter(list, { characterId: "charB" });
  assert.deepEqual(forB.map(s => s.name), ["全局", "B的"]);
});

await t("没有 characterId 时全部按全局处理", () => {
  const list = [{ name: "a" }, { name: "b" }];
  assert.equal(filterForCharacter(list, {}).length, 2);
});

await t("characterFilter 命中角色名才放行", () => {
  const setting = {
    name: "s",
    characterFilter: { names: ["阿尔法"], tags: [], isExclude: false }
  };
  assert.equal(matchesCharacterFilter(setting, { characterName: "阿尔法" }), true);
  assert.equal(matchesCharacterFilter(setting, { characterName: "贝塔" }), false);
});

await t("characterFilter 命中标签也行", () => {
  const setting = {
    name: "s",
    characterFilter: { names: [], tags: ["龙"], isExclude: false }
  };
  assert.equal(matchesCharacterFilter(setting, { characterTags: ["龙", "其他"] }), true);
  assert.equal(matchesCharacterFilter(setting, { characterTags: ["人"] }), false);
});

await t("isExclude=true 时反转", () => {
  const setting = {
    name: "s",
    characterFilter: { names: ["阿尔法"], tags: [], isExclude: true }
  };
  assert.equal(matchesCharacterFilter(setting, { characterName: "阿尔法" }), false);
  assert.equal(matchesCharacterFilter(setting, { characterName: "贝塔" }), true);
});

await t("名字和标签都空 = 不过滤", () => {
  const setting = { name: "s", characterFilter: { names: [], tags: [] } };
  assert.equal(matchesCharacterFilter(setting, { characterName: "谁" }), true);
});

await t("绑定优先于 characterFilter", () => {
  const list = [{
    name: "s",
    characterId: "charA",
    characterFilter: { names: ["别的人"], tags: [], isExclude: true }
  }];
  assert.equal(filterForCharacter(list, { characterId: "charA" }).length, 1);
});

console.log("\n=== P3 · 去重键带归属 ===\n");

await t("两张卡同名条目不互吞", async () => {
  const dir = path.join(tmp, "dedup-scope");
  const repo = new SettingRepo(dir);
  await repo.init();

  const a = stWorldBookToSettings({ entries: [{ comment: "世界观", content: "A卡版", key: ["k"] }] });
  const b = stWorldBookToSettings({ entries: [{ comment: "世界观", content: "B卡版", key: ["k"] }] });
  for (const s of a) s.characterId = "charA";
  for (const s of b) s.characterId = "charB";

  const r1 = await repo.importSettings(a);
  const r2 = await repo.importSettings(b);
  assert.equal(r1.added, 1);
  assert.equal(r2.added, 1, "同名但不同归属的条目不该被跳过");
});

await t("同角色同名同内容：认作同一条，不堆重复", async () => {
  const dir = path.join(tmp, "dedup-same");
  const repo = new SettingRepo(dir);
  await repo.init();

  const mk = () => {
    const s = stWorldBookToSettings({ entries: [{ comment: "世界观", content: "x", key: ["k"] }] });
    for (const i of s) i.characterId = "charA";
    return s;
  };
  const r1 = await repo.importSettings(mk());
  const r2 = await repo.importSettings(mk());
  assert.equal(r1.added, 1);
  assert.equal(r2.added, 0, "同样的内容不该再新增一条");
  // 2026-09-27：判重从「名字」改成「身份」。同样内容的第二次导入
  // 是「认出来并刷新」（updated），不是「跳过」（skipped）。
  assert.equal(r2.updated, 1);
  assert.equal((await repo.list()).length, 1, "终究只有一条");
});

await t("listForCharacter 返回本角色 + 全局", async () => {
  const dir = path.join(tmp, "list-scope");
  const repo = new SettingRepo(dir);
  await repo.init();

  const g = stWorldBookToSettings({ entries: [{ comment: "全局", content: "g", key: ["k"] }] });
  const a = stWorldBookToSettings({ entries: [{ comment: "A", content: "a", key: ["k"] }] });
  const b = stWorldBookToSettings({ entries: [{ comment: "B", content: "b", key: ["k"] }] });
  for (const s of a) s.characterId = "charA";
  for (const s of b) s.characterId = "charB";

  await repo.importSettings([...g, ...a, ...b]);
  const forA = await repo.listForCharacter("charA");
  assert.deepEqual(forA.map(s => s.name).sort(), ["A", "全局"]);
});

console.log("\n=== P3 · importCharacterBook 幂等 ===\n");

await t("重复导入同一张卡：先清旧再导，不留重复", async () => {
  const dir = path.join(tmp, "book-idem");
  const repo = new SettingRepo(dir);
  await repo.init();

  const book = { entries: [
    { comment: "剑", content: "一把剑", key: ["剑"] },
    { comment: "城", content: "一座城", key: ["城"] }
  ]};

  const first = await repo.importCharacterBook("charA", characterBookToSettings(book));
  assert.equal(first.added, 2);
  assert.equal((await repo.list()).length, 2);

  const second = await repo.importCharacterBook("charA", characterBookToSettings(book));
  assert.equal(second.removed, 2, "重导应先清掉旧条目");
  assert.equal(second.added, 2);
  assert.equal((await repo.list()).length, 2, "不该堆出 4 条");
});

await t("改卡内容后重导：旧条目被替换", async () => {
  const dir = path.join(tmp, "book-edit");
  const repo = new SettingRepo(dir);
  await repo.init();

  await repo.importCharacterBook("charA", characterBookToSettings({
    entries: [{ comment: "剑", content: "旧描述", key: ["剑"] }]
  }));
  const r = await repo.importCharacterBook("charA", characterBookToSettings({
    entries: [{ comment: "剑", content: "新描述", key: ["剑"] }]
  }));

  const list = await repo.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].content, "新描述");
  assert.equal(r.removed, 1);
});

await t("不碰别人与全局的条目", async () => {
  const dir = path.join(tmp, "book-isolate");
  const repo = new SettingRepo(dir);
  await repo.init();

  const g = stWorldBookToSettings({ entries: [{ comment: "全局", content: "g", key: ["k"] }] });
  const b = stWorldBookToSettings({ entries: [{ comment: "B", content: "b", key: ["k"] }] });
  for (const s of b) s.characterId = "charB";
  await repo.importSettings([...g, ...b]);

  await repo.importCharacterBook("charA", characterBookToSettings({
    entries: [{ comment: "A", content: "a", key: ["k"] }]
  }));

  const names = (await repo.list()).map(s => s.name).sort();
  assert.deepEqual(names, ["A", "B", "全局"]);
});

await t("空世界书不炸，返回全零", async () => {
  const dir = path.join(tmp, "book-empty");
  const repo = new SettingRepo(dir);
  await repo.init();
  const r = await repo.importCharacterBook("charA", []);
  assert.equal(r.added, 0);
  assert.equal(r.removed, 0);
});

await t("缺 characterId 时报错而不是静默全表", async () => {
  const dir = path.join(tmp, "book-noid");
  const repo = new SettingRepo(dir);
  await repo.init();
  await assert.rejects(() => repo.importCharacterBook(null, [{ name: "x" }]));
});

console.log("\n=== P3 · getActive 带 scope ===\n");

await t("scope 里的角色条目生效，别人的不生效", async () => {
  const dir = path.join(tmp, "active-scope");
  const repo = new SettingRepo(dir);
  await repo.init();

  const a = stWorldBookToSettings({ entries: [{ comment: "A", content: "a", key: ["剑"] }] });
  const b = stWorldBookToSettings({ entries: [{ comment: "B", content: "b", key: ["剑"] }] });
  for (const s of a) s.characterId = "charA";
  for (const s of b) s.characterId = "charB";
  await repo.importSettings([...a, ...b]);

  const ctx = { text: "拔剑" };
  const got = await repo.getActive(ctx, {}, { characterId: "charA" });
  assert.equal(got.length, 1);
  assert.equal(got[0].name, "A");
});

await t("不传 scope = 不过滤（旧行为）", async () => {
  const dir = path.join(tmp, "active-noscope");
  const repo = new SettingRepo(dir);
  await repo.init();
  const s = stWorldBookToSettings({ entries: [{ comment: "X", content: "x", key: ["剑"] }] });
  for (const i of s) i.characterId = "charA";
  await repo.importSettings(s);

  const got = await repo.getActive({ text: "拔剑" }, {});
  assert.equal(got.length, 1);
});

console.log("\n=== P3 · 摘要写回 ===\n");

const mkMsgs = (n, tag = "x") =>
  Array.from({ length: n }, (_, i) => ({
    id: `m${i}`, role: i % 2 ? "assistant" : "user", content: `${tag}-${i}`
  }));

await t("trimHistory 返回被丢掉的原始消息", () => {
  const r = trimHistory(mkMsgs(20), { maxTokens: 20, keepRecent: 2 });
  assert.ok(r.dropped > 0);
  assert.equal(r.droppedMessages.length, r.dropped);
  assert.equal(r.droppedMessages[0].id, "m0");
});

await t("不裁剪时 droppedMessages 为空", () => {
  const r = trimHistory(mkMsgs(3), { maxTokens: 100000 });
  assert.deepEqual(r.droppedMessages, []);
});

await t("mergeSummary：无旧摘要 → 现算全部", () => {
  const rec = mergeSummary(null, mkMsgs(10, "a"));
  assert.ok(rec.text.includes("起点"));
  assert.equal(rec.coveredCount, 10);
});

await t("mergeSummary：折叠数不变 → 原样复用", () => {
  const prev = { text: "旧摘要", coveredCount: 10 };
  const rec = mergeSummary(prev, mkMsgs(10, "a"));
  assert.equal(rec.text, "旧摘要");
  assert.equal(rec.coveredCount, 10);
});

await t("mergeSummary：又多折叠了 → 只压新增那段并拼接", () => {
  const prev = { text: "旧摘要", coveredCount: 10 };
  const rec = mergeSummary(prev, mkMsgs(15, "a"));
  assert.ok(rec.text.startsWith("旧摘要"));
  // 新折叠的是 m10 起，其内容为 a-10
  assert.ok(rec.text.includes("a-10"), "新折叠的段落应该被压进去");
  assert.equal(rec.coveredCount, 15);
});

await t("mergeSummary：预算变宽（旧摘要盖得比现在还多）→ 失效重算", () => {
  const prev = { text: "旧摘要", coveredCount: 15 };
  const rec = mergeSummary(prev, mkMsgs(8, "a"));
  // 8 < 15：旧摘要已对不上当前边界，必须重算
  assert.notEqual(rec.text, "旧摘要");
  assert.equal(rec.coveredCount, 8);
});

await t("mergeSummary：没丢东西 → null", () => {
  assert.equal(mergeSummary({ text: "x", coveredCount: 5 }, []), null);
});

await t("prepareHistory 吐出 summaryRecord 供写回", () => {
  const r = prepareHistory(mkMsgs(20), {
    maxTokens: 20, keepRecent: 2,
    previousSummary: { text: "旧摘要", coveredCount: 5 }
  });
  assert.ok(r.summaryRecord);
  assert.ok(r.summaryAttached);
  assert.equal(r.summaryRecord.coveredCount, r.dropped);
  assert.ok(r.messages[0].content.includes("前情提要"));
});

await t("prepareHistory 只经 summaryRecord 吐摘要（单一出口）", () => {
  const r = prepareHistory(mkMsgs(20), {
    maxTokens: 20, keepRecent: 2,
    previousSummary: { text: "旧摘要", coveredCount: 5 }
  });
  assert.equal(r.droppedMessages, undefined,
    "不该再直接从 prepareHistory 暴露原始消息——调用方拿 summaryRecord 足矣");
  assert.ok(r.summaryRecord.text);
});

await t("summarize=false 时 summaryRecord 为 null", () => {
  const r = prepareHistory(mkMsgs(20), {
    maxTokens: 20, keepRecent: 2, summarize: false,
    previousSummary: { text: "旧", coveredCount: 3 }
  });
  assert.equal(r.summaryRecord, null);
  assert.equal(r.summaryAttached, false);
});

await t("摘要锚点同样破坏前缀断点", () => {
  const r = prepareHistory(mkMsgs(20), {
    maxTokens: 20, keepRecent: 2,
    previousSummary: { text: "旧摘要", coveredCount: 5 }
  });
  assert.ok(r.messages.slice(1).every(m => m._prefixBroken === true));
});

console.log("\n=== P3 · 人设字段 ===\n");

await t("createEmptyConversation 带 userName / persona / summary 缺省", () => {
  const c = createEmptyConversation("charA");
  assert.equal(c.userName, "");
  assert.equal(c.persona, "");
  assert.equal(c.summary, null);
});

await t("overrides 可覆盖人设（创建对话时传值）", () => {
  const c = createEmptyConversation("charA", { userName: "月曦夜", persona: "旅人" });
  assert.equal(c.userName, "月曦夜");
  assert.equal(c.persona, "旅人");
});

await t("repo.setPersona 只动人设两字段", async () => {
  const dir = path.join(tmp, "persona");
  const repo = new ConversationRepo(dir);
  await repo.init();

  const conv = await repo.create("charA");
  await repo.addMessage(conv.id, "user", "你好");
  const before = await repo.get(conv.id);

  const after = await repo.setPersona(conv.id, { userName: "月曦夜", persona: "旅人" });
  assert.equal(after.userName, "月曦夜");
  assert.equal(after.persona, "旅人");
  assert.equal(after.messages.length, before.messages.length, "不该动消息");
  assert.equal(after.id, before.id, "不该动 id");
});

await t("setPersona 只传一个字段时另一个不动", async () => {
  const dir = path.join(tmp, "persona-partial");
  const repo = new ConversationRepo(dir);
  await repo.init();

  const conv = await repo.create("charA", { userName: "甲", persona: "乙" });
  const after = await repo.setPersona(conv.id, { persona: "丙" });
  assert.equal(after.userName, "甲");
  assert.equal(after.persona, "丙");
});

await t("setPersona 空 body 不改任何东西", async () => {
  const dir = path.join(tmp, "persona-noop");
  const repo = new ConversationRepo(dir);
  await repo.init();

  const conv = await repo.create("charA", { userName: "甲", persona: "乙" });
  const after = await repo.setPersona(conv.id, {});
  assert.equal(after.userName, "甲");
  assert.equal(after.persona, "乙");
});

await t("setPersona 到不存在的对话抛错", async () => {
  const dir = path.join(tmp, "persona-404");
  const repo = new ConversationRepo(dir);
  await repo.init();
  await assert.rejects(() => repo.setPersona("nope", { userName: "x" }));
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log("\n" + "=".repeat(50));
console.log(`通过 ${pass} / 失败 ${fail}`);
console.log("=".repeat(50));
process.exit(fail > 0 ? 1 : 0);
