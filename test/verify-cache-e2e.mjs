// test/verify-cache-e2e.mjs — 端到端验证：签名在真实链路上的带上/不带
//
// 为什么需要这个：
//   单测只证明「函数返回值对」。复核明确要求——跑一次真实链路，
//   看最终发给 provider 的请求里，签名到底在不在。
//
// 这条链路是：对话存储 → buildGenerationInput → toStreamMessages → provider 请求
//
// 五个场景，每个都断言「签名在不在」：
//   1. 正常下一轮           → 应在（这是缓存命中的前提）
//   2. 用户编辑过           → 不该在
//   3. 世界书前缀注入       → 不该在
//   4. 长对话触发裁剪       → 不该在
//   5. 换了模型             → 不该在

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { ConversationRepo } = await import("../lib/conversations/repo.js");
const { CharacterRepo } = await import("../lib/characters/repo.js");
const { SettingRepo } = await import("../lib/settings/repo.js");
const { buildGenerationInput } = await import("../lib/conversations/pipeline.js");
const { toStreamMessages, isRawContentValid } = await import("../lib/llm/service.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 缓存端到端验证 ===\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-e2e-cache-"));
const charRepo = new CharacterRepo(tmp); await charRepo.init();
const convRepo = new ConversationRepo(tmp); await convRepo.init();
const settingRepo = new SettingRepo(tmp); await settingRepo.init();

const repos = { conversationRepo: convRepo, characterRepo: charRepo, settingRepo, regexRepo: null };

/** 模拟一轮生成：把模型返回的原始回合存到消息上。 */
const MODEL_OUTPUT = [
  { type: "reasoning", reasoning: "她该先开口", signature: "rs-1" },
  { type: "text", text: "「你来了。」", textSignature: "sig-1" }
];

async function makeConv(extra = {}) {
  const card = await charRepo.create({
    name: "薇拉", description: "守夜法师", first_mes: "「又是你。」",
    ...extra
  });
  const conv = await convRepo.create(card.id);
  return { card, conv };
}

/** 跑完整链路，返回最终 provider 请求里的 assistant 消息。 */
async function finalAssistantMessages(conv, character, currentInput = "在吗", opts = {}) {
  const input = await buildGenerationInput(repos, conv, character, currentInput, opts);
  const { messages } = toStreamMessages(input.messages, { currentModel: opts.target?.model || null });
  return { messages: messages.filter(m => m.role === "assistant"), input };
}

// ── 场景 1：正常下一轮，签名应带上 ──
await okAsync("场景1 正常下一轮 → 签名带上", async () => {
  const { card, conv } = await makeConv();
  const msg = await convRepo.addMessage(conv.id, "assistant", "「你来了。」");
  await convRepo.setMessageUsage(conv.id, msg.id, {
    rawContent: MODEL_OUTPUT, model: "m-1"
  });

  const fresh = await convRepo.get(conv.id);
  const { messages } = await finalAssistantMessages(fresh, card, "在吗", { target: { model: "m-1" } });

  assert.strictEqual(messages.length, 1);
  const parts = messages[0].content;
  assert.ok(parts.length >= 2, `应回传完整回合，实际 ${parts.length} 段`);
  assert.ok(parts.some(p => p.textSignature === "sig-1"), "签名应带上");
  assert.ok(parts.some(p => p.type === "reasoning"), "推理段应带上");
});

// ── 场景 2：用户编辑过，签名不该带 ──
await okAsync("场景2 用户编辑过 → 签名不带", async () => {
  const { card, conv } = await makeConv();
  const msg = await convRepo.addMessage(conv.id, "assistant", "「你来了。」");
  await convRepo.setMessageUsage(conv.id, msg.id, { rawContent: MODEL_OUTPUT, model: "m-1" });

  await convRepo.editMessage(conv.id, msg.id, "「你终于来了。」");

  const fresh = await convRepo.get(conv.id);
  const { messages } = await finalAssistantMessages(fresh, card, "在吗", { target: { model: "m-1" } });

  const parts = messages[0].content;
  assert.strictEqual(parts.length, 1, "应回退成单段");
  assert.ok(!("textSignature" in parts[0]), "不该带签名");
  assert.strictEqual(parts[0].text, "「你终于来了。」", "内容应是最新编辑的");
});

// ── 场景 3：世界书前缀注入，签名不该带 ──
await okAsync("场景3 世界书前缀注入 → 签名不带", async () => {
  const { card, conv } = await makeConv();
  await settingRepo.create({
    name: "哨塔",
    type: "LOCATION",
    content: "北境哨塔共七座。",
    keywords: ["哨塔"],
    trigger: { type: "keyword", keywords: ["哨塔"] },
    anchor: "at_depth",
    depth: 1,
    enabled: true
  });

  const msg = await convRepo.addMessage(conv.id, "assistant", "「你来了。」");
  await convRepo.setMessageUsage(conv.id, msg.id, { rawContent: MODEL_OUTPUT, model: "m-1" });

  const fresh = await convRepo.get(conv.id);
  // 输入含关键词「哨塔」→ 世界书激活 → 前缀注入到最新消息
  const { messages, input } = await finalAssistantMessages(fresh, card, "哨塔那边怎么样", {
    target: { model: "m-1" }, loreDepth: 1
  });

  const parts = messages[0].content;
  assert.ok(!("textSignature" in parts[0]), "前缀被改写，签名不该带");
  assert.ok(input.meta.loreCount > 0, "世界书应被激活");
});

// ── 场景 4：长对话触发裁剪，签名不该带 ──
await okAsync("场景 4 裁剪触发 → 保留消息的签名不带", async () => {
  const { card, conv } = await makeConv();

  // 塞很多轮，撑爆预算
  for (let i = 0; i < 30; i++) {
    await convRepo.addMessage(conv.id, "user", `第${i}轮的问题`.repeat(20));
    const m = await convRepo.addMessage(conv.id, "assistant", `第${i}轮的回答`.repeat(20));
    await convRepo.setMessageUsage(conv.id, m.id, {
      rawContent: [{ type: "text", text: `第${i}轮的回答`.repeat(20), textSignature: `sig-${i}` }],
      model: "m-1"
    });
  }

  const fresh = await convRepo.get(conv.id);
  // 给一个很小的历史预算，强制裁剪
  const { messages, input } = await finalAssistantMessages(fresh, card, "最后一句", {
    target: { model: "m-1" }, contextWindow: 2000, maxTokens: 100
  });

  assert.ok(input.meta.droppedMessages > 0, `应发生裁剪，实际 dropped=${input.meta.droppedMessages}`);
  for (const m of messages) {
    assert.ok(!("textSignature" in m.content[0]),
      "被裁剪过前缀的消息不该带签名（会命中错误缓存）");
  }
});

// ── 场景 5：换模型，签名不该带 ──
await okAsync("场景5 换模型 → 签名不带", async () => {
  const { card, conv } = await makeConv();
  const msg = await convRepo.addMessage(conv.id, "assistant", "「你来了。」");
  await convRepo.setMessageUsage(conv.id, msg.id, { rawContent: MODEL_OUTPUT, model: "旧模型" });

  const fresh = await convRepo.get(conv.id);
  const { messages } = await finalAssistantMessages(fresh, card, "在吗", {
    target: { model: "新模型" }
  });

  const parts = messages[0].content;
  assert.strictEqual(parts.length, 1, "换模型应回退单段");
  assert.ok(!("textSignature" in parts[0]), "旧模型的签名语义不通，不该带");
});

// ── 场景 6：未裁剪的短对话，签名应保留 ──
await okAsync("场景6 短对话无裁剪 → 签名保留", async () => {
  const { card, conv } = await makeConv();
  await convRepo.addMessage(conv.id, "user", "你好");
  const m = await convRepo.addMessage(conv.id, "assistant", "「你来了。」");
  await convRepo.setMessageUsage(conv.id, m.id, { rawContent: MODEL_OUTPUT, model: "m-1" });

  const fresh = await convRepo.get(conv.id);
  const { input } = await finalAssistantMessages(fresh, card, "在吗", {
    target: { model: "m-1" }, contextWindow: 128000
  });

  assert.strictEqual(input.meta.droppedMessages, 0, "不该裁剪");
  const asst = input.messages.filter(x => x.role === "assistant");
  assert.ok(asst.some(x => x.rawContent), "原始回合应带出");
  assert.ok(asst.every(x => !x._prefixBroken), "未裁剪不该打前缀断点");
});

// ── 场景 7：存储不被污染（_prefixBroken 只作用于本次请求）──
await okAsync("场景7 前缀断点标记不写回存储", async () => {
  const { card, conv } = await makeConv();
  for (let i = 0; i < 20; i++) {
    await convRepo.addMessage(conv.id, "user", "x".repeat(300));
    await convRepo.addMessage(conv.id, "assistant", "y".repeat(300));
  }
  const fresh = await convRepo.get(conv.id);
  await finalAssistantMessages(fresh, card, "尾", { target: { model: "m-1" }, contextWindow: 1500, maxTokens: 100 });

  // 重新从存储读，确认标记没被持久化
  const reread = await convRepo.get(conv.id);
  const polluted = reread.messages.filter(m => m._prefixBroken === true);
  assert.strictEqual(polluted.length, 0, "标记不该写回存储（否则后续轮次永久失效）");
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail > 0 ? 1 : 0);
