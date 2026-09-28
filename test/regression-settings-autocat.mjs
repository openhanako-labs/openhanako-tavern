// test/regression-settings-autocat.mjs — 启发式分类的边界纪律
//
// 判据（方案文档 2026-09-27 四、6）：
//   1. 只输出三类：组织 / 系统 / 地点；其余一律空串
//   2. 不误判人名——真库里 27 条角色，启发式硬猜只能认出 14 条，猜错比空着更烦
//   3. 有把握的信号（「企业-」、「[tag]」、「以塔/星/港/… 结尾」）确实能归对
//
// 起因：真库分类实验得出「设定兜底桶 55 条」的结论——
//   猜错的条目得用户一条一条改，比不分类还费时。
//   所以启发式**只填高置信的**，其余留空，让用户自己在 UI 里点。

import assert from "node:assert/strict";
import { guessCategory, guessForAll } from "../lib/settings/autocat.js";

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { fail++; console.log("  ✗ " + name + "\n      " + (e?.message ?? e)); }
}

const cat = (s) => guessCategory({ id: "x", name: s });

console.log("\n── 输出边界 ──");

ok("① 返回值必须 ∈ {组织, 系统, 地点, \"\"}", () => {
  const samples = [
    "哨塔", "企业-许奈德", "[initvar]初始化", "拉斯提/男性原版",
    "莉娜·许奈德", "交感同操", "世界观/时间线", "🌺 梨花大学",
    "队员1", "V·I 佛洛依特", "第一章", "终章-结局", "随机池"
  ];
  const allowed = new Set(["组织", "系统", "地点", ""]);
  for (const s of samples) {
    const got = cat(s);
    assert.ok(allowed.has(got), `"${s}" → "${got}"，不在允许集合内`);
  }
});

ok("② 空名字 / 空对象 / null 都返回空串", () => {
  assert.equal(guessCategory(null), "");
  assert.equal(guessCategory({}), "");
  assert.equal(guessCategory({ id: "x", name: "" }), "");
  assert.equal(guessCategory({ id: "x", name: "   " }), "");
});

console.log("\n── 组织（靠「企业-」等前缀/后缀）──");

ok("③ 「企业-XXX」归组织", () => {
  assert.equal(cat("🧿 企业-麦宁"), "组织");
  assert.equal(cat("🐦 企业-许奈德"), "组织");
  assert.equal(cat("🌲 企业-大丰工业"), "组织");
  assert.equal(cat("🔎 企业-总览"), "组织");
});

ok("④ 明确的机构后缀也归组织", () => {
  assert.equal(cat("机械协会"), "组织");
  assert.equal(cat("贝拉姆工业公司"), "组织");
});

console.log("\n── 系统（靠 `[tag]` 前缀或「系统/协议/机制」结尾）──");

ok("⑤ ST 世界书常用 `[tag]` 前缀归系统", () => {
  assert.equal(cat("[initvar]变量初始化勿开"), "系统");
  assert.equal(cat("[mvu_update]变量更新规则"), "系统");
  assert.equal(cat("[mvu_update]变量输出格式强调"), "系统");
});

ok("⑥ 「系统」「协议」「机制」结尾归系统", () => {
  assert.equal(cat("机甲战斗系统"), "系统");
  assert.equal(cat("数值系统"), "系统");
  assert.equal(cat("骰子系统"), "系统");
  assert.equal(cat("职业技能调用协议"), "系统");
  assert.equal(cat("DM核心运行协议"), "系统");
});

console.log("\n── 地点（靠地形词结尾）──");

ok("⑦ 地形词结尾归地点", () => {
  assert.equal(cat("哨塔"), "地点");
  assert.equal(cat("🌎 祖星"), "地点");
  assert.equal(cat("G3 五花海"), "地点");
  assert.equal(cat("第二章-跨海"), "地点");
  assert.equal(cat("第三章-袭击旧宇宙港"), "地点");
});

console.log("\n── 不误判人名（这是最重要的一条）──");

ok("⑧ 分隔符 · / 「」 出现 → 留空（人名常见形态）", () => {
  assert.equal(cat("拉斯提/男性原版"), "", "「/」通常是人名的性别/版本标注");
  assert.equal(cat("莉娜·许奈德"), "", "「·」是东亚与西人名分隔符");
  assert.equal(cat("V·I 佛洛依特"), "", "西人名罗马数字缩写");
  assert.equal(cat("V·V 霍金斯"), "", "同型");
  assert.equal(cat("V.II 史奈尔"), "", "有点是分隔符");
});

ok("⑨ 明确的人物标记（男/女/原版结尾）→ 留空", () => {
  assert.equal(cat("拉斯提男性原版"), "");
  assert.equal(cat("莉娜女性"), "");
});

ok("⑩ 名字含「·」或「/」一律不猜（宁可空着）", () => {
  // 真库里 27 条角色至少 15 条含「·」或「/」，启发式必须全空
  const humans = [
    "拉斯提/男性原版", "莉娜·许奈德", "V·I 佛洛依特", "V·V 霍金斯",
    "V.II 史奈尔", "V.III 欧基夫", "V.IV 拉斯提", "V.VI 梅特琳克",
    "V.VII 史温伯恩", "V.VIII 培特", "V·V 霍金斯", "诚恳·布鲁杜",
    "珂若尔与机甲", "卡拉与话多", "指导手沃尔特"
  ];
  for (const name of humans) {
    assert.equal(cat(name), "", `"${name}" 猜成 "${cat(name)}"`);
  }
});

console.log("\n── 兜底桶不再膨胀 ──");

ok("⑪ 章节、事件、剧情线归空（宁可空着）", () => {
  assert.equal(cat("第一章"), "");
  assert.equal(cat("第一章-偷渡"), "");
  assert.equal(cat("第一章-调查BAWS第二工厂 / 妨碍强制监察"), "", "含「/」→ 留空");
  assert.equal(cat("第三章-旧宇宙港防卫"), "", "含港但结尾是「卫」→ 不猜");
  assert.equal(cat("终章-结局"), "");
});

ok("⑫ 能力/物品/事件/设定等杂项归空", () => {
  assert.equal(cat("霜语血脉"), "");
  assert.equal(cat("交感同操"), "");
  assert.equal(cat("好感度"), "");
  assert.equal(cat("随机池"), "");
  assert.equal(cat("allmind"), "");
  assert.equal(cat("交感同操战斗COT"), "");
});

console.log("\n── 批量接口 ──");

ok("⑬ guessForAll 只对 id 有效；空 id 跳过", () => {
  const items = [
    { id: "A", name: "哨塔" },
    { id: "B", name: "企业-许奈德" },
    { id: "", name: "哨塔" },
    { name: "哨塔" },
    null
  ];
  const map = guessForAll(items);
  assert.equal(map.get("A"), "地点");
  assert.equal(map.get("B"), "组织");
  assert.equal(map.has(""), false, "空 id 不该进 map");
  assert.equal(map.has("哨塔"), false, "没有 id 的项不该进 map");
  assert.equal(map.size, 2);
});

ok("⑭ 对已填 category 的条目不改（只算启发式，不写回）", () => {
  // guessCategory 是纯函数，不看 category 字段
  assert.equal(guessCategory({ id: "x", name: "哨塔", category: "物品" }), "地点");
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
