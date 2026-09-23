// test/regression-pipeline-parity.mjs — 路径一致性回归
//
// 背景：HTTP 路由与 Agent 工具曾各有一套生成逻辑，且已经分叉——
//   路由：宏替换 → activate（世界书引擎）→ 锚点分流 → 历史预算 → 正则
//   工具：getActiveSettings + shouldTrigger（纯子串匹配）
// 结果：通过工具发消息，整轮 C1/C3/C4/D2 全部不生效。
//
// 本测试确保两条路径共用同一条管线。

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { prepareGenerationInput, buildGenerationInput } from "../lib/conversations/pipeline.js";
import { CharacterRepo } from "../lib/characters/repo.js";
import { ConversationRepo } from "../lib/conversations/repo.js";
import { SettingRepo } from "../lib/settings/repo.js";
import { RegexRepo } from "../lib/regex/repo.js";
import { characterBookToSettings } from "../lib/settings/import.js";
import { normalizeCard } from "../lib/characters/formats.js";

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

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tavern-parity-"));

const card = {
  name: "薇拉·霜语",
  description: "{{char}}是北境第七哨塔的守夜法师。",
  personality: "冷静、寡言。",
  scenario: "深夜，{{user}}登上第七塔。",
  first_mes: "「又是你。」{{char}}没有回头。",
  mes_example: "{{user}}: 冷吗？\n{{char}}: 「冷。」",
  system_prompt: "保持{{char}}的说话方式：简短、用「」引述。不要解释设定。",
  character_book: {
    name: "北境",
    entries: [
      { uid: 0, comment: "哨塔", content: "北境哨塔共七座，薇拉守第七塔。", key: ["第七塔", "结界"], position: 0 },
      { uid: 1, comment: "血脉", content: "霜语一族能看见结界裂痕。", key: ["霜语", "血脉"], position: 1 }
    ]
  },
  tags: [], creator: "parity-test"
};

async function freshRepos(sub) {
  const dir = path.join(tmp, sub);
  await fs.mkdir(dir, { recursive: true });
  const characterRepo = new CharacterRepo(dir);
  const conversationRepo = new ConversationRepo(dir);
  const settingRepo = new SettingRepo(dir);
  const regexRepo = new RegexRepo(dir);
  await characterRepo.init();
  await conversationRepo.init();
  await settingRepo.init();
  await regexRepo.init();
  return { characterRepo, conversationRepo, settingRepo, regexRepo };
}

async function seed(repos) {
  const saved = await repos.characterRepo.create(normalizeCard(card));
  await repos.settingRepo.importSettings(characterBookToSettings(saved.character_book));
  const conv = await repos.conversationRepo.create(saved.id);
  await repos.conversationRepo.addMessage(conv.id, "user", "我在塔下看见结界在晃。");
  return { characterId: saved.id, conversationId: conv.id };
}

console.log("\n路径一致性 · 核心断言\n" + "─".repeat(50));

await test("prepareGenerationInput 返回完整输入", async () => {
  const repos = await freshRepos("basic");
  const { conversationId } = await seed(repos);

  const { input } = await prepareGenerationInput(repos, conversationId, "今晚撑得住吗？");
  assert.ok(input.systemPrompt, "应有系统提示");
  assert.ok(Array.isArray(input.messages), "应有消息数组");
  assert.ok(input.meta, "应有 meta");
});

await test("宏替换生效（无 {{ }} 残留）", async () => {
  const repos = await freshRepos("macro");
  const { conversationId } = await seed(repos);

  const { input } = await prepareGenerationInput(repos, conversationId, "你好");
  assert.ok(!/\{\{/.test(input.systemPrompt), `系统提示残留宏: ${input.systemPrompt.slice(0, 80)}`);
  assert.ok(input.systemPrompt.includes("薇拉·霜语"), "char 应替换");
});

await test("世界书引擎生效（不只是子串匹配）", async () => {
  const repos = await freshRepos("lore");
  const { conversationId } = await seed(repos);

  const { input } = await prepareGenerationInput(repos, conversationId, "结界在响");
  assert.ok(input.meta.loreCount > 0, "应激活世界书条目");
  assert.ok(input.systemPrompt.includes("第七塔") || input.systemPrompt.includes("霜语"),
    "世界书内容应进系统提示");
});

await test("世界书副键逻辑生效（引擎特征，非子串匹配）", async () => {
  // 加一条 not_any 副键的条目：主键"结界"命中且副键"安全"未命中时才激活
  const repos = await freshRepos("selective");
  const saved = await repos.characterRepo.create(normalizeCard(card));
  await repos.settingRepo.create({
    name: "危险预警",
    content: "结界的裂痕意味着危险。",
    keywords: ["结界"],
    secondaryKeys: ["安全"],
    selectiveLogic: "not_any",
    enabled: true,
    anchor: "after_char"
  });
  const conv = await repos.conversationRepo.create(saved.id);

  // 副键"安全"未出现 → not_any 通过 → 应激活
  const { input } = await prepareGenerationInput(repos, conv.id, "结界在晃");
  assert.ok(input.systemPrompt.includes("危险"), "not_any 副键应通过");

  // 副键"安全"出现 → not_any 拦截 → 不该激活
  const repos2 = await freshRepos("selective2");
  const saved2 = await repos2.characterRepo.create(normalizeCard(card));
  await repos2.settingRepo.create({
    name: "危险预警",
    content: "结界的裂痕意味着危险。",
    keywords: ["结界"],
    secondaryKeys: ["安全"],
    selectiveLogic: "not_any",
    enabled: true,
    anchor: "after_char"
  });
  const conv2 = await repos2.conversationRepo.create(saved2.id);
  const { input: input2 } = await prepareGenerationInput(repos2, conv2.id, "结界很安全");
  assert.ok(!input2.systemPrompt.includes("裂痕意味着危险"), "not_any 应拦截");
});

await test("锚点分流生效（at_depth 不进系统提示）", async () => {
  const repos = await freshRepos("anchor");
  const saved = await repos.characterRepo.create(normalizeCard(card));
  await repos.settingRepo.create({
    name: "深度设定",
    content: "这段内容应该插进对话历史而不是系统提示。",
    keywords: ["结界"],
    enabled: true,
    anchor: "at_depth"
  });
  const conv = await repos.conversationRepo.create(saved.id);
  await repos.conversationRepo.addMessage(conv.id, "user", "结界在晃");
  await repos.conversationRepo.addMessage(conv.id, "assistant", "「我看看。」");

  const { input } = await prepareGenerationInput(repos, conv.id, "今晚撑得住吗");
  assert.ok(!input.systemPrompt.includes("应该插进对话历史"),
    "at_depth 条目不该出现在系统提示");
  const inHistory = input.messages.some(m => String(m.content).includes("应该插进对话历史"));
  assert.ok(inHistory, "at_depth 条目应插进消息历史");
});

await test("Prompt 面正则生效", async () => {
  const repos = await freshRepos("regex");
  const { conversationId } = await seed(repos);
  await repos.regexRepo.create({
    name: "去括号",
    pattern: "（[^）]*）",
    replacement: "",
    promptOnly: false
  });

  const { input } = await prepareGenerationInput(repos, conversationId, "测试（这段该消失）");
  const all = input.systemPrompt + input.messages.map(m => m.content).join("\n");
  assert.ok(!all.includes("（这段该消失）"), "正则应生效");
});

console.log("\n路径一致性 · 两路同源\n" + "─".repeat(50));

await test("buildGenerationInput 与 prepareGenerationInput 结果一致", async () => {
  const repos = await freshRepos("parity");
  const { conversationId } = await seed(repos);

  const viaPrepare = await prepareGenerationInput(repos, conversationId, "结界在晃");

  // 手动走 buildGenerationInput
  const conv = await repos.conversationRepo.get(conversationId);
  const raw = await repos.characterRepo.get(conv.characterId);
  const { applyMacrosToCharacter } = await import("../lib/conversations/pipeline.js");
  const character = applyMacrosToCharacter(raw, conv);
  const viaBuild = await buildGenerationInput(repos, conv, character, "结界在晃");

  assert.equal(viaPrepare.input.systemPrompt, viaBuild.systemPrompt,
    "两条入口应产出相同系统提示");
  assert.equal(viaPrepare.input.messages.length, viaBuild.messages.length,
    "两条入口应产出相同消息数");
});

await test("工具路径依赖的 prepareGenerationInput 覆盖全部能力", async () => {
  const repos = await freshRepos("toolpath");
  const { conversationId } = await seed(repos);
  await repos.regexRepo.create({ name: "去星号", pattern: "\\*\\*", replacement: "" });

  const { input } = await prepareGenerationInput(repos, conversationId, "**结界**在晃");

  // 一次性验证四件事都生效
  assert.ok(!/\{\{/.test(input.systemPrompt), "① 宏替换");
  assert.ok(input.meta.loreCount > 0, "② 世界书引擎");
  assert.ok(!input.systemPrompt.includes("**"), "③ 正则");
  assert.ok(input.meta.historyBudget > 0, "④ 历史预算");
});

await test("缺对话 / 缺角色时明确报错", async () => {
  const repos = await freshRepos("errors");
  await assert.rejects(
    () => prepareGenerationInput(repos, "nonexistent", "hi"),
    /Conversation not found/
  );
});

await test("无设定库时不崩", async () => {
  const repos = await freshRepos("nolore");
  const saved = await repos.characterRepo.create(normalizeCard(card));
  const conv = await repos.conversationRepo.create(saved.id);

  const { input } = await prepareGenerationInput(repos, conv.id, "你好");
  assert.equal(input.meta.loreCount, 0);
  assert.ok(input.systemPrompt);
});

await fs.rm(tmp, { recursive: true, force: true });

console.log("\n" + "=".repeat(50));
console.log(`通过 ${passed} / 失败 ${failed}`);
console.log("=".repeat(50));
process.exit(failed > 0 ? 1 : 0);
