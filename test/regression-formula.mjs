// test/regression-formula.mjs — 公式求值器（cwv1 第 2 期）
// node test/regression-formula.mjs

import { evalFormula, isFormula, FormulaError } from "../lib/story/formula.js";

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  ✅ " + label); }
  else { fail++; console.log("  ❌ " + label); }
}

const vars = { 体力: 100, "薇拉.好感度": 3, 灵力: 50, 敏捷: 8, "敌人.防御": 20 };

// ── 数字与算术 ──
ok(evalFormula("10") === 10, "纯数字");
ok(evalFormula("0.5") === 0.5, "小数");
ok(evalFormula("-3") === -3, "负数（一元减）");
ok(evalFormula("1+2*3") === 7, "乘除优先");
ok(evalFormula("(1+2)*3") === 9, "括号");
ok(evalFormula("10-4-3") === 3, "左结合");

// ── 变量 ──
ok(evalFormula("{体力}", vars) === 100, "变量取值");
ok(evalFormula("{薇拉.好感度}", vars) === 3, "层级变量");
ok(evalFormula("{体力} - 10", vars) === 90, "变量运算");
ok(evalFormula("{不存在的变量} + 5", vars) === 5, "变量不存在按 0 起");
ok(evalFormula("{敌人.防御} * 2", vars) === 40, "敌人命名空间");

// ── 函数 ──
ok(evalFormula("max(1,2,3)") === 3, "max");
ok(evalFormula("min({体力}, 50)", vars) === 50, "min 含变量");
ok(evalFormula("floor(3.7)") === 3, "floor");
ok(evalFormula("abs(-5)") === 5, "abs");
try { evalFormula("evil(1)"); ok(false, "未知函数应报错"); } catch (e) { ok(e instanceof FormulaError, "未知函数报错"); }

// ── 骰子（范围判定，不锁死具体值）──
for (let i = 0; i < 20; i++) {
  const v = evalFormula("d20");
  if (v < 1 || v > 20) { ok(false, "d20 范围"); break; }
}
ok(true, "d20 在 1-20 之间");
for (let i = 0; i < 20; i++) {
  const v = evalFormula("2d6");
  if (v < 2 || v > 12) { ok(false, "2d6 范围"); break; }
}
ok(true, "2d6 在 2-12 之间");
for (let i = 0; i < 20; i++) {
  const v = evalFormula("d6+3");
  if (v < 4 || v > 9) { ok(false, "d6+3 范围"); break; }
}
ok(true, "d6+3 在 4-9 之间");

// ── 比较 ──
ok(evalFormula("{敏捷} >= 12", vars) === 0, "比较为假 → 0");
ok(evalFormula("{敏捷} >= 5", vars) === 1, "比较为真 → 1");
ok(evalFormula("d20 + {敏捷} >= 12", vars) !== undefined, "骰子+变量比较");

// ── isFormula 判定 ──
ok(isFormula("10") === false, "纯数字不是公式");
ok(isFormula("-3") === false, "负数不是公式");
ok(isFormula("{体力}") === true, "变量是公式");
ok(isFormula("d20") === true, "骰子是公式");
ok(isFormula("max(1,2)") === true, "函数是公式");
ok(isFormula("1+2") === true, "运算是公式");

// ── 错误路径 ──
try { evalFormula("1/0"); ok(false, "除零应报错"); } catch (e) { ok(e instanceof FormulaError, "除零报错"); }
try { evalFormula("{"); ok(false, "未闭合变量应报错"); } catch (e) { ok(e instanceof FormulaError, "未闭合变量报错"); }
try { evalFormula("process.exit()"); ok(false, "危险标识应报错"); } catch (e) { ok(e instanceof FormulaError, "危险标识报错（无 eval）"); }

// ── 战斗场景实测 ──
ok(evalFormula("{攻击} * (1 + {灵力}/100) - {敌人.防御}", { 攻击: 30, 灵力: 50, "敌人.防御": 20 }) === 25, "战斗公式：30*(1+50/100)-20=25");

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
