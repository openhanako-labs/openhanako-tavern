// test/regression-bond.mjs — 羁绊系统（第 6 期）
// node test/regression-bond.mjs

import { bondTitle, bondSystemBlock, parseBondStage } from "../lib/bond/core.js";

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  ✅ " + label); }
  else { fail++; console.log("  ❌ " + label); }
}

// ── 标题 ──
ok(bondTitle(["薇拉", "爱莉丝"]) === "羁绊 · 薇拉 × 爱莉丝", "双人标题");
ok(bondTitle(["薇拉", "爱莉丝", "第三人"]).includes("薇拉 × 爱莉丝"), "三人只取前二");

// ── system 块 ──
{
  const b = bondSystemBlock({ names: ["薇拉", "爱莉丝"], stage: "初识", history: [] });
  ok(b.includes("不在场"), "玩家不在场声明");
  ok(b.includes("薇拉、爱莉丝"), "参与者名单");
  ok(b.includes("初识"), "当前阶段");
  ok(b.includes("第一次私下互动"), "无历史时的空态");
  ok(b.includes("关系阶段: "), "结尾演进格式要求");
}
{
  const b = bondSystemBlock({ names: ["A", "B"], stage: "熟络", history: ["第一次见面", "一起淋过雨", "吵了一架"] });
  ok(b.includes("互动历史"), "有历史时列出");
  ok(b.includes("吵了一架") && !b.includes("更早的"), "只取最近 3 段");
  ok(b.includes("熟络"), "阶段注入");
}

// ── 阶段解析 ──
ok(parseBondStage("……正文……\n关系阶段: 熟络") === "熟络", "冒号空格");
ok(parseBondStage("……\n关系阶段：亲密") === "亲密", "全角冒号");
ok(parseBondStage("没有阶段行") === null, "没有返回 null");
ok(parseBondStage("") === null, "空串 null");

// ── 演进语义（阶段由 AI 收束行决定，缺失保持原阶段）──
ok(parseBondStage("正文\n关系阶段: 熟络\n多余") === "熟络", "只取第一处");

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
