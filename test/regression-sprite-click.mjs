// test/regression-sprite-click.mjs — 立绘点击反应（第 5 期）
// node test/regression-sprite-click.mjs

import { pickReaction, validateSpriteReactions, buildSpritePrompt } from "../lib/sprite/click.js";

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  ✅ " + label); }
  else { fail++; console.log("  ❌ " + label); }
}

const DATA = {
  zones: [
    { name: "头部", rect: [0, 0, 50, 30], reactions: [
      { expr: "害羞", text: "别、别摸头啦…", weight: 3 },
      { expr: "生气", text: "再摸就咬你哦。", weight: 1 }
    ] },
    { name: "手", rect: [60, 50, 100, 100], reactions: [
      { expr: "疑惑", text: "牵我做什么？", weight: 1 }
    ] }
  ]
};

// ── pickReaction：命中 + 权重 ──
{
  const r = pickReaction(DATA, 10, 10);
  ok(r?.zone === "头部" && r.reaction.text === "别、别摸头啦…", "命中头部热区");
  const r2 = pickReaction(DATA, 80, 80);
  ok(r2?.zone === "手" && r2.reaction.expr === "疑惑", "命中手部热区");
  ok(pickReaction(DATA, 55, 40) === null, "热区外 null");
}

// 权重：weight 3:1 → 模拟 rng 序列，3/4 概率第一条
{
  let first = 0, second = 0;
  const seq = [0.1, 0.9, 0.1, 0.9, 0.1, 0.9, 0.1, 0.9, 0.1, 0.9];
  for (const v of seq) {
    const r = pickReaction(DATA, 10, 10, () => v);
    if (r.reaction.expr === "害羞") first++;
    else second++;
  }
  ok(first === 5 && second === 5, `rng 0.1/0.9 各半（权重 3:1 分界在 0.25）→ first=${first} second=${second}`);
  const low = pickReaction(DATA, 10, 10, () => 0.7);  // roll=0.7*4=2.8 < 3 → 第一条
  const high = pickReaction(DATA, 10, 10, () => 0.8); // roll=0.8*4=3.2 > 3 → 第二条
  ok(low.reaction.expr === "害羞" && high.reaction.expr === "生气", "权重分界在 3/4（0.75）");
}

// ── 校验 ──
{
  ok(validateSpriteReactions(DATA).length === 0, "合法数据零错误");
  ok(validateSpriteReactions(null).length > 0, "null 报错");
  ok(validateSpriteReactions({ zones: [] }).length > 0, "空 zones 报错");
  ok(validateSpriteReactions({ zones: [{ name: "x", rect: [10, 10, 0, 0], reactions: [] }] }).length >= 2, "矩形倒置+空反应都报");
  ok(validateSpriteReactions({ zones: [{ name: "x", rect: [0, 0, 101, 50], reactions: [{ text: "x" }] }] }).length === 1, "rect 超 100 报");
}

// ── 提示词构造 ──
{
  const card = { name: "薇拉", description: "北境守夜法师", personality: "简短，冷淡" };
  const { systemPrompt, userPrompt } = buildSpritePrompt(card, { width: 1024, height: 1536 });
  ok(systemPrompt.includes("点击热区"), "systemPrompt 讲热区");
  ok(systemPrompt.includes("百分比"), "systemPrompt 用百分比坐标");
  ok(systemPrompt.includes("2:3"), "宽高比注入（像素已约分成最简比）");
  ok(userPrompt.includes("薇拉") && userPrompt.includes("北境守夜法师"), "卡描述进 prompt");
  ok(!systemPrompt.includes("undefined"), "无 undefined 渗漏");
}

// ── 坏数据不崩 ──
{
  ok(pickReaction(null, 10, 10) === null, "null 数据 null");
  ok(pickReaction({ zones: [{ name: "x", rect: null, reactions: [] }] }, 10, 10) === null, "rect null 跳过");
  ok(pickReaction({ zones: [{ name: "x", rect: [0, 0, 50, 50], reactions: [{ text: "" }] }] }, 10, 10)?.reaction === null, "全空反应 → reaction null");
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
