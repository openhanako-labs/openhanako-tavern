// test/regression-story-protocol.mjs — 剧情卡协议（cwv1）：解析器 + 效果结算
//
// 跑法：node test/regression-story-protocol.mjs
//
// 覆盖：
//   解析器：全块 / 缺块 / 未知标签忽略 / 混排（协议+普通正文）/ 效果三种算子（含中文变量名）
//   结算：effectsToPatch 的加减赋 / settleStoryMessage 写变量+挂 var-diff+挂 story
//   降级：无标签消息 found=false 零副作用；非 assistant 消息不动

import { parseStoryProtocol, PROTOCOL_VERSION } from "../lib/story/protocol.js";
import { effectsToPatch, settleStoryMessage } from "../lib/story/effects.js";

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  ✅ " + label); }
  else { fail++; console.log("  ❌ " + label); }
}

// ── 解析器 ────────────────────────────────────────────

const FULL = `【剧情】
类型: 主线
标题: 雨夜的第七塔
场景: 北境哨塔 · 夜 · 雨

【对话】
【薇拉|警惕】: 「这个点钟，商队不该出现在北境。」
【旁白】: 雨点敲在结界上。

【效果】
体力 -10
薇拉.好感度 +2
时间 = 深夜

【场景更新】
新增人物: 商队头领|男|戒备|次要：高大，戴斗篷
新增物品: 魔族徽记：黑铁

【选项】
A. 下去盘查
B. 继续观察

【摘要】
月曦夜与薇拉在塔顶瞭望。`;

{
  const r = parseStoryProtocol(FULL);
  ok(r.found === true, "全块：found=true");
  ok(r.story?.title === "雨夜的第七塔" && r.story?.type === "主线", "全块：剧情头解析");
  ok(r.dialogue.length === 2 && r.dialogue[1].isNarration === true, "全块：对话+旁白");
  ok(r.effects.length === 3, "全块：效果 3 条（中文变量名——JS \\w 不认汉字，曾全空）");
  ok(r.effects[0].name === "体力" && r.effects[0].op === "-" && r.effects[0].value === "10", "全块：效果算子");
  ok(r.effects[2].name === "时间" && r.effects[2].op === "=", "全块：赋值算子");
  ok(r.sceneUpdates.length === 2 && r.sceneUpdates[0].kind === "person", "全块：场景更新");
  ok(r.choices.length === 2 && r.choices[0].letter === "A", "全块：选项");
  ok(typeof r.summary === "string" && r.summary.includes("薇拉"), "全块：摘要");
  ok(r.plainRemainder === "", "全块：无残留正文");
}

{
  const r = parseStoryProtocol("【对话】\n【甲】: 你好。");
  ok(r.found === true && r.dialogue.length === 1 && !r.story, "缺块：只有对话也 found");
}

{
  const r = parseStoryProtocol("【未来协议块】\n whatever\n【对话】\n【甲】: 好。");
  ok(r.found === true && r.dialogue.length === 1, "未知标签整块忽略，不崩");
}

{
  const r = parseStoryProtocol("前面一段普通正文。\n【效果】\n体力 +5\n后面再跟一句。");
  ok(r.found === true && r.effects.length === 1, "混排：效果解析");
  ok(r.plainRemainder.includes("普通正文") && r.plainRemainder.includes("再跟一句"), "混排：plainRemainder 保留两侧正文");
}

{
  const r = parseStoryProtocol("就是一段普普通通的回复，没有任何标签。");
  ok(r.found === false, "降级：无标签 found=false");
  ok(r.plainRemainder.includes("普普通通"), "降级：原文进 plainRemainder");
}

{
  const r = parseStoryProtocol("【效果】\n体力 -10\n薇拉.好感度 +2\n时间 = 深夜\n金币 +0.5");
  ok(r.effects.length === 4, "效果行：中文名、层级名、小数全解析");
}

// ── effectsToPatch ────────────────────────────────────

{
  const { patch, diff } = effectsToPatch(
    [{ name: "体力", op: "-", value: "10" }, { name: "好感", op: "+", value: "2" }, { name: "时间", op: "=", value: "深夜" }],
    { 体力: "100", 好感: "3" }
  );
  ok(patch["体力"] === "90", "patch：减（基于现值）");
  ok(patch["好感"] === "5", "patch：加（基于现值）");
  ok(patch["时间"] === "深夜", "patch：赋值");
  ok(diff.length === 3 && diff[0].change === "add" && diff[2].change === "set", "diff：change 类型");
  ok(diff[0].from === "100" && diff[0].to === "90", "diff：from/to");
}

{
  const { patch } = effectsToPatch([{ name: "新变量", op: "+", value: "5" }], {});
  ok(patch["新变量"] === "5", "patch：变量不存在时按 0 起");
}

// ── settleStoryMessage（用内存 stub repo）─────────────

function stubRepo(vars = {}) {
  const state = { vars: { ...vars }, varDiff: null, story: null };
  return {
    state,
    async updateVariables(_id, patch) { Object.assign(state.vars, patch); },
    async setMessageVarDiff(_id, _mid, diff) { state.varDiff = diff; },
    async setMessageStory(_id, _mid, story) { state.story = story; }
  };
}

{
  const repo = stubRepo({ 体力: "100" });
  const conv = { id: "c1", variables: repo.state.vars };
  const message = { id: "m1", role: "assistant", content: FULL };
  const r = await settleStoryMessage({ conv, message, conversationRepo: repo });
  ok(r.settled === true, "settle：settled=true");
  ok(repo.state.vars["体力"] === "90", "settle：变量真实减少");
  ok(repo.state.vars["时间"] === "深夜", "settle：赋值变量落账");
  ok(Array.isArray(repo.state.varDiff) && repo.state.varDiff.length === 3, "settle：var-diff 挂到消息");
  ok(repo.state.story?.found === true, "settle：解析结果挂 msg.story");
  ok(message.content === FULL, "settle：消息原文一字不动");
}

{
  const repo = stubRepo();
  const conv = { id: "c1", variables: {} };
  const message = { id: "m1", role: "assistant", content: "普通回复，没有标签。" };
  const r = await settleStoryMessage({ conv, message, conversationRepo: repo });
  ok(r.settled === false && r.parsed?.found === false, "降级：无标签零副作用");
  ok(repo.state.varDiff === null && repo.state.story === null, "降级：不挂 varDiff / story");
}

{
  const repo = stubRepo();
  const message = { id: "m1", role: "user", content: FULL };
  const r = await settleStoryMessage({ conv: { id: "c1" }, message, conversationRepo: repo });
  ok(r.settled === false, "非 assistant 消息：不动");
}

// ── 汇总 ──────────────────────────────────────────────

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (PROTOCOL_VERSION !== "cwv1") { console.log("⚠ 协议版本不是 cwv1"); fail++; }
process.exit(fail > 0 ? 1 : 0);
