// test/integration-e2e.mjs — 端到端集成测试
//
// 验证「导入 ST 卡 → 建对话 → 生成」整条链路真的能跑通。
// 用假 LLM（不发真实请求），但其余全走真实代码路径。

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";

import { CharacterRepo } from "../lib/characters/repo.js";
import { CharacterTransfer } from "../lib/characters/transfer.js";
import { writePngText } from "../lib/characters/png.js";
import { ConversationRepo } from "../lib/conversations/repo.js";
import { SettingRepo } from "../lib/settings/repo.js";
import { characterBookToSettings } from "../lib/settings/import.js";
import { createMacroProcessor, contextFromCharacter } from "../lib/macros/index.js";
import { activate, renderEntries } from "../lib/lore/index.js";
import { prepareHistory, allocateBudget, estimateTokens } from "../lib/llm/history.js";

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

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tavern-e2e-"));

// ── 造一张带世界书的 ST 角色卡 ──
function minimalPng() {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : (c >>> 1);
    table[n] = c;
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, "ascii");
    const body = Buffer.concat([t, data]);
    let crc = -1;
    for (const b of body) crc = (crc >>> 8) ^ table[(crc ^ b) & 0xff];
    const c = Buffer.alloc(4); c.writeUInt32BE((crc ^ -1) >>> 0, 0);
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const stCard = {
  spec: "chara_card_v2",
  spec_version: "2",
  data: {
    name: "银月城的守夜人",
    description: "{{char}}是银月城的守夜人，负责夜间巡逻。",
    personality: "沉默寡言，但{{user}}问话时会回答。",
    scenario: "{{char}}在城墙上遇见了{{user}}。",
    first_mes: "「这么晚了，{{user}}，你来城墙做什么？」",
    mes_example: "{{user}}: 睡不着。\n{{char}}: 那就陪我站一会儿。",
    system_prompt: "保持角色，不要跳出。",
    character_book: {
      name: "银月城设定",
      entries: [
        {
          uid: 0,
          comment: "银月城",
          content: "银月城由议会统治，城墙高百尺。",
          key: ["银月城", "城墙"],
          position: 0
        },
        {
          uid: 1,
          comment: "守夜人守则",
          content: "守夜人不得在值夜时饮酒。",
          key: ["守夜", "巡逻"],
          keysecondary: ["饮酒"],
          selectiveLogic: 2,
          position: 1
        }
      ]
    }
  }
};

console.log("\n端到端 · 导入 ST 卡\n" + "─".repeat(50));

await test("PNG 卡导入 + 头像落盘", async () => {
  const dir = path.join(tmpRoot, "import");
  const repo = new CharacterRepo(dir);
  await repo.init();
  const transfer = new CharacterTransfer(repo);

  const png = await writePngText(minimalPng(), stCard);
  const parsed = await transfer.parseCard(png, true);
  assert.equal(parsed.data.name, "银月城的守夜人");

  // 走 normalizeCard
  const { normalizeCard } = await import("../lib/characters/formats.js");
  const normalized = normalizeCard(parsed);
  assert.equal(normalized.name, "银月城的守夜人");
  assert.ok(normalized.character_book, "character_book 应被保留");

  const saved = await repo.create(normalized);
  await transfer.saveAvatar(saved.id, png, "png");

  const avatar = await transfer.readAvatar(saved.id);
  assert.ok(avatar, "头像应落盘");
  assert.ok(avatar.buffer.equals(png), "头像字节一致");
});

await test("卡内世界书 → 设定库", async () => {
  const dir = path.join(tmpRoot, "book");
  const setRepo = new SettingRepo(dir);
  await setRepo.init();

  const settings = characterBookToSettings(stCard.data.character_book);
  assert.equal(settings.length, 2);

  const result = await setRepo.importSettings(settings);
  assert.equal(result.added, 2);

  const list = await setRepo.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].name, "银月城");
  assert.equal(list[1].selectiveLogic, "not_any", "selectiveLogic 2 → not_any");
});

console.log("\n端到端 · 宏替换\n" + "─".repeat(50));

await test("角色卡全字段宏替换", async () => {
  const mp = createMacroProcessor();
  const { normalizeCard } = await import("../lib/characters/formats.js");
  const card = normalizeCard(stCard);

  const ctx = contextFromCharacter(card, { userName: "月曦夜" });

  const desc = mp.process(card.description, ctx);
  assert.ok(desc.includes("银月城的守夜人"), "char 应替换");
  assert.ok(!desc.includes("{{char}}"), "不该残留字面量");

  const personality = mp.process(card.personality, ctx);
  assert.ok(personality.includes("月曦夜"), "user 应替换");

  const firstMes = mp.process(card.first_mes, ctx);
  assert.ok(firstMes.includes("月曦夜"));
  assert.ok(firstMes.includes("「"), "标点应保留");

  const example = mp.process(card.mes_example, ctx);
  assert.ok(example.includes("月曦夜:"), "示例里的 user 应替换");
  assert.ok(example.includes("银月城的守夜人:"), "示例里的 char 应替换");
});

console.log("\n端到端 · 世界书激活\n" + "─".repeat(50));

await test("对话触发世界书条目", async () => {
  const dir = path.join(tmpRoot, "lore");
  const setRepo = new SettingRepo(dir);
  await setRepo.init();
  await setRepo.importSettings(characterBookToSettings(stCard.data.character_book));

  const settings = await setRepo.list();
  const scanText = "我站在银月城的城墙上，看着夜色。";

  const result = activate(settings, scanText, { budget: 2000 });
  assert.ok(result.entries.length >= 1, `应至少激活 1 条，实际 ${result.entries.length}`);

  const names = result.entries.map(e => e.name);
  assert.ok(names.includes("银月城"), `应激活「银月城」，实际: ${names}`);
});

await test("not_any 副键正确拦截", async () => {
  const dir = path.join(tmpRoot, "lore-notany");
  const setRepo = new SettingRepo(dir);
  await setRepo.init();
  await setRepo.importSettings(characterBookToSettings(stCard.data.character_book));
  const settings = await setRepo.list();

  // 提到"守夜"+"饮酒" → not_any 应拦下
  const blocked = activate(settings, "守夜时饮酒是不对的", { budget: 2000 });
  assert.ok(!blocked.entries.some(e => e.name === "守夜人守则"), "not_any 应拦下");

  // 只提"守夜" → 应激活
  const allowed = activate(settings, "我去守夜了", { budget: 2000 });
  assert.ok(allowed.entries.some(e => e.name === "守夜人守则"), "只命中主键应激活");
});

await test("世界书渲染成注入文本", async () => {
  const dir = path.join(tmpRoot, "render");
  const setRepo = new SettingRepo(dir);
  await setRepo.init();
  await setRepo.importSettings(characterBookToSettings(stCard.data.character_book));
  const settings = await setRepo.list();

  const result = activate(settings, "银月城", { budget: 2000 });
  const text = renderEntries(result.entries);
  assert.ok(text.length > 0, "应渲染出内容");
  assert.ok(text.includes("议会"), "应含条目内容");
});

console.log("\n端到端 · 历史预算\n" + "─".repeat(50));

await test("长对话被裁剪 + 摘要", async () => {
  const conv = new ConversationRepo(path.join(tmpRoot, "hist"));
  await conv.init();
  const c = await conv.create("char-1");

  for (let i = 0; i < 40; i++) {
    await conv.addMessage(c.id, i % 2 ? "assistant" : "user", `第${i}轮对话内容-` + "内容".repeat(50));
  }

  const full = await conv.get(c.id);
  assert.equal(full.messages.length, 40);

  // 40 条约 1270 token；给 800 预算确保触发裁剪
  const budget = allocateBudget(8000, { reserveForOutput: 1000 });
  const prepared = prepareHistory(
    full.messages.map(m => ({ role: m.role, content: m.content })),
    { maxTokens: 800, keepRecent: 4 }
  );

  assert.ok(prepared.dropped > 0, `应裁剪掉部分历史（总 1270 token vs 预算 800）`);
  assert.ok(prepared.messages.length < 40);
  assert.equal(prepared.summaryAttached, true, "应附摘要锚点");
});

await test("预算内对话不被裁剪", async () => {
  const conv = new ConversationRepo(path.join(tmpRoot, "hist-short"));
  await conv.init();
  const c = await conv.create("char-1");
  await conv.addMessage(c.id, "user", "你好");
  await conv.addMessage(c.id, "assistant", "你也好");

  const full = await conv.get(c.id);
  const prepared = prepareHistory(full.messages, { maxTokens: 4000 });
  assert.equal(prepared.dropped, 0);
  assert.equal(prepared.messages.length, 2);
});

console.log("\n端到端 · 完整链路\n" + "─".repeat(50));

await test("导入卡 → 建对话 → 组装请求（全链路）", async () => {
  const dir = path.join(tmpRoot, "full");
  const charRepo = new CharacterRepo(dir);
  const convRepo = new ConversationRepo(dir);
  const setRepo = new SettingRepo(dir);
  await charRepo.init();
  await convRepo.init();
  await setRepo.init();

  // 1. 导入角色卡
  const { normalizeCard } = await import("../lib/characters/formats.js");
  const card = normalizeCard(stCard);
  const saved = await charRepo.create(card);

  // 2. 导入卡内世界书
  await setRepo.importSettings(characterBookToSettings(saved.character_book, {
    source: "character_book"
  }));

  // 3. 建对话
  const conv = await convRepo.create(saved.id);
  await convRepo.addMessage(conv.id, "user", "我在银月城的城墙上巡逻。");
  await convRepo.addMessage(conv.id, "assistant", "「守夜人，今晚很安静。」");

  // 4. 模拟生成前的组装
  const fresh = await convRepo.get(conv.id);
  const rawCard = await charRepo.get(fresh.characterId);

  // 4a. 宏替换角色卡
  const mp = createMacroProcessor();
  const macroCtx = contextFromCharacter(rawCard, { userName: "月曦夜" });
  const processedCard = mp.processFields(
    rawCard,
    ["description", "personality", "scenario", "first_mes", "mes_example", "system_prompt"],
    macroCtx
  );
  assert.ok(!processedCard.description.includes("{{char}}"), "宏应已替换");

  // 4b. 世界书激活
  const settings = await setRepo.list();
  const scanText = fresh.messages.map(m => m.content).join("\n");
  const lore = activate(settings, scanText, { budget: 2000 });
  assert.ok(lore.entries.length > 0, "应激活世界书");

  // 4c. 历史准备
  const budget = allocateBudget(8000, { reserveForOutput: 1000 });
  const history = prepareHistory(
    fresh.messages.map(m => ({ role: m.role, content: m.content })),
    { maxTokens: budget.history }
  );

  // 4d. 组装
  const systemPrompt = `${processedCard.system_prompt}\n\n## 世界设定\n${renderEntries(lore.entries)}`;

  assert.ok(systemPrompt.includes("守夜人"), "系统提示应含角色信息");
  assert.ok(systemPrompt.includes("议会"), "系统提示应含世界书内容");
  assert.ok(!systemPrompt.includes("{{"), "不该残留任何宏");
  assert.ok(history.messages.length >= 2, "历史应保留");

  const totalTokens = estimateTokens(systemPrompt)
    + history.messages.reduce((s, m) => s + estimateTokens(m.content) + 4, 0);
  assert.ok(totalTokens < 8000, `总 token 应在窗口内，实际 ${totalTokens}`);
});

await fs.rm(tmpRoot, { recursive: true, force: true });

console.log("\n" + "=".repeat(50));
console.log(`通过 ${passed} / 失败 ${failed}`);
console.log("=".repeat(50));
process.exit(failed > 0 ? 1 : 0);
