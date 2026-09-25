// test/regression-var-replace.mjs —— 变量引用：中文名要认，宏不能被误当变量
//
// 起因是界面上一个自相矛盾的场面：面板写着「输入文本（支持 {{variable}}）」，
// 而底下两个正则写的是 /\{\{(\w+(?:\.\w+)*)\}\}/——`\w` 不认中文。
// 于是中文变量（我们自己的数据里就是 `好感`）既不展开、也不算「引用」，
// 面板会一本正经地说「没引用到任何变量」。
//
// 命在两处：
//   · 中文名要认（宏引擎认、定义仓也允许，这里没理由不认）
//   · `{{roll::1d6}}` / `{{getvar::好感}}` 是**宏**，不能被当成变量引用去展开

import assert from "node:assert";

const { parseVariableReferences, replaceVariables } = await import("../lib/variables/model.js");

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 变量引用 ===");

ok("中文名认出来，并且真的展开", () => {
  const text = "好感是 {{好感}}。";
  const refs = parseVariableReferences(text);
  assert.strictEqual(refs.length, 1, `没认出引用：${JSON.stringify(refs)}`);
  assert.strictEqual(refs[0].name, "好感");
  assert.strictEqual(replaceVariables(text, { 好感: "6" }), "好感是 6。");
});

ok("英文名照旧", () => {
  assert.strictEqual(replaceVariables("你好 {{name}}", { name: "月曦夜" }), "你好 月曦夜");
});

ok("嵌套属性照旧（user.name）", () => {
  assert.strictEqual(replaceVariables("{{user.name}}", { user: { name: "薇拉" } }), "薇拉");
});

ok("**宏不是变量引用**：{{roll::1d6}} / {{getvar::好感}} 不许被碰", () => {
  const text = "掷 {{roll::1d6}} 把 {{getvar::好感}} 拿出来";
  const after = replaceVariables(text, { 好感: "6", roll: "不该用这个" });
  assert.strictEqual(after, text, `宏被当成变量展开了：${after}`);
  assert.strictEqual(parseVariableReferences(text).length, 0, "宏被算成了变量引用");
});

ok("没给值的名字：原样保留，不变成空串（空串会让人以为是值本身是空）", () => {
  assert.strictEqual(replaceVariables("a {{没给}} b", { 别的: "1" }), "a {{没给}} b");
});

ok("面板给的例子确实是支持的写法（占位符与说明口径一致）", () => {
  // 界面上那行 placeholder：你好 {{name}}，今天是 {{date}}
  const out = replaceVariables("你好 {{name}}，今天是 {{date}}", { name: "月曦夜", date: "2026-09-25" });
  assert.strictEqual(out, "你好 月曦夜，今天是 2026-09-25");
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
