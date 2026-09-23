// test/regression-c1.mjs — C1 宏替换引擎回归

import assert from "node:assert/strict";
import { createMacroProcessor, contextFromCharacter, hasMacros, usedMacros } from "../lib/macros/index.js";

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

const mp = createMacroProcessor();
const card = {
  name: "艾莉丝",
  description: "赤发的剑士",
  personality: "暴躁但护短",
  scenario: "黄昏的集市",
  first_mes: "「你挡路了。」",
  mes_example: "{{user}}: 你好\n{{char}}: 哼。",
  system_prompt: "保持角色",
  creator_notes: "测试卡"
};
const ctx = contextFromCharacter(card, { userName: "月曦夜", persona: "旅行者" });

console.log("\nC1 · 角色与用户宏\n" + "─".repeat(50));

test("{{char}} → 角色名", () => {
  assert.equal(mp.process("{{char}}拔出了剑", ctx), "艾莉丝拔出了剑");
});

test("{{user}} → 用户名", () => {
  assert.equal(mp.process("{{user}}，你来了", ctx), "月曦夜，你来了");
});

test("{{persona}} → 人设", () => {
  assert.equal(mp.process("我是{{persona}}", ctx), "我是旅行者");
});

test("大小写不敏感", () => {
  assert.equal(mp.process("{{CHAR}}", ctx), "艾莉丝");
  assert.equal(mp.process("{{Char}}", ctx), "艾莉丝");
  assert.equal(mp.process("{{USER}}", ctx), "月曦夜");
});

test("角色字段宏", () => {
  assert.equal(mp.process("{{description}}", ctx), "赤发的剑士");
  assert.equal(mp.process("{{personality}}", ctx), "暴躁但护短");
  assert.equal(mp.process("{{scenario}}", ctx), "黄昏的集市");
  assert.equal(mp.process("{{first_mes}}", ctx), "「你挡路了。」");
});

test("同一文本多个宏", () => {
  const out = mp.process("{{char}}看着{{user}}，{{personality}}", ctx);
  assert.equal(out, "艾莉丝看着月曦夜，暴躁但护短");
});

console.log("\nC1 · 变量宏\n" + "─".repeat(50));

test("{{getvar}} 读对话变量", () => {
  const c = contextFromCharacter(card, { variables: { hp: 42 } });
  assert.equal(mp.process("HP: {{getvar::hp}}", c), "HP: 42");
});

test("{{setvar}} 写变量（无输出）", () => {
  const vars = {};
  const c = contextFromCharacter(card, { variables: vars });
  const out = mp.process("{{setvar::mood::愤怒}}状态已更新", c);
  assert.equal(out, "状态已更新", "setvar 本身不产生输出");
  assert.equal(vars.mood, "愤怒", "变量应被写入");
});

test("变量简写 {{.x}}", () => {
  const c = contextFromCharacter(card, { variables: { level: 5 } });
  assert.equal(mp.process("Lv.{{.level}}", c), "Lv.5");
});

test("全局变量简写 {{$x}}", () => {
  const c = contextFromCharacter(card, { globalVariables: { gold: 100 } });
  assert.equal(mp.process("金币 {{$gold}}", c), "金币 100");
});

test("变量不存在 → 空串", () => {
  const c = contextFromCharacter(card, { variables: {} });
  assert.equal(mp.process("[{{getvar::nothing}}]", c), "[]");
});

test("嵌套宏：{{getvar::{{char}}_mood}}", () => {
  const c = contextFromCharacter(card, {
    variables: { "艾莉丝_mood": "戒备" }
  });
  assert.equal(mp.process("{{getvar::{{char}}_mood}}", c), "戒备");
});

console.log("\nC1 · 作用域块\n" + "─".repeat(50));

test("{{if}} 为真 → 保留内容", () => {
  const out = mp.process("{{if 有内容}}显示了{{/if}}", ctx);
  assert.equal(out, "显示了");
});

test("{{if}} 为假 → 移除内容", () => {
  const out = mp.process("{{if }}不该出现{{/if}}", ctx);
  assert.equal(out, "");
});

test("{{if}} + {{else}}", () => {
  const c = contextFromCharacter(card, { variables: { flag: "" } });
  const out = mp.process("{{if {{getvar::flag}} }}A{{else}}B{{/if}}", c);
  assert.equal(out, "B");
});

test("条件基于变量", () => {
  const c = contextFromCharacter(card, { variables: { visible: "yes" } });
  assert.equal(mp.process("{{if {{getvar::visible}} }}可见{{/if}}", c), "可见");
});

test("注释块不输出", () => {
  const out = mp.process("前{{// 这是注释}}后", ctx);
  assert.equal(out, "前后");
});

console.log("\nC1 · 工具宏\n" + "─".repeat(50));

test("{{newline}} → 换行", () => {
  assert.equal(mp.process("A{{newline}}B", ctx), "A\nB");
});

test("{{reverse}}", () => {
  assert.equal(mp.process("{{reverse::abc}}", ctx), "cba");
});

test("{{random}} 从候选里选", () => {
  const out = mp.process("{{random::红::绿::蓝}}", ctx);
  assert.ok(["红", "绿", "蓝"].includes(out), `实际: ${out}`);
});

test("{{roll}} 掷骰在合法范围", () => {
  for (let i = 0; i < 30; i++) {
    const n = Number(mp.process("{{roll::1d6}}", ctx));
    assert.ok(n >= 1 && n <= 6, `骰值越界: ${n}`);
  }
});

test("{{roll 2d6+3}} 空格语法", () => {
  for (let i = 0; i < 30; i++) {
    const n = Number(mp.process("{{roll 2d6+3}}", ctx));
    assert.ok(n >= 5 && n <= 15, `骰值越界: ${n}`);
  }
});

console.log("\nC1 · 边界与兼容\n" + "─".repeat(50));

test("转义 \\{\\{ → 原样输出", () => {
  const out = mp.process("\\{\\{notAMacro\\}\\}", ctx);
  assert.equal(out, "{{notAMacro}}");
});

test("未注册的宏 → 原样保留（ST 兼容）", () => {
  const out = mp.process("{{unknown_macro_xyz}}", ctx);
  assert.equal(out, "{{unknown_macro_xyz}}");
});

test("非宏文本原样返回", () => {
  assert.equal(mp.process("普通文本", ctx), "普通文本");
  assert.equal(mp.process("", ctx), "");
  assert.equal(mp.process(null, ctx), "");
});

test("未闭合的花括号不崩", () => {
  const out = mp.process("{{char 没闭合", ctx);
  assert.equal(typeof out, "string");
});

test("hasMacros / usedMacros", () => {
  assert.equal(hasMacros("{{char}}"), true);
  assert.equal(hasMacros("普通文本"), false);
  assert.deepEqual(usedMacros("{{char}} 和 {{user}}"), ["char", "user"]);
});

test("多行角色示例（mes_example）", () => {
  const out = mp.process(card.mes_example, ctx);
  assert.equal(out, "月曦夜: 你好\n艾莉丝: 哼。");
});

console.log("\n" + "=".repeat(50));
console.log(`通过 ${passed} / 失败 ${failed}`);
console.log("=".repeat(50));
process.exit(failed > 0 ? 1 : 0);
