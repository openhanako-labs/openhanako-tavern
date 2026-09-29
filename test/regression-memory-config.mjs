// test/regression-memory-config.mjs — 记忆面板（S2）
//
// 三格硬编码提到 App 配置：keepRecent / summaryMaxChars / summaryPrompt。
//
// 三条验收：
//   · 未配置 → 所有调用点走仓库现状（buildSummaryInput 默认模板 / SUMMARY_MAX_CHARS / history.js keepRecent=4）
//   · 配置之后：keepRecent / summaryMaxChars / summaryPrompt 都被调用点读到并透下去
//   · summaryPrompt 空串 = 用默认模板（不静默丢弃，也不静默替换）
//
// 加上红线：summary-llm 的默认模板包含三条防编约束的字面量。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  DEFAULTS,
  emptyConfig,
  norm,
  readConfig,
  writeConfig,
  mergeConfig,
  publicConfig,
  configPath
} = await import("../lib/memory/config.js");

const {
  buildSummaryInput,
  SUMMARY_MAX_CHARS,
  DEFAULT_SUMMARY_PROMPT_TEMPLATE
} = await import("../lib/conversations/summary-llm.js");

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 记忆配置（S2） ===\n");

// ── 默认值 ────────────────────────────────────────────

ok("DEFAULTS 与仓库现状一致（改这些默认值就等于改现状）", () => {
  assert.deepEqual(DEFAULTS, { keepRecent: 4, summaryMaxChars: 500, summaryPrompt: "" });
  assert.equal(SUMMARY_MAX_CHARS, 500, "summaryMaxChars 默认对齐 summary-llm 常量");
});

ok("emptyConfig：等价于「什么都没配」", () => {
  const c = emptyConfig();
  assert.deepEqual(c, { keepRecent: 4, summaryMaxChars: 500, summaryPrompt: "" });
});

// ── 归一化 ────────────────────────────────────────────

ok("norm：坏值回默认（不炸，不产出 NaN/Infinity）", () => {
  const c = norm({
    keepRecent: "abc",           // 非数字
    summaryMaxChars: null,       // null
    summaryPrompt: 42            // 非字符串
  });
  assert.equal(c.keepRecent, 4);
  assert.equal(c.summaryMaxChars, 500);
  assert.equal(c.summaryPrompt, "");
});

ok("norm：keepRecent 上下限夹住（min 1 / max 40）", () => {
  assert.equal(norm({ keepRecent: 0 }).keepRecent, 1);
  assert.equal(norm({ keepRecent: 1 }).keepRecent, 1);
  assert.equal(norm({ keepRecent: 40 }).keepRecent, 40);
  assert.equal(norm({ keepRecent: 41 }).keepRecent, 40);
  assert.equal(norm({ keepRecent: -5 }).keepRecent, 1);
});

ok("norm：summaryMaxChars 上下限夹住（min 50 / max 5000）", () => {
  assert.equal(norm({ summaryMaxChars: 10 }).summaryMaxChars, 50);
  assert.equal(norm({ summaryMaxChars: 10000 }).summaryMaxChars, 5000);
  assert.equal(norm({ summaryMaxChars: 250 }).summaryMaxChars, 250);
});

ok("norm：summaryPrompt 超长被截断，不静默丢弃", () => {
  const long = "a".repeat(5000);
  const c = norm({ summaryPrompt: long });
  assert.equal(c.summaryPrompt.length, 4000, "截断到 maxLen 4000");
});

// ── mergeConfig ───────────────────────────────────────

ok("mergeConfig：缺字段 = 不改", () => {
  const prev = { keepRecent: 10, summaryMaxChars: 800, summaryPrompt: "自定义" };
  const next = mergeConfig(prev, { keepRecent: 6 });
  assert.equal(next.keepRecent, 6);
  assert.equal(next.summaryMaxChars, 800);
  assert.equal(next.summaryPrompt, "自定义");
});

ok("mergeConfig：summaryPrompt 空串 = 显式清空（回默认模板）", () => {
  const prev = { summaryPrompt: "旧的自定义" };
  const next = mergeConfig(prev, { summaryPrompt: "" });
  assert.equal(next.summaryPrompt, "");
});

ok("mergeConfig：传非字符串的 summaryPrompt = 回空串", () => {
  const next = mergeConfig({}, { summaryPrompt: 12345 });
  assert.equal(next.summaryPrompt, "");
});

// ── publicConfig 形状 ─────────────────────────────────

ok("publicConfig：带上默认模板原文", () => {
  const pub = publicConfig({ keepRecent: 8, summaryMaxChars: 600, summaryPrompt: "" });
  assert.equal(pub.keepRecent, 8);
  assert.equal(pub.summaryMaxChars, 600);
  assert.equal(pub.summaryPrompt, "");
  assert.equal(pub.summaryPromptIsCustom, false);
  assert.equal(typeof pub.defaultSummaryPromptTemplate, "string");
  assert.ok(pub.defaultSummaryPromptTemplate.length > 100, "默认模板原文不该是空串");
  assert.deepEqual(pub.defaults, DEFAULTS);
});

ok("publicConfig：自定义提示词时 isCustom = true", () => {
  const pub = publicConfig({ summaryPrompt: "· 自定义模板" });
  assert.equal(pub.summaryPromptIsCustom, true);
});

// ── 落盘 ──────────────────────────────────────────────

await okAsync("read/write：写进去再读出来形状不变", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-memory-"));
  try {
    await writeConfig(tmp, { keepRecent: 6, summaryMaxChars: 300, summaryPrompt: "· 测试模板" });
    assert.ok(fs.existsSync(configPath(tmp)), "文件没落盘");
    const r = await readConfig(tmp);
    assert.equal(r.keepRecent, 6);
    assert.equal(r.summaryMaxChars, 300);
    assert.equal(r.summaryPrompt, "· 测试模板");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await okAsync("readConfig：文件不存在时返回默认（不炸）", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-memory-"));
  try {
    const r = await readConfig(tmp);
    assert.deepEqual(r, { keepRecent: 4, summaryMaxChars: 500, summaryPrompt: "" });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 与 summary-llm 的边界：默认模板 ──────────────────

ok("默认模板包含三条防编约束的字面量（红线不动）", () => {
  assert.ok(DEFAULT_SUMMARY_PROMPT_TEMPLATE.includes("只许压缩"), "① 只许压缩");
  assert.ok(DEFAULT_SUMMARY_PROMPT_TEMPLATE.includes("不许新增"), "① 不许新增");
  assert.ok(DEFAULT_SUMMARY_PROMPT_TEMPLATE.includes("不要写成对话"), "② 不写成对话");
  assert.ok(DEFAULT_SUMMARY_PROMPT_TEMPLATE.includes("{maxChars}"), "{maxChars} 占位符");
  assert.ok(DEFAULT_SUMMARY_PROMPT_TEMPLATE.includes("{characterLine}"), "{characterLine} 占位符");
});

ok("buildSummaryInput：不传 summaryPrompt → 用默认模板（一字不动）", () => {
  const r = buildSummaryInput({ name: "测试" }, [{ role: "user", content: "hi" }]);
  // 默认模板填上 maxChars=500、characterName=测试
  const filledDefault = DEFAULT_SUMMARY_PROMPT_TEMPLATE
    .replace(/\{maxChars\}/g, "500")
    .replace(/\{characterName\}/g, "测试")
    .replace(/\{characterLine\}/g, "· 故事里的角色是「测试」");
  assert.equal(r.systemPrompt, filledDefault.trim(), "默认模板填充结果与直填一致");
  assert.equal(r.customPrompt, false);
  assert.equal(r.maxChars, SUMMARY_MAX_CHARS);
});

ok("buildSummaryInput：传 summaryPrompt → 用它（{maxChars} 会被填）", () => {
  const r = buildSummaryInput(
    { name: "测试" },
    [{ role: "user", content: "hi" }],
    { maxChars: 200, summaryPrompt: "压缩到 {maxChars} 字，主角：{characterName}" }
  );
  assert.equal(r.systemPrompt, "压缩到 200 字，主角：测试");
  assert.equal(r.customPrompt, true);
  assert.equal(r.maxChars, 200);
});

ok("buildSummaryInput：summaryPrompt 空串 = 用默认模板（不静默丢弃）", () => {
  const r = buildSummaryInput({ name: "测试" }, [{ role: "user", content: "hi" }], { summaryPrompt: "" });
  assert.equal(r.customPrompt, false);
  assert.ok(r.systemPrompt.includes("只许压缩"), "仍然走默认模板");
});

ok("buildSummaryInput：无角色名时 {characterLine} 整行删除", () => {
  const r = buildSummaryInput(null, [{ role: "user", content: "hi" }], { maxChars: 100 });
  assert.ok(!r.systemPrompt.includes("角色是"), "不出现「角色是」这一行");
  assert.ok(!r.systemPrompt.includes("{characterLine}"), "占位符被替换掉");
  assert.ok(r.systemPrompt.includes("不超过 100 字"), "{maxChars} 仍被填");
});

ok("buildSummaryInput：模板变量原样保留（未替换的其他 {x}）", () => {
  // 用户模板里放了未知占位符——保留原样，不静默
  const r = buildSummaryInput({ name: "测试" }, [], {
    summaryPrompt: "温度 {temperature}，字符 {maxChars}",
    maxChars: 100
  });
  assert.equal(r.systemPrompt, "温度 {temperature}，字符 100");
});

// ── 三条验收 ──────────────────────────────────────────

ok("验收 1：未配置时 summaryMaxChars 走 SUMMARY_MAX_CHARS", () => {
  const r = buildSummaryInput({ name: "测试" }, [{ role: "user", content: "hi" }]);
  assert.equal(r.maxChars, SUMMARY_MAX_CHARS);
});

ok("验收 2：改配置后 summaryMaxChars 传下去生效", () => {
  const r = buildSummaryInput({ name: "测试" }, [{ role: "user", content: "hi" }], { maxChars: 120 });
  assert.equal(r.maxChars, 120);
  assert.ok(r.systemPrompt.includes("不超过 120 字"));
});

ok("验收 3：summaryPrompt 空串 → 用默认模板（不炸，不静默替换）", () => {
  const r = buildSummaryInput({ name: "测试" }, [{ role: "user", content: "hi" }], { summaryPrompt: "" });
  assert.equal(r.customPrompt, false);
  assert.ok(r.systemPrompt.includes("你是剧情压缩器"));
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
