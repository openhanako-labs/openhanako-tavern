// test/verify-p3-e2e.mjs — P3 端到端：走真实 buildGenerationInput，
// 确认角色隔离 / 摘要覆盖数在完整链路上生效，而不只在单测里成立。
//
// 为什么值得单独写：单测验证的是 filterForCharacter 这个纯函数；
// 但"管线真的把它接进去了吗"是另一件事——历史上
// （RED-016：同功能多入口必须共用一条实现）栽过的正是这个坑。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-p3-e2e-"));

const { CharacterRepo } = await import("../lib/characters/repo.js");
const { ConversationRepo } = await import("../lib/conversations/repo.js");
const { SettingRepo } = await import("../lib/settings/repo.js");
const { buildGenerationInput } = await import("../lib/conversations/pipeline.js");
const { stWorldBookToSettings } = await import("../lib/settings/import.js");

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

const charRepo = new CharacterRepo(tmp); await charRepo.init();
const convRepo = new ConversationRepo(tmp); await convRepo.init();
const setRepo = new SettingRepo(tmp); await setRepo.init();

const charA = await charRepo.create({
  name: "阿尔法",
  description: "A 的描述",
  first_mes: "你好",
  tags: ["龙"]
});
const charB = await charRepo.create({
  name: "贝塔",
  description: "B 的描述",
  first_mes: "嗨"
});

// A 的世界书：绑定自己；B 的世界书：绑定自己；加一条全局
await setRepo.importSettings(stWorldBookToSettings({
  entries: [{ comment: "A的私设", content: "只有阿尔法知道的秘密", key: ["龙语"] }]
}));
const aEntries = await setRepo.list();
for (const s of aEntries) s.characterId = charA.id;
await setRepo.update(aEntries[0].id, { characterId: charA.id });

await setRepo.importSettings(stWorldBookToSettings({
  entries: [{ comment: "B的私设", content: "只有贝塔知道的秘密", key: ["龙语"] }]
}));
const bEntries = await setRepo.list();
const bEntry = bEntries.find(s => s.name === "B的私设");
await setRepo.update(bEntry.id, { characterId: charB.id });

await setRepo.importSettings(stWorldBookToSettings({
  entries: [{ comment: "公共设定", content: "大家都知道的规则", key: ["龙语"] }]
}));

const repos = { conversationRepo: convRepo, characterRepo: charRepo, settingRepo: setRepo, regexRepo: null };

const convA = await convRepo.create(charA.id, { userName: "月曦夜", persona: "旅人" });
const convB = await convRepo.create(charB.id, { userName: "月曦夜", persona: "旅人" });

const withInput = async (conv, text) => {
  await convRepo.addMessage(conv.id, "user", text);
  const updated = await convRepo.get(conv.id);
  const character = await charRepo.get(conv.characterId);
  return {
    updated,
    input: await buildGenerationInput(repos, updated, character, text, {
      contextWindow: 32000, maxTokens: 1000
    })
  };
};

console.log("\n=== P3 端到端 · 世界书角色隔离 ===\n");

await t("A 的对话只拿到 A 的私设 + 公共设定", async () => {
  const { input } = await withInput(convA, "说一句龙语");
  assert.equal(input.meta.loreCount, 2, `应激活 2 条，实际 ${input.loreCount ?? input.meta.loreCount}`);
  assert.ok(input.systemPrompt.includes("只有阿尔法知道的秘密"));
  assert.ok(input.systemPrompt.includes("大家都知道的规则"));
  assert.ok(!input.systemPrompt.includes("只有贝塔知道的秘密"), "B 的私设泄漏到 A 了");
});

await t("B 的对话只拿到 B 的私设 + 公共设定", async () => {
  const { input } = await withInput(convB, "说一句龙语");
  assert.equal(input.meta.loreCount, 2);
  assert.ok(input.systemPrompt.includes("只有贝塔知道的秘密"));
  assert.ok(!input.systemPrompt.includes("只有阿尔法知道的秘密"), "A 的私设泄漏到 B 了");
});

await t("激活预览端点看到的与真生成一致（同一条链路）", async () => {
  const conv = await convRepo.get(convA.id);
  const character = await charRepo.get(charA.id);
  // 直接复用管线的激活（这是端点内部做的事），而不是另写一套
  const { activate } = await import("../lib/lore/index.js");
  const { filterForCharacter } = await import("../lib/settings/model.js");
  const { buildScanText } = await import("../lib/conversations/pipeline.js");
  const all = await setRepo.list();
  const scoped = filterForCharacter(all, {
    characterId: conv.characterId,
    characterName: character.name,
    characterTags: character.tags
  });
  const r = activate(scoped, buildScanText(conv, "龙语"), { budget: 2000 });
  assert.equal(r.entries.length, 2);
  const names = r.entries.map(e => e.name).sort();
  assert.deepEqual(names, ["A的私设", "公共设定"]);
});

console.log("\n=== P3 端到端 · 摘要写回 ===\n");

await t("长对话折叠后 meta.summaryPatch 覆盖数与 dropped 一致", async () => {
  const dir = path.join(tmp, "long");
  const c2 = new ConversationRepo(dir); await c2.init();
  const ch = await charRepo.create({ name: "长测", description: "d", first_mes: "h" });

  const conv = await c2.create(ch.id);
  // 40 条长消息，必然触发裁剪（窗口只给 1000 token）
  for (let i = 0; i < 40; i++) {
    await c2.addMessage(conv.id, i % 2 ? "assistant" : "user", `第${i}条` + "内容".repeat(60));
  }
  const updated = await c2.get(conv.id);
  const input = await buildGenerationInput(
    { ...repos, conversationRepo: c2 },
    updated, await charRepo.get(ch.id), "", { contextWindow: 1000, maxTokens: 100 }
  );

  assert.ok(input.meta.droppedMessages > 0, "应折叠了一些");
  const rec = input.meta.summaryPatch;
  assert.ok(rec, "应给出 summaryPatch");
  assert.equal(rec.coveredCount, input.meta.droppedMessages);

  // 落盘后再算一遍：coveredCount 不变 → 复用旧文本，不重压
  await c2.update(conv.id, { summary: rec });
  const again = await c2.get(conv.id);
  const input2 = await buildGenerationInput(
    { ...repos, conversationRepo: c2 },
    again, await charRepo.get(ch.id), "", { contextWindow: 1000, maxTokens: 100 }
  );
  assert.equal(input2.meta.summaryPatch.text, rec.text, "覆盖数没变就不该重算");
});

await t("预算放宽后重新覆盖当前全量（不自带失效文本）", async () => {
  const dir = path.join(tmp, "widen");
  const c3 = new ConversationRepo(dir); await c3.init();
  const ch = await charRepo.create({ name: "宽测", description: "d", first_mes: "h" });

  // 200 条长到任何合理窗口都放不下的对话——宽窗口才有意义
  const conv = await c3.create(ch.id);
  for (let i = 0; i < 200; i++) {
    await c3.addMessage(conv.id, i % 2 ? "assistant" : "user", `第${i}条` + "内容".repeat(120));
  }

  const build = async (ctxWin) => await buildGenerationInput(
    { ...repos, conversationRepo: c3 },
    await c3.get(conv.id), await charRepo.get(ch.id), "",
    { contextWindow: ctxWin, maxTokens: 100 }
  );
  const narrow = await build(4000);
  assert.ok(narrow.meta.droppedMessages > 0);
  await c3.update(conv.id, { summary: narrow.meta.summaryPatch });

  const wide = await build(16000);
  assert.ok(wide.meta.droppedMessages > 0, "宽窗口下仍应折叠");
  assert.ok(wide.meta.droppedMessages < narrow.meta.droppedMessages,
    `宽窗口应丢得更少（${wide.meta.droppedMessages} vs ${narrow.meta.droppedMessages}）`);
  assert.notEqual(wide.meta.summaryPatch.text, narrow.meta.summaryPatch.text,
    "旧摘要盖得比现在还多，必须重算而不是接着拼");
  assert.equal(wide.meta.summaryPatch.coveredCount, wide.meta.droppedMessages);

  // 先落盘 wide 的摘要，再回窄窗口：折叠范围扩大了，应在 wide 的基础上追加
  await c3.update(conv.id, { summary: wide.meta.summaryPatch });
  const back = await build(4000);
  assert.ok(back.meta.droppedMessages >= wide.meta.droppedMessages);
  assert.ok(back.meta.summaryPatch.text.startsWith(wide.meta.summaryPatch.text),
    "折叠范围扩大时应保留之前的摘要并追加");
});

console.log("\n=== P3 端到端 · 人设链路 ===\n");

await t("userName 进宏，persona 进 prompt", async () => {
  const dir = path.join(tmp, "persona");
  const c4 = new ConversationRepo(dir); await c4.init();
  const ch = await charRepo.create({
    name: "人设测",
    description: "{{user}} 是一位访客",
    first_mes: "你好"
  });

  const conv = await c4.create(ch.id, { userName: "月曦夜", persona: "沉默的旅人" });
  // 必须从 c4 读——conv 是 c4 建的，用顶层 convRepo 读不到
  const updated = await c4.get(conv.id);
  const character = await charRepo.get(ch.id);
  const { applyMacrosToCharacter, buildSystemPrompt } = await import("../lib/conversations/pipeline.js");
  const macroed = applyMacrosToCharacter(character, updated, {});

  assert.ok(macroed.description.includes("月曦夜"), "{{user}} 应被替换");
  assert.ok(!macroed.description.includes("{{user}}"));
  assert.ok(!macroed.description.includes("undefined"), "空人设不该变成 undefined");

  const sys = buildSystemPrompt(macroed);
  assert.ok(sys.includes("月曦夜"));
});

await t("人设为空时宏落到 User，不是 undefined", async () => {
  const dir = path.join(tmp, "persona-empty");
  const c5 = new ConversationRepo(dir); await c5.init();
  const ch = await charRepo.create({ name: "空人设", description: "{{user}} 来了", first_mes: "h" });

  const conv = await c5.create(ch.id);   // 不传 userName
  const updated = await c5.get(conv.id);
  const { applyMacrosToCharacter } = await import("../lib/conversations/pipeline.js");
  const macroed = applyMacrosToCharacter(await charRepo.get(ch.id), updated, {});

  assert.ok(macroed.description.includes("User"), `应回退 User，实际: ${macroed.description}`);
  assert.ok(!macroed.description.includes("undefined"));
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log("\n" + "=".repeat(50));
console.log(`通过 ${pass} / 失败 ${fail}`);
console.log("=".repeat(50));
process.exit(fail > 0 ? 1 : 0);
