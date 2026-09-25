// test/regression-narration.mjs — 连播的"读什么、按什么顺序"
//
// 这段是纯逻辑，所以能在 node 里直接测（不必开浏览器）。
// 它值得单独测的原因是：漏一条、顺序乱、把旁白当台词、把宏读成花括号——
// 这四种错都**不会报错**，只会让听的人觉得哪里不对。

import assert from "node:assert/strict";

const { planNarration, speakerOf, progressText } = await import("../ui/assets/modules/narration-plan.js");

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 连播 · 读什么 ===\n");

const conv = { characterId: "char-main" };
const msgs = [
  { id: "m1", role: "user", content: "你还在吗？" },
  { id: "m2", role: "assistant", content: "「又是你。」她把手里的灯举高了些。" },
  { id: "m3", role: "user", content: "我来问路。" },
  { id: "m4", role: "assistant", content: "   " },
  { id: "m5", role: "assistant", content: "北门往东，过了石桥就是。", speakerId: "char-b" },
  { id: "m6", role: "system", content: "（系统提示）" }
];

ok("① 只读角色的台词，跳过用户与系统消息", () => {
  const plan = planNarration(msgs, { characterId: conv.characterId });
  assert.deepStrictEqual(plan.map((p) => p.id), ["m2", "m5"]);
});

ok("② 顺序就是时间顺序，不自作主张重排", () => {
  const plan = planNarration(msgs, { characterId: conv.characterId });
  assert.deepStrictEqual(plan.map((p) => p.index), [0, 1]);
});

ok("③ 空消息（只有空白）不占位置", () => {
  const plan = planNarration(msgs, { characterId: conv.characterId });
  assert.ok(!plan.some((p) => p.id === "m4"), "空白消息不该进去");
});

ok("④ 谁在说：群聊用 speakerId，单人用这场的主角", () => {
  const plan = planNarration(msgs, { characterId: conv.characterId });
  assert.strictEqual(plan[0].speakerId, "char-main", "单人对话该落到主角");
  assert.strictEqual(plan[1].speakerId, "char-b", "群聊这条该用它自己的说话人");
  assert.strictEqual(speakerOf({ speakerId: "x" }, "main"), "x");
  assert.strictEqual(speakerOf({}, "main"), "main");
  assert.strictEqual(speakerOf(null, "main"), "main");
});

ok("⑤ 宏先还原再读：{{user}} 不该被念成花括号", () => {
  const plan = planNarration(
    [{ id: "a", role: "assistant", content: "{{user}}，你来了。" }],
    { characterId: "c", process: (s) => s.replace(/\{\{user\}\}/g, "月曦夜") }
  );
  assert.strictEqual(plan[0].text, "月曦夜，你来了。");
});

ok("⑥ 换行与缩进压成一句，但不动内容", () => {
  const plan = planNarration(
    [{ id: "a", role: "assistant", content: "第一行\n\n   第二行  结尾 " }],
    { characterId: "c" }
  );
  assert.strictEqual(plan[0].text, "第一行 第二行 结尾");
});

ok("⑦ 想读全部（含自己的话）也能读——只是默认不这么做", () => {
  const all = planNarration(msgs, { characterId: conv.characterId, onlyAssistant: false });
  assert.deepStrictEqual(all.map((p) => p.id), ["m1", "m2", "m3", "m5"]);
});

ok("⑧ max 截断与坏输入", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, role: "assistant", content: `第${i}句` }));
  assert.strictEqual(planNarration(many, { max: 3 }).length, 3);
  assert.deepStrictEqual(planNarration(null), []);
  assert.deepStrictEqual(planNarration([null, undefined]), []);
  assert.strictEqual(planNarration([{ role: "assistant", content: "没有 id 也行" }])[0].id, "#0");
});

ok("⑨ 进度文案：从 1 开始数，别显示 0/12", () => {
  assert.strictEqual(progressText(0, 12), "1/12");
  assert.strictEqual(progressText(5, 12), "6/12");
  assert.strictEqual(progressText(11, 12), "12/12");
  assert.strictEqual(progressText(99, 12), "12/12", "越界要夹住");
  assert.strictEqual(progressText(0, 3, "薇拉"), "薇拉 · 1/3");
});

console.log(`\n${fail === 0 ? "✅" : "❌"} 连播计划：${pass} 过 / ${fail} 败\n`);
process.exit(fail === 0 ? 0 : 1);
