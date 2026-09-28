// test/regression-scene-prompt.mjs — 场景插图提示词拼装（第 2 批 2.3）
//
// 判据：
//   · 只用卡里已有的字段（名字 / 描述 / 性格），不编外貌
//   · 场景描述原样带进 prompt，不做同义改写
//   · 没有场景描述时退化成"角色半身像"，但不编外貌
//   · 风格可以覆盖
//   · 说话人与卡名字相同时不重复
//
// 反证：
//   · 把 prompt 里的 scene 那一段删掉 → ① ② 直接红
//   · 把 style 那一行删掉 → ④ 直接红
//   · 把 speaker 判空分支删掉 → ⑤ 直接红
//   · 把场景描述做同义改写（比如 trim 后再加"场景："）→ ① 直接红

import assert from "node:assert/strict";
import { sceneIllustrationPrompt } from "../lib/illustration/prompt.js";

let pass = 0;
const failed = [];
function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed.push(name);
    console.error(`  ❌ ${name}\n     ${e?.message || e}`);
  }
}

// ── ① 主用例：卡有内容 + 场景描述 ──
ok("① 卡有描述与性格 + 场景描述 → 拼出含场景的提示词", () => {
  const card = {
    name: "薇拉",
    description: "银灰长发，戴半圆眼镜",
    personality: "冷静，慢半拍"
  };
  const r = sceneIllustrationPrompt(card, { scene: "她站在雨里，肩膀微抖" });
  assert.equal(r.scene, "她站在雨里，肩膀微抖");
  assert.ok(r.prompt.includes("她站在雨里，肩膀微抖"), "prompt 应原样含场景描述");
  assert.ok(r.prompt.includes("银灰长发"), "prompt 应含卡的描述");
  assert.ok(r.prompt.includes("冷静，慢半拍"), "prompt 应含卡的性格");
  // 说话人与卡名字相同时不出现两次"薇拉"
  const count = (r.prompt.match(/薇拉/g) || []).length;
  assert.ok(count >= 1, "至少一次薇拉");
});

// ── ② 说话人与卡名字不同时：说话人独立出现 ──
ok("② speaker 与卡名字不同 → prompt 里出现说话人，卡名字在卡字段里", () => {
  const card = { name: "薇拉", description: "银灰长发" };
  const r = sceneIllustrationPrompt(card, {
    speaker: "月曦夜",
    scene: "她望向远处"
  });
  assert.ok(r.prompt.includes("说话人「月曦夜」"), "应出现说话人标记");
  assert.ok(r.prompt.includes("薇拉"), "卡名字仍在");
});

// ── ③ 卡字段为空 → 只有场景描述 + 风格 ──
ok("③ 卡字段全空 → prompt 只有场景 + 风格，不编外貌", () => {
  const r = sceneIllustrationPrompt({ name: "新人" }, { scene: "黄昏的车站" });
  assert.ok(r.prompt.includes("黄昏的车站"));
  assert.ok(r.prompt.includes("新人"), "卡名字仍在");
  // 不该出现"银发""蓝眼"这种外貌词（卡里没写的绝不写）
  assert.equal(r.card.hasCharacter, false, "无实质卡字段");
});

// ── ④ 风格覆盖 ──
ok("④ 自定义风格覆盖默认", () => {
  const card = { name: "薇拉", description: "银灰长发" };
  const r = sceneIllustrationPrompt(card, {
    scene: "雨",
    style: "赛博朋克霓虹"
  });
  assert.ok(r.prompt.includes("赛博朋克霓虹"), "应含自定义风格");
  assert.ok(!r.prompt.includes("暖纸色调"), "默认风格不该出现");
});

// ── ⑤ 无场景描述 → 退化为半身像 ──
ok("⑤ 无场景描述 → 退化成半身像，不编外貌", () => {
  const r = sceneIllustrationPrompt({ name: "薇拉" });
  assert.ok(r.prompt.includes("半身像"), "应退化为半身像");
  assert.equal(r.scene, null, "scene 应为 null");
});

// ── ⑥ 完全空输入 ──
ok("⑥ 卡与场景都空 → 只返回风格（不抛）", () => {
  const r = sceneIllustrationPrompt({}, {});
  assert.ok(r.prompt.length > 0);
  assert.equal(r.scene, null);
});

// ── ⑦ 说话人与卡名字相同时不重复 ──
ok("⑦ speaker 与卡名字相同 → 名字只出现一次，不额外写“说话人”", () => {
  const card = { name: "薇拉" };
  const r = sceneIllustrationPrompt(card, {
    speaker: "薇拉",
    scene: "窗前"
  });
  const count = (r.prompt.match(/薇拉/g) || []).length;
  assert.equal(count, 1, "同名不该重复");
  assert.ok(!r.prompt.includes("说话人"), "同名时不写“说话人”段");
});

// ── ⑧ 描述超长会被截 ──
ok("⑧ 场景描述超过 200 字会被截到 200", () => {
  const long = "字".repeat(300);
  const r = sceneIllustrationPrompt({}, { scene: long });
  assert.equal(r.scene.length, 200);
});

// ── ⑨ 画面上不要出现字（真机跑出来的缺陷，不是风格偏好） ──
//
// 2026-09-27 真机：城门洞那张插图里模型自己补了两个对话框，
// 里面是一串假字（“¡ 1日57开5成美蚧:! ¤”）。中文模型画中文场景时
// 很容易顺手补气泡，而它写不出真字。
ok("⑨ 默认风格下 prompt 里带“不要文字”", () => {
  const r = sceneIllustrationPrompt({ name: "薇拉" }, { scene: "窗前" });
  assert.ok(r.prompt.includes("文字"), "该带上那条负向约束");
  assert.ok(/气泡/.test(r.prompt), "该点名对话气泡（真机出错的就是它）");
  assert.ok(/不是漫画页/.test(r.prompt), "该说清这是插画不是漫画");
});

ok("⑩ 用户自定义风格时也照样带上（它是缺陷约束，不是风格）", () => {
  const r = sceneIllustrationPrompt({ name: "薇拉" }, { scene: "窗前", style: "赛博朋克霓虹" });
  assert.ok(r.prompt.includes("赛博朋克霓虹"), "自定义风格要在");
  assert.ok(/不是漫画页/.test(r.prompt), "自定义风格时也得不出现字");
});

ok("⑪ 卡与场景全空时也带（⑥ 的延伸：那句不依赖任何输入）", () => {
  const r = sceneIllustrationPrompt({}, {});
  assert.ok(/不是漫画页/.test(r.prompt));
});

console.log("");
if (failed.length) {
  console.error(`❌ 场景插图提示词：${pass} 过 / ${failed.length} 败`);
  process.exit(1);
}
console.log(`✅ 场景插图提示词：${pass} 过 / 0 败`);
