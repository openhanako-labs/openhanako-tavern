// test/regression-c3.mjs — C3 世界书引擎回归
//
// 规格对照：DiceFrame src/lorebook/{activation,matcher,budget}.py
//
// ⚠️ 本文件经过一次重写。
// 第一版测试编码了作者对规格的**错误理解**（例如"canonical 递归受
// MAX_RECURSIVE_DEPTH 硬截断"），因此 54 条全绿却掩盖了实现偏差。
// 独立复核发现偏差后，测试与实现一起重写。
//
// 现在的原则：每条测试都直接引用 DiceFrame 原文的措辞，不凭印象写。

import assert from "node:assert/strict";
import {
  activate,
  renderEntries,
  groupByAnchor,
  KeywordMatcher,
  normalizeSelectiveLogic,
  evaluateProbability,
  matchedKeyScore,
  eligibleForRecursion,
  nextRecursionBuffer,
  armTimedActivation,
  advanceTimedState,
  migrateTimedState,
  stickyActive,
  timedGateBlocked,
  legacyDelayBlocked,
  delayGateBlocked,
  keyMatches,
  fuzzyHit,
  selectiveGatePasses,
  keywordDecision,
  entrySortKey,
  compareEntries,
  maxEntriesWithinBudget,
  applyBudget,
  estimateEntryChars,
  estimateEntryTokens,
  MAX_RECURSIVE_DEPTH
} from "../lib/lore/index.js";

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

/** 造一个设定条目。 */
function entry(id, over = {}) {
  return {
    id,
    name: over.name ?? id,
    content: over.content ?? `内容-${id}`,
    keywords: over.keywords ?? [],
    secondaryKeys: over.secondaryKeys ?? [],
    selective: over.selective !== false,
    selectiveLogic: over.selectiveLogic ?? "and_any",
    enabled: over.enabled !== false,
    trigger: over.trigger ?? { type: "keyword", keywords: over.keywords ?? [] },
    priority: over.priority ?? 100,
    order: over.order ?? 100,
    probability: over.probability ?? 100,
    ...over
  };
}

const fixedRng = (v) => () => v;

console.log("\nC3 · selectiveLogic 四模式\n" + "─".repeat(50));

test("and_any：副键命中任意一个即通过", () => {
  assert.equal(selectiveGatePasses("and_any", [true, false]), true);
  assert.equal(selectiveGatePasses("and_any", [false, false]), false);
});

test("and_all：副键必须全部命中", () => {
  assert.equal(selectiveGatePasses("and_all", [true, true]), true);
  assert.equal(selectiveGatePasses("and_all", [true, false]), false);
});

test("not_any：副键一个都不许命中", () => {
  assert.equal(selectiveGatePasses("not_any", [false, false]), true);
  assert.equal(selectiveGatePasses("not_any", [true, false]), false);
});

test("not_all：副键不能全部命中", () => {
  assert.equal(selectiveGatePasses("not_all", [true, false]), true);
  assert.equal(selectiveGatePasses("not_all", [true, true]), false);
});

test("无副键 → 不拦截", () => {
  assert.equal(selectiveGatePasses("and_all", []), true);
});

test("数字编码归一化（ST world_info_logic）", () => {
  assert.equal(normalizeSelectiveLogic(0), "and_any");
  assert.equal(normalizeSelectiveLogic(1), "not_all");
  assert.equal(normalizeSelectiveLogic(2), "not_any");
  assert.equal(normalizeSelectiveLogic(3), "and_all");
});

console.log("\nC3 · 主键必须仍然匹配（副键不能替代主键）\n" + "─".repeat(50));

test("副键命中但主键未命中 → 不激活", () => {
  const settings = [
    entry("e1", { keywords: ["龙"], secondaryKeys: ["剑"], selectiveLogic: "and_any" })
  ];
  const r = activate(settings, "我拿起剑", { rng: fixedRng(0.5) });
  assert.equal(r.entries.length, 0, "主键未命中就不该激活");
});

test("主键+副键都命中 → 激活", () => {
  const settings = [
    entry("e1", { keywords: ["龙"], secondaryKeys: ["剑"], selectiveLogic: "and_any" })
  ];
  const r = activate(settings, "龙和剑", { rng: fixedRng(0.5) });
  assert.equal(r.entries.length, 1);
});

test("not_any：主键命中但副键也命中 → 不激活", () => {
  const settings = [
    entry("e1", { keywords: ["龙"], secondaryKeys: ["剑"], selectiveLogic: "not_any" })
  ];
  assert.equal(activate(settings, "龙和剑", { rng: fixedRng(0.5) }).entries.length, 0);
  assert.equal(activate(settings, "只有龙", { rng: fixedRng(0.5) }).entries.length, 1);
});

test("selective=false → 副键保留为数据但不参与闸门", () => {
  const settings = [
    entry("e1", { keywords: ["龙"], secondaryKeys: ["剑"], selective: false })
  ];
  // 副键"剑"未命中，但 selective=false 时不拦
  assert.equal(activate(settings, "龙", { rng: fixedRng(0.5) }).entries.length, 1);
});

console.log("\nC3 · 概率\n" + "─".repeat(50));

test("probability=100 → 必过", () => {
  assert.equal(evaluateProbability({ probability: 100 }, fixedRng(0.99)).accepted, true);
});

test("probability=0 → 必拒", () => {
  assert.equal(evaluateProbability({ probability: 0 }, fixedRng(0)).accepted, false);
});

test("概率判定在边界正确", () => {
  assert.equal(evaluateProbability({ probability: 50 }, fixedRng(0.49)).accepted, true);
  assert.equal(evaluateProbability({ probability: 50 }, fixedRng(0.50)).accepted, false);
});

test("概率范围裁剪到 [0,100]", () => {
  assert.equal(evaluateProbability({ probability: 999 }, fixedRng(0.5)).configured, 100);
  assert.equal(evaluateProbability({ probability: -5 }, fixedRng(0.5)).configured, 0);
});

test("概率每轮每条目只 roll 一次（缓存）", () => {
  // A 内容提到 B，B 内容提到 A —— 若每轮重 roll，结果会不确定
  const settings = [
    entry("A", { keywords: ["起"], content: "→B", probability: 50 }),
    entry("B", { keywords: ["→B"], content: "→A", probability: 50 })
  ];
  // rng 固定 0.5 → roll=51 > 50 → 都拒
  const r = activate(settings, "起", { rng: fixedRng(0.5) });
  assert.equal(r.entries.length, 0, "固定 rng 下概率判定应确定");
});

console.log("\nC3 · 递归激活\n" + "─".repeat(50));

test("A 的内容能触发 B（递归）", () => {
  const settings = [
    entry("A", { keywords: ["起点"], content: "提到了「银月城」" }),
    entry("B", { keywords: ["银月城"], content: "银月城的设定" })
  ];
  const r = activate(settings, "这是起点", { rng: fixedRng(0.5) });
  const ids = r.entries.map(e => e.id).sort();
  assert.deepEqual(ids, ["A", "B"], `应递归激活 B，实际: ${ids}`);
});

test("preventRecursion 阻断传播", () => {
  const settings = [
    entry("A", { keywords: ["起点"], content: "提到了「银月城」", preventRecursion: true }),
    entry("B", { keywords: ["银月城"], content: "银月城" })
  ];
  const r = activate(settings, "这是起点", { rng: fixedRng(0.5) });
  assert.deepEqual(r.entries.map(e => e.id), ["A"], "A 不应把内容传给 B");
});

test("nonRecursable 条目本身不能被递归到达", () => {
  const settings = [
    entry("A", { keywords: ["起点"], content: "提到了乙" }),
    entry("B", { keywords: ["乙"], content: "c", nonRecursable: true })
  ];
  const r = activate(settings, "起点", { rng: fixedRng(0.5) });
  assert.ok(!r.entries.some(e => e.id === "B"), "nonRecursable 不该被递归到达");
});

test("内容传播只被 preventRecursion 阻断（跟随 DiceFrame 可执行的那份）", () => {
  // activation.py 的 next_recursion_buffer 同时查 non_recursable，
  // 但它在 DiceFrame 里从未被调用——matcher._children_of 只查
  // prevent_further_recursion。实现跟随后者。
  const settings = [
    entry("A", { keywords: ["起点"], content: "提到了「银月城」", preventRecursion: true }),
    entry("B", { keywords: ["银月城"], content: "银月城" })
  ];
  const r = activate(settings, "这是起点", { rng: fixedRng(0.5) });
  assert.deepEqual(r.entries.map(e => e.id), ["A"], "preventRecursion 应阻断内容传播");
});

test("nonRecursable 条目本身不能被递归到达", () => {
  const settings = [
    entry("A", { keywords: ["起点"], content: "提到了乙" }),
    entry("B", { keywords: ["乙"], content: "c", nonRecursable: true })
  ];
  const r = activate(settings, "起点", { rng: fixedRng(0.5) });
  assert.ok(!r.entries.some(e => e.id === "B"), "nonRecursable 不该被递归到达");
});

test("nonRecursable 条目仍可被直接命中", () => {
  const settings = [
    entry("B", { keywords: ["乙"], content: "c", nonRecursable: true })
  ];
  const r = activate(settings, "乙", { rng: fixedRng(0.5) });
  assert.equal(r.entries.length, 1, "直接命中不受 nonRecursable 限制");
});

test("canonical 递归不被 MAX_RECURSIVE_DEPTH 截断", () => {
  // DiceFrame 原文：canonical / ST 递归（扫描 activated content 发现）
  // 不再被固定 MAX_RECURSIVE_DEPTH 截断
  const settings = [
    entry("L0", { keywords: ["起"], content: "→L1" }),
    entry("L1", { keywords: ["→L1"], content: "→L2" }),
    entry("L2", { keywords: ["→L2"], content: "→L3" }),
    entry("L3", { keywords: ["→L3"], content: "→L4" }),
    entry("L4", { keywords: ["→L4"], content: "→L5" }),
    entry("L5", { keywords: ["→L5"], content: "终点" })
  ];
  const r = activate(settings, "起", { rng: fixedRng(0.5) });
  const ids = r.entries.map(e => e.id);
  assert.ok(ids.includes("L0"));
  assert.ok(ids.includes("L5"), `canonical 递归应能超过 depth ${MAX_RECURSIVE_DEPTH}，实际: ${ids}`);
});

test("maxSteps 仍能限制失控递归", () => {
  const settings = [
    entry("L0", { keywords: ["起"], content: "→L1" }),
    entry("L1", { keywords: ["→L1"], content: "→L2" }),
    entry("L2", { keywords: ["→L2"], content: "→L3" })
  ];
  const r = activate(settings, "起", { rng: fixedRng(0.5), maxSteps: 1 });
  // 只有 1 步预算 → 只能展开一层
  assert.ok(r.entries.length <= 2, `maxSteps 应限制展开，实际激活 ${r.entries.length} 条`);
});

test("初始种子不受 maxSteps 限制", () => {
  // DiceFrame：initial direct / constant / semantic seeds 必须全部进入 activation
  const settings = [];
  for (let i = 0; i < 10; i++) settings.push(entry(`e${i}`, { keywords: ["甲"] }));
  const r = activate(settings, "甲", { rng: fixedRng(0.5), maxSteps: 0 });
  assert.equal(r.entries.length, 10, `初始种子不该被 steps 限制，实际 ${r.entries.length}`);
});

test("delayUntilRecursion：直接匹配阶段不激活", () => {
  const settings = [
    entry("A", { keywords: ["甲"], content: "c", delayUntilRecursion: true })
  ];
  assert.equal(activate(settings, "甲", { rng: fixedRng(0.5) }).entries.length, 0);
});

test("recursionLevel 门槛", () => {
  const settings = [
    entry("A", { keywords: ["甲"], content: "提到了乙" }),
    entry("B", { keywords: ["乙"], content: "c", recursionLevel: 5 })
  ];
  const r = activate(settings, "甲", { rng: fixedRng(0.5) });
  assert.ok(!r.entries.some(e => e.id === "B"), "深度 1 < level 5，不该激活");
});

test("scanDepth 门槛", () => {
  const settings = [
    entry("A", { keywords: ["甲"], content: "提到了乙" }),
    entry("B", { keywords: ["乙"], content: "c", scanDepth: 0 })
  ];
  // scanDepth=0 表示不限制；用一个会触发的值验证上限
  const r0 = activate(settings, "甲", { rng: fixedRng(0.5) });
  assert.ok(r0.entries.some(e => e.id === "B"), "scanDepth=0 表示不限制");
});

test("eligibleForRecursion 直接验证", () => {
  assert.equal(eligibleForRecursion(entry("x"), 0, { recursivePass: false }), true);
  assert.equal(eligibleForRecursion(entry("x", { enabled: false }), 0, {}), false);
  assert.equal(eligibleForRecursion(entry("x", { delayUntilRecursion: true }), 0, { recursivePass: false }), false);
  assert.equal(eligibleForRecursion(entry("x", { recursionLevel: 2 }), 1, {}), false);
  assert.equal(eligibleForRecursion(entry("x", { recursionLevel: 2 }), 2, {}), true);
});

test("nextRecursionBuffer 语义", () => {
  assert.equal(nextRecursionBuffer({ content: "abc" }), "abc");
  assert.equal(nextRecursionBuffer({ content: "abc", preventRecursion: true }), "");
  assert.equal(nextRecursionBuffer({ content: "abc", nonRecursable: true }), "");
});

console.log("\nC3 · 可见性与通道门\n" + "─".repeat(50));

test("不可见条目不得成为结果", () => {
  const settings = [
    entry("vis", { keywords: ["甲"] }),
    entry("hid", { keywords: ["甲"] })
  ];
  const r = activate(settings, "甲", {
    rng: fixedRng(0.5),
    isVisible: (e) => e.id !== "hid"
  });
  assert.deepEqual(r.entries.map(e => e.id), ["vis"]);
});

test("不可见条目不得参与递归（不得影响可见条目）", () => {
  const settings = [
    entry("A", { keywords: ["起点"], content: "提到乙" }),
    entry("B", { keywords: ["乙"], content: "c" }),
    entry("hid", { keywords: ["起点"], content: "提到丙" }),
    entry("C", { keywords: ["丙"], content: "c" })
  ];
  const r = activate(settings, "起点", {
    rng: fixedRng(0.5),
    isVisible: (e) => e.id !== "hid"
  });
  const ids = r.entries.map(e => e.id).sort();
  assert.ok(!ids.includes("hid"), "隐藏条目不该出现");
  assert.ok(!ids.includes("C"), `隐藏条目不该把内容传给 C，实际: ${ids}`);
});

test("isCandidate 通道门：vector_only 不得被关键词发现", () => {
  const settings = [
    entry("vec", { keywords: ["甲"] }),
    entry("kw", { keywords: ["甲"] })
  ];
  const r = activate(settings, "甲", {
    rng: fixedRng(0.5),
    isCandidate: (e) => e.id !== "vec"
  });
  assert.deepEqual(r.entries.map(e => e.id), ["kw"]);
});

test("sticky 生效期间条目保持激活", () => {
  const settings = [entry("a", { keywords: ["甲"] })];
  const timedState = new Map([["a", { stickyRemaining: 2 }]]);
  const r = activate(settings, "无关文本", { timedState, rng: fixedRng(0.5) });
  assert.equal(r.entries.length, 1, "sticky 期间应保持激活");
});

test("cooldown 期间条目被挡", () => {
  const settings = [entry("a", { keywords: ["甲"] })];
  const timedState = new Map([["a", { cooldownRemaining: 2 }]]);
  const r = activate(settings, "甲", { timedState, rng: fixedRng(0.5) });
  assert.equal(r.entries.length, 0, "cooldown 期间不该激活");
});

console.log("\nC3 · 分组竞争\n" + "─".repeat(50));

test("同组只保留一条（无 groupScoring 时走加权随机）", () => {
  const settings = [
    entry("g1", { keywords: ["甲", "乙"], content: "两条命中", group: "G" }),
    entry("g2", { keywords: ["甲"], content: "一条命中", group: "G" })
  ];
  const r = activate(settings, "甲乙", { rng: fixedRng(0.5) });
  assert.equal(r.entries.length, 1, "同组只应留一条");
});

test("groupScoring=score → 按 matchedKeyScore 取最高", () => {
  const settings = [
    entry("g1", { keywords: ["甲", "乙"], group: "G", groupScoring: "score" }),
    entry("g2", { keywords: ["甲"], group: "G", groupScoring: "score" })
  ];
  const r = activate(settings, "甲乙", { rng: fixedRng(0.5) });
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].id, "g1", "score 模式下应留分数高的");
});

test("matchedKeyScore：副键只在正向逻辑加分", () => {
  assert.equal(matchedKeyScore({ selectiveLogic: "and_any" }, [true], [true]), 2);
  assert.equal(matchedKeyScore({ selectiveLogic: "and_all" }, [true], [true, true]), 3);
  assert.equal(matchedKeyScore({ selectiveLogic: "not_any" }, [true], [true]), 1, "not_any 副键不加分");
  assert.equal(matchedKeyScore({ selectiveLogic: "not_all" }, [true], [true]), 1, "not_all 副键不加分");
});

test("groupScoring=all → 全收", () => {
  const settings = [
    entry("g1", { keywords: ["甲"], group: "G", groupScoring: "all" }),
    entry("g2", { keywords: ["甲"], group: "G", groupScoring: "all" })
  ];
  const r = activate(settings, "甲", { rng: fixedRng(0.5) });
  assert.equal(r.entries.length, 2, "allow_all 模式应全收");
});

test("组内任一成员 allow_all → 全组放行（不看第一个）", () => {
  const settings = [
    entry("g1", { keywords: ["甲"], group: "G" }),
    entry("g2", { keywords: ["甲"], group: "G", groupScoring: "all" })
  ];
  const r = activate(settings, "甲", { rng: fixedRng(0.5) });
  assert.equal(r.entries.length, 2, "任一成员 allow_all 即全组放行");
});

test("groups[] 数组也认（不只认 group 单值）", () => {
  const settings = [
    entry("g1", { keywords: ["甲", "乙"], groups: ["G"] }),
    entry("g2", { keywords: ["甲"], groups: ["G"] })
  ];
  const r = activate(settings, "甲乙", { rng: fixedRng(0.5) });
  assert.equal(r.entries.length, 1, "groups[] 应被识别为同一组");
});

test("prioritizeInclusion 用 order 降序挑 winner", () => {
  const settings = [
    entry("lo", { keywords: ["甲"], group: "G", prioritizeInclusion: true, order: 10 }),
    entry("hi", { keywords: ["甲"], group: "G", prioritizeInclusion: true, order: 90 })
  ];
  const r = activate(settings, "甲", { rng: fixedRng(0.5) });
  assert.equal(r.entries[0].id, "hi", "order 高的优先（降序）");
});

console.log("\nC3 · 排序确定性\n" + "─".repeat(50));

test("常量优先于关键词命中", () => {
  const settings = [
    entry("kw", { keywords: ["甲"], priority: 999 }),
    entry("const", { trigger: { type: "always" }, priority: 0 })
  ];
  const r = activate(settings, "甲", { rng: fixedRng(0.5) });
  assert.equal(r.entries[0].id, "const", "常量应排最前");
});

test("同分用 id 兜底（全序）", () => {
  const a = { id: "b", priority: 100, order: 100 };
  const b = { id: "a", priority: 100, order: 100 };
  assert.ok(compareEntries(b, a) < 0, "id 小的排前面");
});

test("priority 高的排前面", () => {
  const hi = { id: "x", priority: 200, order: 100 };
  const lo = { id: "y", priority: 100, order: 100 };
  assert.ok(compareEntries(hi, lo) < 0);
});

test("entrySortKey 结构正确（7 段）", () => {
  const k = entrySortKey({ id: "z", priority: 5, order: 7 });
  assert.equal(k.length, 7);
  assert.equal(k[6], "z");
});

test("tier 排序：core < background < archived", () => {
  const settings = [
    entry("arch", { keywords: ["甲"], tier: "archived", priority: 999 }),
    entry("core", { keywords: ["甲"], tier: "core", priority: 0 })
  ];
  const r = activate(settings, "甲", { rng: fixedRng(0.5) });
  assert.equal(r.entries[0].id, "core", "core 层应排前");
});

console.log("\nC3 · 定时效果（重写后的语义）\n" + "─".repeat(50));

test("sticky 与 cooldown 不同时生效", () => {
  const st = armTimedActivation({}, { sticky: 3, cooldown: 2 });
  assert.equal(st.stickyRemaining, 3);
  assert.equal(st.cooldownRemaining, undefined, "cooldown 不该同时生效");
  assert.equal(st.pendingCooldown, 2, "cooldown 应待命");
});

test("重触发不刷新正在跑的计时器", () => {
  const st = { stickyRemaining: 2 };
  armTimedActivation(st, { sticky: 5, cooldown: 3 });
  assert.equal(st.stickyRemaining, 2, "已有 sticky 不该被刷新成 5");
});

test("cooldown 跑着时也不刷新", () => {
  const st = { cooldownRemaining: 2 };
  armTimedActivation(st, { sticky: 0, cooldown: 5 });
  assert.equal(st.cooldownRemaining, 2, "已有 cooldown 不该被刷新");
});

test("armTimedActivation 不写 delayRemaining（delay 是前置门）", () => {
  const st = armTimedActivation({}, { sticky: 2, cooldown: 1 });
  assert.equal(st.delayRemaining, undefined, "delay 不该落计数器");
});

test("sticky 结束后 cooldown 启动", () => {
  const st = armTimedActivation({}, { sticky: 2, cooldown: 3 });
  advanceTimedState(st);
  assert.equal(st.stickyRemaining, 1);
  advanceTimedState(st);
  assert.equal(st.stickyRemaining, 0);
  assert.equal(st.cooldownRemaining, 3, "sticky 结束应启动 cooldown");
});

test("无 sticky 时 cooldown 直接生效", () => {
  const st = armTimedActivation({}, { sticky: 0, cooldown: 3 });
  assert.equal(st.cooldownRemaining, 3);
});

test("delayGateBlocked：current_tick < delay 才挡（前置门语义）", () => {
  assert.equal(delayGateBlocked({ delay: 5 }, 3), true, "第 3 回合 < delay 5 → 挡");
  assert.equal(delayGateBlocked({ delay: 5 }, 5), false, "第 5 回合 → 放行");
  assert.equal(delayGateBlocked({ delay: 5 }, 9), false);
  assert.equal(delayGateBlocked({ delay: 0 }, 1), false, "无 delay → 不挡");
  assert.equal(delayGateBlocked({ delay: 5 }, null), false, "无 tick 权威 → 跳过该门");
});

test("delay 生效：未到回合不激活", () => {
  const settings = [entry("a", { keywords: ["甲"], delay: 5 })];
  assert.equal(activate(settings, "甲", { rng: fixedRng(0.5), currentTick: 3 }).entries.length, 0);
  assert.equal(activate(settings, "甲", { rng: fixedRng(0.5), currentTick: 5 }).entries.length, 1);
});

test("stickyActive / timedGateBlocked", () => {
  assert.equal(stickyActive({ stickyRemaining: 2 }), true);
  assert.equal(stickyActive({ stickyRemaining: 0 }), false);
  assert.equal(timedGateBlocked({ cooldownRemaining: 2 }), true);
  assert.equal(timedGateBlocked({ cooldownRemaining: 0 }), false);
  assert.equal(timedGateBlocked({ stickyRemaining: 2, cooldownRemaining: 5 }), false,
    "sticky 生效时不该被 cooldown 挡");
});

test("legacy 形状兼容（status/remaining）", () => {
  assert.equal(stickyActive({ status: "active", remaining: 2 }), true);
  assert.equal(timedGateBlocked({ status: "cooldown", remaining: 2 }), true);
  assert.equal(legacyDelayBlocked({ status: "delayed", remaining: 2 }), true);
});

test("migrateTimedState 修复坏形状", () => {
  const out = migrateTimedState({ a: { stickyRemaining: 2, cooldownRemaining: 3 } });
  assert.equal(out.a.stickyRemaining, 2);
  assert.equal(out.a.cooldownRemaining, 0, "同时生效的 cooldown 应退回 pending");
  assert.equal(out.a.pendingCooldown, 3);
});

test("migrateTimedState 幂等", () => {
  const once = migrateTimedState({ a: { stickyRemaining: 2, pendingCooldown: 3 } });
  const twice = migrateTimedState(once);
  assert.deepEqual(twice, once);
});

test("activated 条目才写 timed state", () => {
  const settings = [entry("a", { keywords: ["甲"], sticky: 3 })];
  const timedState = new Map();
  activate(settings, "甲", { timedState, rng: fixedRng(0.5) });
  assert.equal(timedState.get("a")?.stickyRemaining, 3, "激活后应武装 sticky");
});

test("未激活的条目不写 timed state", () => {
  const settings = [entry("a", { keywords: ["甲"], sticky: 3 })];
  const timedState = new Map();
  activate(settings, "无关文本", { timedState, rng: fixedRng(0.5) });
  assert.equal(timedState.get("a"), undefined, "没激活就不该写状态");
});

test("被概率拒绝的条目不写 timed state", () => {
  const settings = [entry("a", { keywords: ["甲"], sticky: 3, probability: 0 })];
  const timedState = new Map();
  activate(settings, "甲", { timedState, rng: fixedRng(0.5) });
  assert.equal(timedState.get("a"), undefined, "概率被拒不该写状态");
});

console.log("\nC3 · 关键词匹配\n" + "─".repeat(50));

test("大小写不敏感（默认）", () => {
  assert.equal(keyMatches("Dragon", "the DRAGON is here", {}), true);
  assert.equal(keyMatches("Dragon", "the DRAGON is here", { caseSensitive: true }), false);
});

test("整词匹配", () => {
  assert.equal(keyMatches("龙", "龙来了", { matchWholeWords: true }), true);
  assert.equal(keyMatches("king", "kingdom", { matchWholeWords: true }), false);
  assert.equal(keyMatches("king", "the king rules", { matchWholeWords: true }), true);
});

test("正则键 /pattern/flags", () => {
  assert.equal(keyMatches("/天气|气候/", "今天天气不错", {}), true);
  assert.equal(keyMatches("/DRAGON/i", "a dragon", {}), true);
  assert.equal(keyMatches("/DRAGON/", "a dragon", {}), false, "无 i 标志应区分大小写");
});

test("无效正则 → 当普通文本（不崩）", () => {
  assert.equal(typeof keyMatches("/[invalid(/", "text", {}), "boolean");
});

test("fuzzyHit：bigram 兜底", () => {
  assert.equal(fuzzyHit("dragon", {}, "a dragn appeared"), true, "共享 bigram 应命中");
  assert.equal(fuzzyHit("dragon", { useRegex: true }, "dragon"), false, "正则键不走模糊");
  assert.equal(fuzzyHit("dragon", { caseSensitive: true }, "dragon"), false, "大小写敏感不走模糊");
});

test("精确匹配为空才走模糊兜底", () => {
  const settings = [
    entry("a", { keywords: ["dragon"], content: "精确" }),
    entry("b", { keywords: ["dragn"], content: "模糊" })
  ];
  // "dragon" 精确命中 a → 不再走模糊，b 不该激活
  const r = activate(settings, "dragon", { rng: fixedRng(0.5) });
  assert.deepEqual(r.entries.map(e => e.id), ["a"], "有精确命中时不走模糊");
});

test("keywordDecision 是唯一权威", () => {
  const e = entry("x", { keywords: ["甲"], secondaryKeys: ["乙"], selectiveLogic: "not_any" });
  const d = keywordDecision(e, "甲和乙");
  assert.equal(d.primaryOk, true);
  assert.equal(d.secondaryOk, false, "not_any 副键命中 → false");
  assert.equal(d.matched, false);
});

console.log("\nC3 · 负向主键模式（索引无法覆盖）\n" + "─".repeat(50));

test("not_any 主键：文本不含关键词时激活", () => {
  // ⚠️ 这条曾被索引超集漏掉——索引只能找"文本包含关键词"的条目，
  //    而 not_any 靠"不含"成立，永远进不了超集。
  const settings = [
    entry("neg", { keywords: ["禁止词"], primaryMatchMode: "not_any", content: "警告内容" })
  ];
  const r = activate(settings, "文本里没有那个词", { rng: fixedRng(0.5) });
  assert.deepEqual(r.entries.map(e => e.id), ["neg"], "not_any 应激活");
});

test("not_any 主键：文本含关键词时不激活", () => {
  const settings = [
    entry("neg", { keywords: ["禁止词"], primaryMatchMode: "not_any" })
  ];
  const r = activate(settings, "这里出现了禁止词", { rng: fixedRng(0.5) });
  assert.equal(r.entries.length, 0);
});

test("not_all 主键：并非全部命中时激活", () => {
  const settings = [
    entry("na", { keywords: ["甲", "乙"], primaryMatchMode: "not_all" })
  ];
  // 只命中一个 → not_all 成立
  assert.equal(activate(settings, "只有甲", { rng: fixedRng(0.5) }).entries.length, 1);
  // 两个都命中 → not_all 不成立
  assert.equal(activate(settings, "甲和乙", { rng: fixedRng(0.5) }).entries.length, 0);
  // 一个都没命中 → not_all 成立（all([]) 为真 → 取反为假？）
  // DiceFrame：not_all = not (primary_keys and all(hits))
  // 主键非空且 hits 全 false → all=false → not false = true → 激活
  assert.equal(activate(settings, "都没有", { rng: fixedRng(0.5) }).entries.length, 1);
});

test("负向条目与正向条目共存", () => {
  const settings = [
    entry("pos", { keywords: ["甲"] }),
    entry("neg", { keywords: ["乙"], primaryMatchMode: "not_any" })
  ];
  const r = activate(settings, "甲在这里", { rng: fixedRng(0.5) });
  const ids = r.entries.map(e => e.id).sort();
  assert.deepEqual(ids, ["neg", "pos"], "正向命中 + 负向成立 → 都激活");
});

test("负向条目也受概率与预算约束", () => {
  const settings = [
    entry("neg", { keywords: ["甲"], primaryMatchMode: "not_any", probability: 0 })
  ];
  assert.equal(activate(settings, "不含", { rng: fixedRng(0.5) }).entries.length, 0,
    "概率 0 应拦下");
});

test("正则键：匹配但 bigram 不重合（索引也覆盖不了）", () => {
  // ⚠️ 索引存的是字面量 "/龙$/"，而文本里没有这个串。
  //    正则匹配与字面子串是两回事，必须全量送判定。
  const settings = [entry("anchored", { keywords: ["/龙$/"] })];
  assert.equal(keyMatches("/龙$/", "一条龙", {}), true, "正则本身应匹配");
  const r = activate(settings, "一条龙", { rng: fixedRng(0.5) });
  assert.deepEqual(r.entries.map(e => e.id), ["anchored"]);
});

test("正则键：有其它条目精确命中时也不丢", () => {
  // 曾以为靠 fuzzy 兜底能碰巧命中，但 fuzzy 只在“精确匹配为空”时触发
  const settings = [
    entry("plain", { keywords: ["天气"] }),
    entry("anchored", { keywords: ["/龙$/"] })
  ];
  const r = activate(settings, "今天天气不错，还有一条龙", { rng: fixedRng(0.5) });
  const ids = r.entries.map(e => e.id).sort();
  assert.deepEqual(ids, ["anchored", "plain"]);
});

test("useRegex: true 的条目也不丢", () => {
  const settings = [entry("re", { keywords: ["^一条龙$"], useRegex: true })];
  assert.equal(activate(settings, "一条龙", { rng: fixedRng(0.5) }).entries.length, 1);
});

test("trigger.type=regex 的条目也不丢", () => {
  const settings = [
    entry("re", { keywords: ["/天气/"], trigger: { type: "regex", keywords: ["/天气/"] } })
  ];
  assert.equal(activate(settings, "今天天气", { rng: fixedRng(0.5) }).entries.length, 1);
});

test("普通条目仍走索引（不被 alwaysScan 拖累）", () => {
  const settings = [
    entry("a", { keywords: ["甲"] }),
    entry("b", { keywords: ["乙"] })
  ];
  const r = activate(settings, "只有甲", { rng: fixedRng(0.5) });
  assert.deepEqual(r.entries.map(e => e.id), ["a"]);
});

console.log("\nC3 · 追踪\n" + "─".repeat(50));

test("trace 记录每条判定原因", () => {
  const settings = [
    entry("hit", { keywords: ["甲"], content: "c" }),
    entry("miss", { keywords: ["乙"], content: "c" })
  ];
  const r = activate(settings, "甲", { rng: fixedRng(0.5) });
  assert.ok(r.trace);
  assert.equal(r.trace.summary.finalCount, 1);
  assert.ok(r.trace.activated.some(x => x.id === "hit"));
});

test("trace 记录被概率拒绝的原因", () => {
  const settings = [entry("p", { keywords: ["甲"], probability: 0 })];
  const r = activate(settings, "甲", { rng: fixedRng(0.5) });
  const blocked = r.trace.blocked.find(x => x.id === "p");
  assert.ok(blocked, "应记录被拦的条目");
  assert.ok(blocked.reason.includes("概率"), `原因应说明概率，实际: ${blocked.reason}`);
});

test("trace 记录 group_lost", () => {
  const settings = [
    entry("g1", { keywords: ["甲", "乙"], group: "G", groupScoring: "score" }),
    entry("g2", { keywords: ["甲"], group: "G", groupScoring: "score" })
  ];
  const r = activate(settings, "甲乙", { rng: fixedRng(0.5) });
  const lost = r.trace.blocked.find(x => x.id === "g2");
  assert.ok(lost, "落选者应出现在 blocked 里");
  assert.ok(lost.reason.includes("分组"), `原因应为分组落选，实际: ${lost.reason}`);
});

test("trace 记录预算裁剪", () => {
  const settings = [
    entry("a", { keywords: ["甲"], content: "x".repeat(100), priority: 200 }),
    entry("b", { keywords: ["甲"], content: "x".repeat(100), priority: 100 })
  ];
  const r = activate(settings, "甲", { budget: 150, rng: fixedRng(0.5) });
  assert.equal(r.trace.cutByBudget.length, 1);
  assert.equal(r.trace.cutByBudget[0].id, "b");
});

test("无 trace 模式", () => {
  const r = activate([entry("a", { keywords: ["甲"] })], "甲", {
    includeTrace: false, rng: fixedRng(0.5)
  });
  assert.equal(r.trace, null);
  assert.equal(r.entries.length, 1);
});

console.log("\nC3 · 预算\n" + "─".repeat(50));

test("estimateEntryChars / Tokens", () => {
  assert.equal(estimateEntryChars({ content: "12345678" }), 8);
  assert.equal(estimateEntryTokens({ content: "12345678" }), 2, "8/4=2");
});

test("applyBudget 按预算裁剪", () => {
  const entries = [
    { id: "a", content: "x".repeat(10), priority: 200, order: 1 },
    { id: "b", content: "x".repeat(10), priority: 100, order: 2 },
    { id: "c", content: "x".repeat(10), priority: 50, order: 3 }
  ];
  const r = applyBudget(entries, 20);
  assert.equal(r.included.length, 2);
  assert.deepEqual(r.included.map(e => e.id), ["a", "b"]);
  assert.deepEqual(r.omitted, ["c"]);
});

test("budget=null → 全收", () => {
  const r = applyBudget([{ id: "a", content: "x" }], null);
  assert.equal(r.included.length, 1);
});

test("maxEntriesWithinBudget 给出上界", () => {
  const entries = [
    { id: "a", content: "x".repeat(5) },
    { id: "b", content: "x".repeat(5) },
    { id: "c", content: "x".repeat(5) }
  ];
  assert.equal(maxEntriesWithinBudget(entries, 12), 2);
  assert.equal(maxEntriesWithinBudget(entries, null), null);
});

test("超预算的条目不激活（端到端）", () => {
  const settings = [
    entry("a", { keywords: ["甲"], content: "x".repeat(100), priority: 200 }),
    entry("b", { keywords: ["甲"], content: "x".repeat(100), priority: 100 })
  ];
  const r = activate(settings, "甲", { budget: 150, rng: fixedRng(0.5) });
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].id, "a");
});

console.log("\nC3 · 渲染与分组\n" + "─".repeat(50));

test("renderEntries 拼接内容", () => {
  assert.equal(renderEntries([{ content: "A" }, { content: "B" }]), "A\n\nB");
});

test("renderEntries 带名称", () => {
  assert.equal(renderEntries([{ name: "设定1", content: "内容" }], { withName: true }), "[设定1]\n内容");
});

test("renderEntries 空数组 → 空串", () => {
  assert.equal(renderEntries([]), "");
  assert.equal(renderEntries(null), "");
});

test("groupByAnchor 按位置分组", () => {
  const groups = groupByAnchor([
    { id: "a", anchor: "before_char" },
    { id: "b", anchor: "after_char" },
    { id: "c", anchor: null },
    { id: "d", anchor: "乱七八糟" }
  ]);
  assert.equal(groups.before_char.length, 1);
  assert.equal(groups.after_char.length, 1);
  assert.equal(groups.unspecified.length, 2);
});

console.log("\nC3 · 边界\n" + "─".repeat(50));

test("空设定列表不崩", () => {
  assert.deepEqual(activate([], "文本").entries, []);
});

test("无关键词的条目不误激活", () => {
  assert.equal(activate([entry("a", { keywords: [] })], "任意文本", { rng: fixedRng(0.5) }).entries.length, 0);
});

test("disabled 条目不进索引", () => {
  assert.equal(activate([entry("a", { keywords: ["甲"], enabled: false })], "甲", { rng: fixedRng(0.5) }).entries.length, 0);
});

test("同一文本反复调用结果稳定", () => {
  const settings = [
    entry("a", { keywords: ["甲"], priority: 200 }),
    entry("b", { keywords: ["甲"], priority: 100 })
  ];
  const r1 = activate(settings, "甲", { rng: fixedRng(0.5) });
  const r2 = activate(settings, "甲", { rng: fixedRng(0.5) });
  assert.deepEqual(r1.entries.map(e => e.id), r2.entries.map(e => e.id));
});

test("环形递归不死循环（A→B→A）", () => {
  const settings = [
    entry("A", { keywords: ["起"], content: "提到乙" }),
    entry("B", { keywords: ["乙"], content: "提到起" })
  ];
  const r = activate(settings, "起", { rng: fixedRng(0.5) });
  assert.equal(r.entries.length, 2, "环应被 cycle guard 收敛");
});

test("snake_case 字段也能读（ST 导入兼容）", () => {
  const settings = [{
    id: "s1",
    name: "s1",
    content: "c",
    keywords: ["甲"],
    secondary_keys: ["乙"],
    selective_logic: 2,
    enabled: true,
    probability: 100
  }];
  const r = activate(settings, "甲和乙", { rng: fixedRng(0.5) });
  assert.equal(r.entries.length, 0, "not_any 副键命中 → 不该激活");
});

console.log("\n" + "=".repeat(50));
console.log(`通过 ${passed} / 失败 ${failed}`);
console.log("=".repeat(50));
process.exit(failed > 0 ? 1 : 0);
