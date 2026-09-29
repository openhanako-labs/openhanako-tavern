// test/regression-graph-renderer.mjs — 图谱与雷达渲染回归
//
// C3-2-fix2 的教训：openGraph 里 renderGraph 抛 ReferenceError（focusAttr
// 只在 person 分支定义，faction/place 分支引用时未定义），错误变成
// unhandledrejection，loading 永远转圈。
//
// 本测试直接调 renderGraph(null) 和 renderGraph(focusId) 两条路径，
// 确保：
//   1. 两种路径都不抛异常
//   2. 输出 SVG 包含预期节点（人物/势力/地点/边）
//   3. focus 只控制 data-focus 属性，不控制是否入图
//   4. 孤立节点全部入图（不管有没有 focus）
//
// 同时测 renderRadar 的缺轴行为：虚线圈 + 「—」+ 多边形不闭合。

import assert from "node:assert";
import { renderGraph, renderRadar } from "../ui/assets/modules/graph-renderer.js";

// ── 测试数据：3 人物、1 势力、1 地点、1 关系 ──
// 其中"张三"有边，"李四"和"王五"孤立；势力/地点也各有一个孤立。

const PERSONS = [
  { id: "p1", name: "张三" },
  { id: "p2", name: "李四" },
  { id: "p3", name: "王五" }
];
const PLACES = [
  { id: "pl1", name: "孤儿村" }
];
const FACTIONS = [
  { id: "f1", name: "暗月教团" }
];
const RELATIONS = [
  { id: "r1", from: "p1", to: "p2", kind: "师徒", direction: "from-to", strength: 50 }
];
const DATA = { persons: PERSONS, places: PLACES, factions: FACTIONS, relations: RELATIONS };

// ── renderGraph(null)：无焦点 ──
{
  const { svg, stats } = renderGraph(DATA, null);
  assert.ok(svg.includes("<svg"), "SVG 根元素存在");
  assert.ok(svg.includes("</svg>"), "SVG 闭合");

  // 所有 5 个实体都入图（3 人 + 1 地 + 1 势力）
  assert.ok(svg.includes('data-node-id="p1"'), "人物 p1 入图");
  assert.ok(svg.includes('data-node-id="p2"'), "人物 p2 入图");
  assert.ok(svg.includes('data-node-id="p3"'), "人物 p3 入图（孤立也收）");
  assert.ok(svg.includes('data-node-id="pl1"'), "地点 pl1 入图（孤立也收）");
  assert.ok(svg.includes('data-node-id="f1"'), "势力 f1 入图（孤立也收）");

  // 边存在
  assert.ok(svg.includes('data-rel-id="r1"'), "关系 r1 渲染");

  // 无焦点 → 没有 data-focus=1
  assert.ok(!svg.includes("data-focus=1"), "无焦点时不出现 data-focus=1");

  // stats 文本
  assert.ok(stats.includes("3 人"), "stats 包含人数");
  assert.ok(stats.includes("1 势力"), "stats 包含势力数");
  assert.ok(stats.includes("1 地"), "stats 包含地点数");
  assert.ok(stats.includes("1 关系"), "stats 包含关系数");

  console.log("✓ renderGraph(null) — 无焦点路径正常，孤立节点全收");
}

// ── renderGraph("p2")：有焦点 ──
{
  const { svg, stats } = renderGraph(DATA, "p2");
  assert.ok(svg.includes("data-focus=1"), "有焦点时出现 data-focus=1");
  assert.ok(svg.includes('data-node-id="p2"'), "焦点人物 p2 入图");
  assert.ok(svg.includes('data-node-id="p1"'), "人物 p1 入图");
  assert.ok(svg.includes('data-node-id="p3"'), "人物 p3 入图（孤立也收）");
  assert.ok(svg.includes('data-node-id="pl1"'), "地点 pl1 入图（孤立也收）");
  assert.ok(svg.includes('data-node-id="f1"'), "势力 f1 入图（孤立也收）");

  // stats 不变
  assert.ok(stats.includes("3 人"), "stats 不变");

  console.log("✓ renderGraph(focusId) — 有焦点路径正常，焦点只高亮不控入图");
}

// ── renderGraph("nonexistent")：焦点 id 不存在 ──
{
  // 不抛异常，正常渲染（focus 只是没匹配上，所有节点仍入图）
  const { svg } = renderGraph(DATA, "nonexistent");
  assert.ok(svg.includes("data-node-id=\"p1\""), "焦点不存在时人物仍入图");
  assert.ok(!svg.includes("data-focus=1"), "焦点不存在时无 data-focus=1");
  console.log("✓ renderGraph(不存在 id) — 不抛异常，正常渲染");
}

// ── renderGraph(空数据) ──
{
  const { svg, stats } = renderGraph({ persons: [], places: [], factions: [], relations: [] }, null);
  assert.ok(svg.includes("<svg"), "空数据也返回 SVG");
  assert.ok(stats.includes("0 人"), "空数据 stats 正确");
  console.log("✓ renderGraph(空数据) — 不抛异常");
}

// ── renderRadar：缺轴 ──
{
  const axes = [
    { name: "攻击", value: 80, max: 100 },
    { name: "防御", value: null, max: 100 },
    { name: "敏捷", value: 55, max: 100 },
    { name: "智力", value: null, max: 100 },
    { name: "感知", value: 90, max: 100 }
  ];
  const svg = renderRadar(axes, { title: "魔法", size: 200 });

  // 缺轴标记
  const missingCount = (svg.match(/class="codex-radar-missing"/g) || []).length;
  assert.strictEqual(missingCount, 2, "缺轴数 = 2（防御、智力）");

  const dashCount = (svg.match(/>—</g) || []).length;
  assert.strictEqual(dashCount, 2, "破折号标签数 = 2");

  // 多边形：3 个有效轴 < 5 总轴 → polyline（不闭合）
  const polygonCount = (svg.match(/<polygon/g) || []).length;
  const polylineCount = (svg.match(/<polyline/g) || []).length;
  assert.strictEqual(polygonCount, 0, "有缺轴时不闭合（无 <polygon>）");
  assert.strictEqual(polylineCount, 1, "有缺轴时用 <polyline>");

  console.log("✓ renderRadar(缺轴) — 虚线圈 + 破折号 + 多边形不闭合");
}

// ── renderRadar：满轴 ──
{
  const axes = [
    { name: "攻击", value: 80, max: 100 },
    { name: "防御", value: 60, max: 100 },
    { name: "敏捷", value: 55, max: 100 },
    { name: "智力", value: 70, max: 100 },
    { name: "感知", value: 90, max: 100 }
  ];
  const svg = renderRadar(axes, { title: "魔法", size: 200 });

  // 满轴 → polygon（闭合）
  const polygonCount = (svg.match(/<polygon/g) || []).length;
  assert.strictEqual(polygonCount, 1, "满轴时闭合（<polygon>）");

  // 无缺轴标记
  assert.ok(!svg.includes("codex-radar-missing"), "满轴时无缺轴标记");

  console.log("✓ renderRadar(满轴) — 闭合多边形");
}

// ── renderRadar：空数据 ──
{
  const svg = renderRadar([], { title: "", size: 100 });
  assert.ok(svg.includes("（无轴）"), "空数据时显示「（无轴）」");
  console.log("✓ renderRadar(空) — 不抛异常");
}

console.log("\n=== 全部通过 ===");
