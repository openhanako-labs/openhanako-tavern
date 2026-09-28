// test/regression-scene-marker.mjs — [场景] 标记抽取（第 2 批 2.2）
//
// 判据来自 docs/spec-scene-illustration.md：
//   · 全角 [场景] 是硬要求
//   · 只取紧邻 [场景] 的同一行
//   · 描述 1–200 汉字，空 / 超长视为无标记
//   · 多标记只取第一块，其余数进 extras
//   · 描述里的宏原样存，不展开
//
// 反证：
//   · 把 head 换成 /\[Scene\]/i → ④ ⑤ 直接红
//   · 把 MAX_LEN 放到 2000 → ⑥ 直接红
//   · 把 extras 计数逻辑删掉 → ③ 直接红
//   · 把 prompt.trim() 改成不 trim → ② 直接红
//   · 把剥离逻辑删掉 → ② 直接红

import assert from "node:assert/strict";
import {
  extractSceneMarker,
  isValidDescription,
  sceneMarkerInstruction,
  SCENE_MARKER_MAX_LEN,
  SCENE_MARKER_HEAD
} from "../lib/illustration/scene-marker.js";

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

// ── ① 无标记 ──
ok("① 无标记：原样返回，hasMarker=false", () => {
  const r = extractSceneMarker("今天天气很好。");
  assert.equal(r.text, "今天天气很好。");
  assert.equal(r.marker, null);
  assert.equal(r.prompt, null);
  assert.equal(r.extras, 0);
  assert.equal(r.hasMarker, false);
});

// ── ② 主用例：末尾一个标记 ──
ok("② 末尾一个标记：抽取描述、剥离原文、extras=0", () => {
  const input = `她靠在窗边，慢慢抬眼。[场景] ${"窗边的剪影，午后光线斜着切进屋内".padEnd(20, ".")}\n`;
  const r = extractSceneMarker(input);
  assert.equal(r.hasMarker, true);
  assert.equal(r.extras, 0);
  assert.ok(r.prompt.startsWith("窗边的剪影"), "prompt 应保留描述原文");
  // 原文里 [场景] 那一整行都不该出现
  assert.equal(r.text.includes("[场景]"), false);
  assert.ok(r.text.includes("她靠在窗边"), "原文的其他行要保留");
});

// ── ③ 多标记 ──
ok("③ 多标记：取第一块，extras 数其余数量", () => {
  const r = extractSceneMarker("正文。\n[场景] 第一块描述\n[场景] 第二块描述");
  assert.equal(r.hasMarker, true);
  assert.equal(r.marker, "第一块描述");
  assert.equal(r.extras, 1, "多了一块应数进 extras");
  assert.equal(r.text.includes("[场景]"), false, "两块的 [场景] 都该从 text 里剥掉");
});

// ── ④ 标记里带换行：只取同一行 ──
ok("④ 标记后紧跟换行 → 描述为空，视为无标记", () => {
  const r = extractSceneMarker("正文。\n[场景]\n下一行是正文的续写");
  assert.equal(r.hasMarker, false);
  assert.equal(r.prompt, null);
  // 原文里那个 [场景] 也算"模型写崩了"，保留原样（不剥离）
  assert.equal(r.text, "正文。\n[场景]\n下一行是正文的续写");
});

ok("④b 标记后跟空字符串 → 无标记", () => {
  const r = extractSceneMarker("正文 [场景]");
  assert.equal(r.hasMarker, false);
});

// ── ⑤ 标记里有 {{char}} 宏 ──
ok("⑤ 描述里有 {{char}} 宏 → 原样存进 prompt，不展开", () => {
  const r = extractSceneMarker("正文。\n[场景] {{char}} 站在雨里，肩膀微微发抖。");
  assert.equal(r.hasMarker, true);
  assert.equal(r.prompt, "{{char}} 站在雨里，肩膀微微发抖。");
  assert.ok(r.prompt.includes("{{char}}"), "宏不该被展开");
});

// ── ⑥ 英文方括号不算 ──
ok("⑥ [Scene] 不算标记（词必须是中文「场景」；方括号是半角）", () => {
  const r = extractSceneMarker("正文 [Scene] 这是描述");
  assert.equal(r.hasMarker, false);
  assert.equal(r.prompt, null);
});

// ── ⑦ 超长描述 ──
ok("⑦ 描述超过 200 字 → 视为无标记", () => {
  const long = "长".repeat(SCENE_MARKER_MAX_LEN + 1);
  const r = extractSceneMarker(`正文。\n[场景] ${long}`);
  assert.equal(r.hasMarker, false);
  assert.equal(r.prompt, null);
});

ok("⑦b 描述刚好 200 字 → 有效", () => {
  const at = "字".repeat(SCENE_MARKER_MAX_LEN);
  const r = extractSceneMarker(`正文。\n[场景] ${at}`);
  assert.equal(r.hasMarker, true);
  assert.equal(r.prompt.length, SCENE_MARKER_MAX_LEN);
});

// ── ⑧ 位置：不强制末尾 ──
ok("⑧ 标记在正文中间也算（写崩了但格式对）", () => {
  const r = extractSceneMarker("开头的话。\n[场景] 中间场景\n结尾的话。");
  assert.equal(r.hasMarker, true);
  assert.equal(r.marker, "中间场景");
});

// ── ⑨ isValidDescription ──
ok("⑨ isValidDescription：空串 false，边界值 true", () => {
  assert.equal(isValidDescription(""), false);
  assert.equal(isValidDescription("   "), false);
  assert.equal(isValidDescription("a"), true);
  assert.equal(isValidDescription("字".repeat(200)), true);
  assert.equal(isValidDescription("字".repeat(201)), false);
  assert.equal(isValidDescription(null), false);
  assert.equal(isValidDescription(undefined), false);
});

// ── ⑩ 常量：契约 ──
ok("⑩ SCENE_MARKER_HEAD 与 MAX_LEN 都是导出常量（改它们等于改契约）", () => {
  assert.equal(SCENE_MARKER_HEAD, "[场景]");
  assert.equal(SCENE_MARKER_MAX_LEN, 200);
});

// ── ⑪ 幂等：无标记时 text 完全没动 ──
ok("⑪ 无标记时 text === 原文（连尾空格都不动）", () => {
  const input = "行一   \n行二\t\n";
  const r = extractSceneMarker(input);
  assert.equal(r.text, input);
});

// ── ⑫ 指令与解析器必须一致（这是今天新加的一环） ──
//
// 为何单钉这一条：现在 App 会往提示词里注入一句“该怎么写标记”的指令。
// 如果指令里那串字符和解析器认的不是同一个，模型照着写也永远认不出来——
// 而且**不报错**，看起来只是“模型没配合”。
// 所以这里不抄字面量，而是**从指令自己身上取**那串字符去喂解析器。
ok("⑫ 指令里出现的那串字符，解析器必须认（写了就得生效）", () => {
  const ins = sceneMarkerInstruction();

  assert.ok(ins.includes(SCENE_MARKER_HEAD), "指令里得有那个标记");
  assert.ok(ins.includes(String(SCENE_MARKER_MAX_LEN)), "指令里得说清长度上限");
  assert.ok(ins.length < 200, `指令别写太长（实际 ${ins.length} 字）——它每轮都进 prompt`);

  // 从指令里真的把标记那串字符取出来，当作模型照抄的结果
  const i = ins.indexOf(SCENE_MARKER_HEAD);
  const literal = ins.slice(i, i + SCENE_MARKER_HEAD.length);
  const reply = `她推开门。\n${literal} 雪夜里的旧车站，风把她的围巾掀起来。`;
  const r = extractSceneMarker(reply);

  assert.equal(r.hasMarker, true, "照指令写的标记认不出来——指令与解析器不一致");
  assert.equal(r.prompt, "雪夜里的旧车站，风把她的围巾掀起来。");
  assert.ok(!r.text.includes(SCENE_MARKER_HEAD), "标记不该留在正文里");
});

console.log("");
if (failed.length) {
  console.error(`❌ 场景标记抽取：${pass} 过 / ${failed.length} 败`);
  process.exit(1);
}
console.log(`✅ 场景标记抽取：${pass} 过 / 0 败`);
