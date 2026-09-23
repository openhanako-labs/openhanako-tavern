// test/live-verify.mjs — 真实运行验证（不走模型，只验证组装链路）
//
// 目的：用一张**有真实复杂度**的 ST 卡走完整链路，
//       检查组装出来的请求到底长什么样。
//
// 与 integration-e2e 的区别：
//   - 这张卡含宏、世界书、正则、变量、多轮对话
//   - 打印最终请求全文，人眼可读
//   - 断言是"内容层面"的，不是"函数返回值层面"的

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tavern-live-"));

// ── 一张有真实复杂度的卡 ──
const card = {
  name: "薇拉·霜语",
  description: "{{char}}是北境哨塔的守夜法师，银发，左眼有一道旧疤。她说话简短，习惯用「」引述对话。",
  personality: "冷静、寡言、对{{user}}有隐约的旧识感。厌恶寒暄，但会记住{{user}}说过的每一句话。",
  scenario: "深夜，{{user}}登上哨塔。{{char}}正在塔顶维持结界。",
  first_mes: "「又是你。」{{char}}没有回头，指尖的霜花在风里碎开。「这个时辰上山，{{user}}，你不是来看雪的。」",
  mes_example: "{{user}}: 塔顶冷吗？\n{{char}}: 「冷。」她顿了顿，「但结界比冷更要紧。」",
  system_prompt: "保持{{char}}的说话方式：简短、用「」引述。不要主动解释设定。",
  character_book: {
    name: "北境设定",
    entries: [
      {
        uid: 0,
        comment: "哨塔",
        content: "北境哨塔共七座，薇拉守的是最北的第七塔。塔顶结界靠守夜人的体温维持。",
        key: ["哨塔", "第七塔", "塔顶"],
        position: 0
      },
      {
        uid: 1,
        comment: "霜语血脉",
        content: "霜语一族生来能看见结界的裂痕。代价是寿命短暂，且不能离开北境。",
        key: ["霜语", "结界", "血脉"],
        keysecondary: ["离开", "南下"],
        selectiveLogic: 2,
        position: 1
      },
      {
        uid: 2,
        comment: "旧疤",
        content: "薇拉左眼的疤来自三年前的结界崩裂。那一夜她失去了导师。",
        key: ["疤", "左眼"],
        position: 4
      }
    ]
  },
  tags: ["奇幻", "北境", "守夜人"],
  creator: "live-verify"
};

const { normalizeCard } = await import("../lib/characters/formats.js");
const { CharacterRepo } = await import("../lib/characters/repo.js");
const { ConversationRepo } = await import("../lib/conversations/repo.js");
const { SettingRepo } = await import("../lib/settings/repo.js");
const { RegexRepo } = await import("../lib/regex/repo.js");
const { characterBookToSettings } = await import("../lib/settings/import.js");
const { createMacroProcessor, contextFromCharacter } = await import("../lib/macros/index.js");
const { activate, renderEntries, groupByAnchor } = await import("../lib/lore/index.js");
const { prepareHistory, allocateBudget, estimateTokens } = await import("../lib/llm/history.js");

// ── 建仓 ──
const charRepo = new CharacterRepo(tmp);
const convRepo = new ConversationRepo(tmp);
const setRepo = new SettingRepo(tmp);
const regexRepo = new RegexRepo(tmp);
await charRepo.init();
await convRepo.init();
await setRepo.init();
await regexRepo.init();

console.log("=".repeat(64));
console.log("真实运行验证 · 全链路");
console.log("=".repeat(64));

// ── 1. 导入卡 ──
const normalized = normalizeCard(card);
const saved = await charRepo.create(normalized);
console.log(`\n[1] 导入角色卡: ${saved.name}  (id=${saved.id.slice(0, 8)}…)`);

// ── 2. 卡内世界书入库 ──
const settings = characterBookToSettings(saved.character_book);
await setRepo.importSettings(settings);
console.log(`[2] 卡内世界书 → 设定库: ${settings.length} 条`);
for (const s of settings) {
  console.log(`      · ${s.name}  主键=[${s.keywords}]  副键=[${s.secondaryKeys || []}]  逻辑=${s.selectiveLogic}  锚点=${s.anchor}`);
}

// ── 3. 建对话 + 多轮 ──
const conv = await convRepo.create(saved.id);
const turns = [
  ["user", "我上来了。今晚风大。"],
  ["assistant", "「风一直大。」她没回头，「结界在响，你听见了吗。」"],
  ["user", "听见了。像冰裂的声音。"],
  ["assistant", "「你耳朵还是这么尖。」她终于转过来，左眼的疤在火光里很淡，「上次你走的时候，我说过别再来。」"]
];
for (const [role, content] of turns) {
  await convRepo.addMessage(conv.id, role, content);
}
console.log(`[3] 对话建立: ${turns.length} 轮`);

// ── 4. 加一条正则（Prompt 面）──
await regexRepo.create({
  name: "去掉括号注释",
  pattern: "（[^）]*）",
  replacement: "",
  promptOnly: false
});
await regexRepo.create({
  name: "显示面专用",
  pattern: "她",
  replacement: "**她**",
  promptOnly: true
});
console.log(`[4] 正则规则: ${(await regexRepo.list()).length} 条`);

// ── 5. 模拟一次生成的完整组装 ──
const fresh = await convRepo.get(conv.id);
const rawCard = await charRepo.get(fresh.characterId);
const currentInput = "我想留下来。";

console.log("\n" + "─".repeat(64));
console.log("组装过程");
console.log("─".repeat(64));

// 5a 宏替换
const mp = createMacroProcessor();
const macroCtx = contextFromCharacter(rawCard, { userName: "月曦夜" });
const fields = ["description", "personality", "scenario", "first_mes", "mes_example", "system_prompt"];
const processed = mp.processFields(rawCard, fields, macroCtx);

console.log("\n[5a] 宏替换结果");
console.log(`  system_prompt: ${processed.system_prompt}`);
console.log(`  first_mes:     ${processed.first_mes}`);
const leftover = fields.filter(f => String(processed[f] || "").includes("{{"));
if (leftover.length) {
  console.log(`  ❌ 残留宏字段: ${leftover.join(", ")}`);
} else {
  console.log(`  ✅ 无残留宏`);
}

// 5b 世界书激活
const scanText = [...fresh.messages.map(m => m.content), currentInput].join("\n");
const lore = activate(await setRepo.list(), scanText, { budget: 2000, includeTrace: true });

console.log("\n[5b] 世界书激活");
console.log(`  扫描文本长度: ${scanText.length}`);
console.log(`  激活 ${lore.entries.length} 条:`);
for (const e of lore.entries) {
  console.log(`      · ${e.name}  (depth=${e._depth ?? 0}, 直接=${e._directMatch}, 递归=${e._recursive})`);
}

const anchors = groupByAnchor(lore.entries);
console.log("  按锚点分组:");
for (const [k, v] of Object.entries(anchors)) {
  if (v.length) console.log(`      ${k}: ${v.map(x => x.name).join(", ")}`);
}

// 5c 历史预算
const budget = allocateBudget(8000, { reserveForOutput: 1000 });
const history = prepareHistory(
  fresh.messages.map(m => ({ role: m.role, content: m.content })),
  { maxTokens: budget.history }
);
console.log(`\n[5c] 历史: ${fresh.messages.length} 条 → ${history.messages.length} 条 (丢弃 ${history.dropped}, 摘要=${history.summaryAttached})`);

// 5d 组装系统提示（只用整体前置类锚点）
const { renderEntries: re } = await import("../lib/lore/index.js");
const frontAnchors = ["before_char", "after_char", "an_top", "an_bottom", "example_before", "example_after", "unspecified"];
const frontText = frontAnchors
  .flatMap(k => anchors[k] || [])
  .map(e => String(e.content ?? ""))
  .filter(Boolean)
  .join("\n\n");
const systemPrompt = `${processed.system_prompt}\n\n## 世界设定\n${frontText}`;

// 5e Prompt 面正则
const { applyRules } = await import("../lib/regex/engine.js");
const rules = await regexRepo.listFor({ characterId: fresh.characterId });
const regexed = applyRules(systemPrompt, rules, { surface: "prompt", characterId: fresh.characterId });

console.log(`\n[5e] Prompt 面正则`);
console.log(`  规则命中: ${regexed.applied.length} 条, 失败 ${regexed.failed.length} 条`);

console.log("\n" + "─".repeat(64));
console.log("最终请求");
console.log("─".repeat(64));

console.log("\n=== systemPrompt ===");
console.log(regexed.text);

console.log("\n=== messages ===");
for (const m of history.messages) {
  console.log(`\n[${m.role}]`);
  console.log(m.content);
}

// 5f 按锚点插历史（用真实模块，不重实现）
const { injectByAnchor } = await import("../lib/lore/inject.js");

const anchored = injectByAnchor(history.messages, anchors, 4);
console.log("\n" + "─".repeat(64));
console.log("按锚点插历史后（at_depth 落位）");
console.log("─".repeat(64));
for (let i = 0; i < anchored.messages.length; i++) {
  const m = anchored.messages[i];
  const mark = anchored.injected.some(x => x.at === i) ? "  ← 世界书插在这里" : "";
  console.log(`\n[${i}] ${m.role}${mark}`);
  console.log(m.content.split("\n")[0] + (m.content.includes("\n") ? " …" : ""));
}
console.log(`\n注入记录: ${JSON.stringify(anchored.injected)}`);

const totalTokens = estimateTokens(regexed.text)
  + history.messages.reduce((s, m) => s + estimateTokens(m.content) + 4, 0);

console.log("\n" + "─".repeat(64));
console.log(`估算总 token: ${totalTokens} / 8000 窗口`);
console.log("─".repeat(64));

// ── 断言 ──
const checks = [];
const check = (name, cond, detail = "") => {
  checks.push({ name, ok: !!cond, detail });
};

check("宏全部替换（无 {{ }} 残留）", !/\{\{/.test(regexed.text), regexed.text.match(/\{\{.*?\}\}/)?.[0] || "");
check("system_prompt 含角色说话方式", regexed.text.includes("简短"));
check("before/after_char 进系统提示", regexed.text.includes("霜语"));
check("at_depth 不进系统提示（应该插历史）", !regexed.text.includes("左眼的疤来自三年前"),
  "at_depth 条目落到了系统提示里——锚点分流没生效");
check("user 名替换成功", regexed.text.includes("月曦夜") || processed.first_mes.includes("月曦夜"));
check("历史保留完整（预算充足）", history.messages.length === 4);
check("token 在窗口内", totalTokens < 8000);
check("Prompt 面正则生效（括号注释被去）", !regexed.text.includes("（"));
check("at_depth 条目插进了消息历史",
  anchored.injected.length > 0,
  `注入 ${anchored.injected.length} 条`);
check("插入位置正确（倒数第 4 条 → index 0）",
  anchored.injected[0]?.at === 0,
  `实际 at=${anchored.injected[0]?.at}`);
check("插入内容真的进了目标消息",
  anchored.messages[0].content.includes("左眼的疤来自三年前"),
  anchored.messages[0].content.slice(0, 30));

console.log("\n" + "=".repeat(64));
let ok = 0, bad = 0;
for (const c of checks) {
  console.log(`  ${c.ok ? "✅" : "❌"} ${c.name}${c.detail ? `  → ${c.detail}` : ""}`);
  c.ok ? ok++ : bad++;
}
console.log("=".repeat(64));
console.log(`通过 ${ok} / 失败 ${bad}`);

await fs.rm(tmp, { recursive: true, force: true });
process.exit(bad > 0 ? 1 : 0);
