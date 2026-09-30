// test/regression-director-pacing.mjs — 节奏四选项注入回归
//
// S3：director 实体加 pacing: string[]，prompt.js 注入节奏指令。
// 本测试验证：
//   1. pacing 空数组 → 不注入这行
//   2. pacing 有值 → 注入对应中文指令
//   3. 多选叠加 → 用「；」连接
//   4. 未知 key 被过滤掉

import assert from "node:assert";
import { createDirectorEntity } from "../lib/director/model.js";
import { renderDirectorBlock } from "../lib/director/prompt.js";

// 最小配方：一条 always 规则 + brief
function makeEntity(pacing) {
  return createDirectorEntity({
    name: "测试配方",
    state: { 张力: { init: 3, min: 0, max: 10 } },
    rules: [{ when: "always", effect: "张力 += 1", brief: "维持悬念" }],
    freeform: "本轮发生什么由你决定。",
    pacing: pacing || []
  });
}

const STATE = { 张力: 3 };

// ── 空 pacing → 不注入 ──
{
  const block = renderDirectorBlock(makeEntity([]), STATE);
  assert.ok(!block.includes("节奏："), "空 pacing 不注入节奏行");
  console.log("✓ 空 pacing → 不注入");
}

// ── 单项：daily ──
{
  const block = renderDirectorBlock(makeEntity(["daily"]), STATE);
  assert.ok(block.includes("放缓冲突，多写生活细节与闲笔"), "daily 注入正确");
  console.log("✓ daily → 放缓冲突，多写生活细节与闲笔");
}

// ── 单项：drama ──
{
  const block = renderDirectorBlock(makeEntity(["drama"]), STATE);
  assert.ok(block.includes("提高冲突密度，每轮给一个张力点"), "drama 注入正确");
  console.log("✓ drama → 提高冲突密度，每轮给一个张力点");
}

// ── 单项：cast ──
{
  const block = renderDirectorBlock(makeEntity(["cast"]), STATE);
  assert.ok(block.includes("让配角主动行动，带出图鉴里的人物"), "cast 注入正确");
  console.log("✓ cast → 让配角主动行动，带出图鉴里的人物");
}

// ── 单项：bond ──
{
  const block = renderDirectorBlock(makeEntity(["bond"]), STATE);
  assert.ok(block.includes("推进角色间的情感变化与互动"), "bond 注入正确");
  console.log("✓ bond → 推进角色间的情感变化与互动");
}

// ── 多选：drama + cast ──
{
  const block = renderDirectorBlock(makeEntity(["drama", "cast"]), STATE);
  assert.ok(block.includes("节奏："), "有节奏行");
  assert.ok(block.includes("提高冲突密度，每轮给一个张力点"), "drama 注入");
  assert.ok(block.includes("让配角主动行动，带出图鉴里的人物"), "cast 注入");
  assert.ok(block.includes("；"), "用分号连接");
  console.log("✓ drama + cast → 节奏：提高冲突密度，每轮给一个张力点；让配角主动行动，带出图鉴里的人物。");
}

// ── 全四项 ──
{
  const block = renderDirectorBlock(makeEntity(["daily", "drama", "cast", "bond"]), STATE);
  assert.ok(block.includes("放缓冲突"), "daily");
  assert.ok(block.includes("提高冲突密度"), "drama");
  assert.ok(block.includes("让配角主动行动"), "cast");
  assert.ok(block.includes("推进角色间的情感变化"), "bond");
  // 三项之间用「；」
  const segs = block.split("节奏：")[1]?.split("。")[0]?.split("；");
  assert.strictEqual(segs.length, 4, "四项用分号分隔成四段");
  console.log("✓ 全四项 → 四段用分号连接");
}

// ── 未知 key 被过滤 ──
{
  const block = renderDirectorBlock(makeEntity(["unknown_key", "daily"]), STATE);
  assert.ok(block.includes("放缓冲突"), "known key 注入");
  assert.ok(!block.includes("unknown_key"), "unknown key 不注入");
  console.log("✓ unknown key 被过滤");
}

// ── 注入位置：约束之后、freeform 之前 ──
{
  const block = renderDirectorBlock(makeEntity(["drama"]), STATE);
  const constraintIdx = block.indexOf("约束");
  const pacingIdx = block.indexOf("节奏：");
  const freeformIdx = block.indexOf("本轮发生什么由你决定");
  assert.ok(constraintIdx >= 0, "有约束行");
  assert.ok(pacingIdx >= 0, "有节奏行");
  assert.ok(freeformIdx >= 0, "有 freeform 行");
  assert.ok(pacingIdx > constraintIdx, "节奏在约束之后");
  assert.ok(freeformIdx > pacingIdx, "freeform 在节奏之后");
  console.log("✓ 注入顺序：约束 → 节奏 → freeform");
}

console.log("\n=== 全部通过 ===");
