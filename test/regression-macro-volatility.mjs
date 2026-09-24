// test/regression-macro-volatility.mjs — 一次性宏不该在历史里重掷（黄金断言）
//
// 这一条抓的是一类**看不见的错**：它不报错、不崩、日志干净，
// 只是同一个事实每次读出来都不一样。
//
//   · `{{roll 1d100}}` 用 Math.random()，而助手消息是**原样落盘**的，
//     历史在每次装配时又会重新过一遍宏处理器。
//     → 上一轮掷出的 42，这一轮变成 7。
//   · 更伤的是它连带的：历史逐字节在变 → provider 侧的前缀签名对不上
//     → 缓存命中率被一条早已发生的骰子持续吃掉。
//
// 这不是"理论上可能"：仓库里那几本 ST 世界书（《通用战斗系统》等）
// 写的就是 `{{roll 1d20+AGI}}` 这类用法，模型会照做。
//
// 修法不是「让随机数稳定」，而是承认一句更简单的话：
// **掷骰在它发生的那一刻结算，之后它是事实。**
// 所以冻结点是**落盘**（routes 与工具两条路径都要），不是读取。
//
// 于是这一份测试必须**穿过路由**测——直接把消息写进仓储再断言稳定，
// 测的就不是修好的那条路（第一版就是这么写歪的）。

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeApp, request } from "./lib/route-harness.mjs";

const { ConversationRepo } = await import("../lib/conversations/repo.js");
const { CharacterRepo } = await import("../lib/characters/repo.js");
const { SettingRepo } = await import("../lib/settings/repo.js");
const { buildGenerationInput, applyMacrosToCharacter, freezeVolatileMacros } =
  await import("../lib/conversations/pipeline.js");
const { registerConversationRoutes } = await import("../lib/conversations/routes.js");
const { createConversationTools } = await import("../lib/probe/tools.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 一次性宏的稳定性 ===\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-volatile-"));
const charRepo = new CharacterRepo(tmp); await charRepo.init();
const convRepo = new ConversationRepo(tmp); await convRepo.init();
const settingRepo = new SettingRepo(tmp); await settingRepo.init();

const repos = { conversationRepo: convRepo, characterRepo: charRepo, settingRepo, regexRepo: null };

const DICE_REPLY = "我掷了 {{roll 1d100}}。";

const fakeLlm = {
  available: true,
  lastTarget: { model: "fake-model" },
  resolveContextWindow: async () => 32000,
  generate: async () => ({ content: DICE_REPLY, usage: { prompt_tokens: 10, completion_tokens: 5 } })
};

const app = makeApp();
registerConversationRoutes(app, convRepo, fakeLlm, charRepo, settingRepo, null, null, null);

const card = await charRepo.create({ name: "薇拉", description: "守夜法师", first_mes: "「又是你。」" });
const conv = await convRepo.create(card.id);

async function buildText(input) {
  await convRepo.addMessage(conv.id, "user", input);
  const fresh = await convRepo.get(conv.id);
  return buildGenerationInput(repos, fresh, card, input, {});
}

// ── 1. 单元：只碰含一次性宏的文本 ──
await okAsync("freezeVolatileMacros：一次性宏结算，普通文本原样通过", () => {
  const frozen = freezeVolatileMacros("我掷了 {{roll 1d100}}。", card, conv);
  assert.ok(!/\{\{/.test(frozen), `还留着宏：${frozen}`);
  assert.match(frozen, /^我掷了 \d+。$/, `形状不对：${frozen}`);

  // 不含一次性宏的文本**必须原样返回**：行为与从前一模一样。
  // （{{char}}/{{user}}/变量这些本来就与读取时刻无关，不该被这次改动波及。）
  const untouched = "你好 {{char}}，我是 {{user}}。";
  assert.strictEqual(freezeVolatileMacros(untouched, card, conv), untouched);

  // 没有宏的普通消息也不动
  assert.strictEqual(freezeVolatileMacros("普通一句话。", card, conv), "普通一句话。");
});

// ── 2. 穿过路由：落盘时就结算 ──
await okAsync("路由落盘的助手消息里，骰子已经结算（文本里没有可掷的东西）", async () => {
  const r = await request(app, "POST", `/conversations/${conv.id}/messages`, {
    body: { content: "我上来了。" }
  });
  assert.ok(r, "生成路由没匹配上");
  assert.strictEqual(r.status, 200, `实为 ${r.status}（${r.error || ""}）`);

  const fresh = await convRepo.get(conv.id);
  const stored = fresh.messages.find(m => m.role === "assistant");
  assert.ok(stored, "助手消息没落盘");
  assert.ok(!stored.content.includes("{{"), `落盘的内容还带着宏：${stored.content}`);
  assert.match(stored.content, /^我掷了 \d+。$/, `形状不对：${stored.content}`);
});

// ── 3. 结算之后，历史逐字节稳定 ──
await okAsync("结算之后：两次装配的历史逐字节相同", async () => {
  const a = await buildText("然后呢？");
  const b = await buildText("继续。");
  const hist = (r) => (r.messages || []).map(m => String(m.content || "")).filter(c => c.includes("我掷了"));
  assert.ok(hist(a).length > 0, "历史里找不到那条消息");
  assert.deepStrictEqual(hist(a), hist(b), "同一条历史消息的字节在两次装配之间变了——骰子又重掷了");
});

// ── 4. 工具路径同样冻结（两条路径不许分叉） ──
await okAsync("工具路径落盘的助手消息也冻结", async () => {
  const toolConv = await convRepo.create(card.id);
  const tools = createConversationTools({
    conversationRepo: convRepo,
    characterRepo: charRepo,
    settingRepo,
    llmService: fakeLlm,
    regexRepo: null,
    boardRepo: null
  });
  const send = tools.find(t => String(t.name || "").includes("send"));
  assert.ok(send, `没找到发消息工具（实有：${tools.map(t => t.name).join(", ")}）`);

  await send.execute({ conversationId: toolConv.id, content: "在吗？" });

  const fresh = await convRepo.get(toolConv.id);
  const stored = fresh.messages.find(m => m.role === "assistant");
  assert.ok(stored, "工具路径没落盘助手消息");
  assert.ok(!stored.content.includes("{{"), `工具路径落盘的内容还带着宏：${stored.content}`);
});

// ── 5. 已知问题（待定）：卡字段里的 volatile 宏每轮重算 ──
//
// 这一条**断的是现状**，不是期望——所以留着它是有意的：
// 它在测试套件里占一个显眼的位置，好过只躺在某次对话记录里。
//
// 现状：applyMacrosToCharacter 在每次请求时跑，卡字段里的 {{roll}}/{{time}}
// 于是在每一轮重算 → **静态前缀每轮都变 → prefix cache 永远不可能命中**。
//
// 修法要定一个产品问题（不是技术问题）：
//   `{{time}}` 在一个会话里该不该刷新？
//     刷新 → 前缀不稳，缓存白给
//     冻住 → 一个长会话里时钟停在开场那一刻
// 我倾向「按会话冻结」（一处按会话缓存已处理的卡字段，卡变了才失效），
// 但那是个会改变体感的选择，得由人来定。定完之后把下面这条断言翻过来。
await okAsync("（已知问题）卡字段里的 volatile 宏目前每轮重算", async () => {
  const wild = await charRepo.create({
    name: "掷骰者",
    description: "她的编号是 {{roll 1d1000}}。",
    first_mes: "「你来了。」"
  });
  const c2 = await convRepo.create(wild.id);
  const one = await convRepo.get(c2.id);

  const a = await buildGenerationInput(repos, one, applyMacrosToCharacter(wild, one, {}), "一。", {});
  const b = await buildGenerationInput(repos, one, applyMacrosToCharacter(wild, one, {}), "二。", {});

  assert.notStrictEqual(
    a.systemPrompt,
    b.systemPrompt,
    "现状变了（转为稳定）——那是好事：把这条断言翻成 strictEqual，并把上面的注释改成「已修」"
  );
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
