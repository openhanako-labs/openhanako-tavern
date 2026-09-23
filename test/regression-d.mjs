// test/regression-d.mjs — D2/D3/D4 回归
//
// D2 正则规则（三层 scope × 三 surface）
// D3 变量补丁校验
// D4 Markdown 渲染

import assert from "node:assert/strict";
import {
  RegexScope,
  RegexSurface,
  createRegexRule,
  appliesToSurface,
  scopeMatches,
  applyRules,
  fromStRegexScript,
  fromStRegexScripts,
  toStRegexScript
} from "../lib/regex/engine.js";
import {
  PatchPolicy,
  validateValue,
  validatePatch,
  mergeState,
  extractPatch,
  inferType
} from "../lib/variables/patch.js";
import { VariableType } from "../lib/variables/model.js";
import { renderMarkdown, stripMarkdown, renderPlain } from "../ui/assets/modules/markdown.js";

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

console.log("\nD2 · 正则规则\n" + "─".repeat(50));

test("scope 匹配：global 永远匹配", () => {
  assert.equal(scopeMatches({ scope: RegexScope.GLOBAL }, {}), true);
  assert.equal(scopeMatches({ scope: RegexScope.GLOBAL }, { characterId: "x" }), true);
});

test("scope 匹配：character 需 id 一致", () => {
  const rule = { scope: RegexScope.CHARACTER, scopeId: "c1" };
  assert.equal(scopeMatches(rule, { characterId: "c1" }), true);
  assert.equal(scopeMatches(rule, { characterId: "c2" }), false);
  assert.equal(scopeMatches(rule, {}), false);
});

test("surface：Display 判定是 !promptOnly（ST 语义）", () => {
  // 没标 promptOnly → 作用于 Display
  assert.equal(appliesToSurface({ promptOnly: false }, RegexSurface.DISPLAY), true);
  // 标了 promptOnly → 不作用于 Display
  assert.equal(appliesToSurface({ promptOnly: true }, RegexSurface.DISPLAY), false);
});

test("surface：Prompt 判定是 !markdownOnly", () => {
  assert.equal(appliesToSurface({ markdownOnly: false }, RegexSurface.PROMPT), true);
  assert.equal(appliesToSurface({ markdownOnly: true }, RegexSurface.PROMPT), false);
});

test("surface：Stored 需要 runOnEdit", () => {
  assert.equal(appliesToSurface({ runOnEdit: false }, RegexSurface.STORED), false);
  assert.equal(appliesToSurface({ runOnEdit: true }, RegexSurface.STORED), true);
});

test("disabled 规则不生效", () => {
  assert.equal(appliesToSurface({ disabled: true, promptOnly: false }, RegexSurface.DISPLAY), false);
});

test("applyRules 基本替换", () => {
  const rules = [createRegexRule({ pattern: "\\{\\{char\\}\\}", replacement: "艾莉丝" })];
  const r = applyRules("你好 {{char}}", rules, { surface: RegexSurface.PROMPT });
  assert.equal(r.text, "你好 艾莉丝");
  assert.equal(r.applied.length, 1);
});

test("applyRules 按 order 排序执行", () => {
  const rules = [
    createRegexRule({ pattern: "B", replacement: "C", order: 200 }),
    createRegexRule({ pattern: "A", replacement: "B", order: 100 })
  ];
  // A→B 先跑（order 100），然后 B→C
  const r = applyRules("A", rules, { surface: RegexSurface.PROMPT });
  assert.equal(r.text, "C", `应按 order 串行，实际: ${r.text}`);
});

test("applyRules 坏正则不中断", () => {
  const rules = [
    createRegexRule({ pattern: "[invalid(", replacement: "x" }),
    createRegexRule({ pattern: "好", replacement: "妙" })
  ];
  const r = applyRules("好", rules, { surface: RegexSurface.PROMPT });
  assert.equal(r.text, "妙", "好规则仍应生效");
  assert.equal(r.failed.length, 1, "坏规则应被记录");
});

test("applyRules 空文本安全", () => {
  assert.equal(applyRules("", [], {}).text, "");
  assert.equal(applyRules(null, [], {}).text, "");
});

test("ST regex_scripts 导入", () => {
  const rule = fromStRegexScript({
    scriptName: "去括号",
    findRegex: "/（.*?）/g",
    replaceString: "",
    placement: [1, 2],
    promptOnly: false,
    disabled: false
  });
  assert.equal(rule.name, "去括号");
  assert.equal(rule.pattern, "/（.*?）/g");
  assert.equal(rule.extensions._preserved_placement.length, 2);
});

test("ST 往返：导入→导出保持字段", () => {
  const orig = {
    scriptName: "测试",
    findRegex: "/a/g",
    replaceString: "b",
    promptOnly: true,
    markdownOnly: false,
    disabled: false
  };
  const rule = fromStRegexScript(orig);
  const back = toStRegexScript(rule);
  assert.equal(back.scriptName, "测试");
  assert.equal(back.findRegex, "/a/g");
  assert.equal(back.replaceString, "b");
  assert.equal(back.promptOnly, true);
});

test("批量导入跳过坏数据", () => {
  const rules = fromStRegexScripts([
    { scriptName: "好", findRegex: "/a/g" },
    null,
    { scriptName: "也好", findRegex: "/b/g" }
  ]);
  assert.equal(rules.length, 2);
});

console.log("\nD3 · 变量补丁校验\n" + "─".repeat(50));

test("number 类型：字符串数字被转换", () => {
  const r = validateValue({ type: VariableType.NUMBER }, "42");
  assert.equal(r.ok, true);
  assert.equal(r.value, 42);
  assert.equal(r.coerced, true);
});

test("number 类型：非数字被拒", () => {
  const r = validateValue({ type: VariableType.NUMBER }, "abc");
  assert.equal(r.ok, false);
});

test("number 范围检查", () => {
  assert.equal(validateValue({ type: VariableType.NUMBER, min: 0, max: 10 }, 5).ok, true);
  assert.equal(validateValue({ type: VariableType.NUMBER, min: 0, max: 10 }, 11).ok, false);
  assert.equal(validateValue({ type: VariableType.NUMBER, min: 0, max: 10 }, -1).ok, false);
});

test("boolean 类型：字符串转换", () => {
  assert.equal(validateValue({ type: VariableType.BOOLEAN }, "true").value, true);
  assert.equal(validateValue({ type: VariableType.BOOLEAN }, "false").value, false);
  assert.equal(validateValue({ type: VariableType.BOOLEAN }, "maybe").ok, false);
});

test("object 类型：数组被拒", () => {
  assert.equal(validateValue({ type: VariableType.OBJECT }, { a: 1 }).ok, true);
  assert.equal(validateValue({ type: VariableType.OBJECT }, [1, 2]).ok, false);
});

test("choices 枚举检查", () => {
  const def = { type: VariableType.TEXT, choices: ["红", "绿"] };
  assert.equal(validateValue(def, "红").ok, true);
  assert.equal(validateValue(def, "蓝").ok, false);
});

test("STRICT 策略：未知变量被忽略", () => {
  const r = validatePatch({ 已知: 1, 未知: 2 }, [{ name: "已知", type: VariableType.NUMBER }], {
    policy: PatchPolicy.STRICT
  });
  assert.deepEqual(Object.keys(r.accepted), ["已知"]);
  assert.deepEqual(r.unknown, ["未知"]);
});

test("LENIENT 策略：未知变量放行", () => {
  const r = validatePatch({ 未知: 2 }, [], { policy: PatchPolicy.LENIENT });
  assert.equal(r.accepted.未知, 2);
});

test("类型错误被拒且记录原因", () => {
  const r = validatePatch({ hp: "不是数字" }, [{ name: "hp", type: VariableType.NUMBER }]);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].name, "hp");
  assert.ok(r.rejected[0].reason.includes("number"));
});

test("转换被记录", () => {
  const r = validatePatch({ hp: "42" }, [{ name: "hp", type: VariableType.NUMBER }]);
  assert.equal(r.coerced.length, 1);
  assert.equal(r.coerced[0].to, 42);
});

test("mergeState 检测冲突", () => {
  const r = mergeState({ hp: 10 }, { hp: 5 });
  assert.equal(r.state.hp, 5);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].oldValue, 10);
});

test("mergeState 同值不算冲突", () => {
  const r = mergeState({ hp: 10 }, { hp: 10 });
  assert.equal(r.conflicts.length, 0);
});

test("extractPatch：围栏 JSON", () => {
  const p = extractPatch('前置文字\n```json\n{"hp": 10, "mood": "怒"}\n```\n后置');
  assert.equal(p.hp, 10);
  assert.equal(p.mood, "怒");
});

test("extractPatch：var 标签", () => {
  const p = extractPatch('<var name="hp">10</var><var name="mood">愤怒</var>');
  assert.equal(p.hp, 10);
  assert.equal(p.mood, "愤怒");
});

test("extractPatch：无匹配 → 空对象", () => {
  assert.deepEqual(extractPatch("普通文本"), {});
  assert.deepEqual(extractPatch(null), {});
});

test("inferType 类型推断", () => {
  assert.equal(inferType(1), VariableType.NUMBER);
  assert.equal(inferType(true), VariableType.BOOLEAN);
  assert.equal(inferType({}), VariableType.OBJECT);
  assert.equal(inferType("x"), VariableType.TEXT);
});

console.log("\nD4 · Markdown 渲染\n" + "─".repeat(50));

test("斜体与粗体", () => {
  const html = renderMarkdown("*动作* 和 **强调**");
  assert.ok(html.includes("<em>动作</em>"), html);
  assert.ok(html.includes("<strong>强调</strong>"), html);
});

test("行内代码", () => {
  const html = renderMarkdown("用 `code` 标记");
  assert.ok(html.includes("<code>code</code>"));
});

test("代码块", () => {
  const html = renderMarkdown("```\nconst a = 1;\n```");
  assert.ok(html.includes("<pre><code>"));
  assert.ok(html.includes("const a = 1;"));
});

test("引用块", () => {
  const html = renderMarkdown("> 引用内容");
  assert.ok(html.includes("<blockquote>"));
});

test("列表", () => {
  const html = renderMarkdown("- 第一\n- 第二");
  assert.ok(html.includes("<ul>"));
  assert.ok(html.includes("<li>第一</li>"));
});

test("换行保留", () => {
  const html = renderMarkdown("第一行\n第二行");
  assert.ok(html.includes("<br>"));
});

test("HTML 被转义（安全）", () => {
  const html = renderMarkdown("<script>alert(1)</script>");
  assert.ok(!html.includes("<script>"), "不该输出原始 script 标签");
  assert.ok(html.includes("&lt;script&gt;"));
});

test("代码块内的标记不被解析", () => {
  const html = renderMarkdown("```\n**不该变粗**\n```");
  assert.ok(!html.includes("<strong>"), "代码块内不该解析 markdown");
  assert.ok(html.includes("**不该变粗**"));
});

test("stripMarkdown 剥标记", () => {
  const out = stripMarkdown("**粗** 和 *斜* 和 `代码`");
  assert.equal(out, "粗 和 斜 和 代码");
});

test("renderPlain 保留换行且转义", () => {
  const html = renderPlain("a\nb<script>");
  assert.ok(html.includes("<br>"));
  assert.ok(!html.includes("<script>"));
});

test("空输入安全", () => {
  assert.equal(renderMarkdown(""), "");
  assert.equal(renderMarkdown(null), "");
  assert.equal(stripMarkdown(null), "");
});

console.log("\n" + "=".repeat(50));
console.log(`通过 ${passed} / 失败 ${failed}`);
console.log("=".repeat(50));
process.exit(failed > 0 ? 1 : 0);
