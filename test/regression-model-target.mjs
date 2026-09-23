// test/regression-model-target.mjs — 模型目标选择回归
//
// 真实验证时发现的 bug：resolveTarget 盲选目录第一个，
// 而真实目录第一项是 BAAI/bge-m3（embedding），每次生成必炸。
//
// 真实条目形状（live-probe 实测）：
//   { id, name, provider, input: [...], contextWindow, maxTokens, ... }
//   · 模型标识在 id，不是 model
//   · provider 可能是中文（"新疆幻城"）或带空格（"command code"）

import assert from "node:assert/strict";
import { pickChatTargets } from "../lib/llm/service.js";

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

// 真实目录快照（live-probe 实测，含真实字段）
const REAL_CATALOG = [
  { id: "BAAI/bge-m3", name: "BAAI/Bge M3", provider: "siliconflow", input: ["text"], maxTokens: 16384 },
  { id: "DeepSeek-V4.1-Flash", name: "DeepSeek V4.1 Flash", provider: "新疆幻城", input: ["text", "image"], maxTokens: 65536 },
  { id: "sensenova-6.8-flash-lite", name: "Sensenova", provider: "日日新", input: ["text", "image"], maxTokens: 16384 },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", provider: "日日新", input: ["text"], maxTokens: 8192 },
  { id: "agnes-3.0-flash", name: "Agnes 3.0", provider: "agnes", input: ["text"], maxTokens: 8192 },
  { id: "agnes-video-2.5-flash", name: "Agnes Video", provider: "agnes", input: ["video"], maxTokens: 8192 },
  { id: "agnes-image-2.5-flash", name: "Agnes Image", provider: "agnes", input: ["image"], maxTokens: 8192 },
  { id: "step-5-preview", name: "Step 5", provider: "stepfun", input: ["text"], maxTokens: 16384 },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", provider: "codebuddy-cn", input: ["text"], maxTokens: 8192 },
  { id: "hy3", name: "HY3", provider: "codebuddy-cn", input: ["text"], maxTokens: 8192 },
  { id: "hy4-preview", name: "HY4", provider: "codebuddy-cn", input: ["text"], maxTokens: 8192 },
  { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek", provider: "command code", input: ["text"], maxTokens: 8192 },
  { id: "xiaomi/mimo-v2.6-flash", name: "MiMo", provider: "command code", input: ["text"], maxTokens: 8192 }
];

console.log("\n模型目标选择\n" + "─".repeat(50));

test("真实目录：不选 embedding 模型", () => {
  const targets = pickChatTargets(REAL_CATALOG);
  assert.ok(!targets.some(t => t.model === "BAAI/bge-m3"), "不该选中 embedding");
});

test("真实目录：第一项是 stream-safe 的对话模型", () => {
  const targets = pickChatTargets(REAL_CATALOG);
  assert.ok(targets.length > 0);
  const first = targets[0];
  assert.ok(/^[A-Za-z0-9._:-]{1,128}$/.test(first.model),
    `模型名须 stream-safe，实际: ${first.model}`);
  assert.ok(/^[A-Za-z0-9._:-]{1,128}$/.test(first.provider),
    `provider 须 stream-safe，实际: ${first.provider}`);
});

test("真实目录：中文 / 带空格的 provider 不进首选", () => {
  const targets = pickChatTargets(REAL_CATALOG);
  assert.ok(!targets.some(t => /[^\x00-\x7F]/.test(t.provider)), "非 ASCII provider 不该在首选");
  assert.ok(!targets.some(t => /\s/.test(t.provider)), "带空格 provider 不该在首选");
});

test("真实目录：codebuddy-cn 的模型被保留", () => {
  const targets = pickChatTargets(REAL_CATALOG);
  assert.ok(targets.some(t => t.provider === "codebuddy-cn" && t.model === "deepseek-v4-flash"),
    `应有 codebuddy-cn 候选，实际: ${targets.map(t => `${t.provider}/${t.model}`).join(", ")}`);
});

test("真实目录：视频 / 图像模型被排除", () => {
  const targets = pickChatTargets(REAL_CATALOG);
  assert.ok(!targets.some(t => t.model.includes("video")));
  assert.ok(!targets.some(t => t.model.includes("image")));
});

test("input 只有非 text → 排除", () => {
  const targets = pickChatTargets([
    { id: "vision-only", provider: "p", input: ["image"], maxTokens: 4096 },
    { id: "chat", provider: "p", input: ["text"], maxTokens: 4096 }
  ]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].model, "chat");
});

test("maxTokens: null → 排除", () => {
  const targets = pickChatTargets([
    { id: "emb", provider: "p", maxTokens: null },
    { id: "chat", provider: "p", maxTokens: 4096 }
  ]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].model, "chat");
});

test("模型标识从 id 读取（不是 model）", () => {
  const targets = pickChatTargets([
    { id: "real-id", name: "显示名", provider: "p", input: ["text"], maxTokens: 4096 }
  ]);
  assert.equal(targets[0].model, "real-id", "应从 id 取模型标识");
});

test("全是非对话模型时退回原列表（不完全不可用）", () => {
  const targets = pickChatTargets([
    { id: "BAAI/bge-m3", provider: "siliconflow", maxTokens: 16384 }
  ]);
  assert.equal(targets.length, 1, "至少给一个可尝试的");
});

test("空目录 / null 安全", () => {
  assert.deepEqual(pickChatTargets([]), []);
  assert.deepEqual(pickChatTargets(null), []);
});

test("缺 provider 或 model 的条目被丢弃", () => {
  assert.equal(pickChatTargets([{ provider: "p" }, { id: "m" }, {}]).length, 0);
});

test("多键兼容（providerId / modelId）", () => {
  const targets = pickChatTargets([
    { providerId: "p1", modelId: "m1", maxTokens: 4096 },
    { provider_id: "p2", model_id: "m2", maxTokens: 4096 }
  ]);
  assert.equal(targets.length, 2);
  assert.equal(targets[0].provider, "p1");
  assert.equal(targets[0].model, "m1");
});

console.log("\n" + "=".repeat(50));
console.log(`通过 ${passed} / 失败 ${failed}`);
console.log("=".repeat(50));
process.exit(failed > 0 ? 1 : 0);
