// test/regression-settings-budget.mjs — priority 降序在两处调用点一致
//
// 为什么要测这个：
//   budget.js 和 model.js 各写一份 priority 排序，方向必须一致。
//   一旦不一致，用户把「核心设定」设成 priority=300，预算裁剪（budget.js）
//   会优先保留它，但 getActiveSettings（model.js）把它排到后面——
//   「屏幕上排第一的设定」和「引擎实际用的第一批」不是同一批。
//
// 起因（2026-09-27）：
//   budget.js:44  用 `-priority`（大的先）
//   model.js:208  原本用 `a.priority - b.priority`（小的先）
//   model.js:45   注释还写「数字越小越优先」
//
//   三处各说各话，方向是拿 DiceFrame entry_sort_key 定的：**priority 降序**。
//   这个测试锁住方向，改回来就红。

import assert from "node:assert/strict";
import { entrySortKey, compareEntries } from "../lib/lore/budget.js";
import { getActiveSettings } from "../lib/settings/model.js";

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { fail++; console.log("  ✗ " + name + "\n      " + (e?.message ?? e)); }
}

/** 造一条最小可用的设定。 */
const entry = (over = {}) => ({
  id: "e", name: "n", content: "c", enabled: true,
  keywords: [], priority: 100, order: 1, probability: 100,
  trigger: { type: "always" },
  ...over
});

console.log("\n── priority 方向（引擎的两处调用点）──");

ok("① budget.js：priority 大的先（DiceFrame entry_sort_key 的原义）", () => {
  const a = entry({ id: "A", priority: 100 });
  const b = entry({ id: "B", priority: 300 });
  // compareEntries 返回 -1 表示 a 先
  assert.equal(compareEntries(a, b) < 0, false, "priority=300 应该先，实际 100 先了");
  assert.equal(compareEntries(b, a) < 0, true, "priority=300 应该先，实际没先");
});

ok("② entrySortKey 的第 3 项是 -priority（负号即降序）", () => {
  const key = entrySortKey(entry({ id: "X", priority: 250 }));
  // 键位顺序：isConstant, directMatch, -priority, order, isRecursive, isSemantic, id
  assert.equal(key[2], -250, `第 3 项应为 -250，实际 ${key[2]}`);
});

ok("③ model.js：getActiveSettings 排序方向与 budget.js 一致", () => {
  const items = [
    entry({ id: "low", priority: 100, order: 1 }),
    entry({ id: "mid", priority: 200, order: 2 }),
    entry({ id: "core", priority: 300, order: 3 })
  ];
  const active = getActiveSettings(items, { text: "" }, {});
  const ids = active.map(s => s.id);
  // priority 300 > 200 > 100
  assert.deepEqual(ids, ["core", "mid", "low"], `实际顺序 ${ids.join(", ")}`);
});

ok("④ 两处对同一批输入的相对顺序完全一致（这才是判据）", () => {
  const items = [
    entry({ id: "a", priority: 100, order: 5 }),
    entry({ id: "b", priority: 300, order: 2 }),
    entry({ id: "c", priority: 200, order: 9 }),
    entry({ id: "d", priority: 300, order: 1 }),
    entry({ id: "e", priority: 100, order: 8 })
  ];
  // budget.js 排序
  const byBudget = [...items].sort(compareEntries).map(s => s.id);
  // model.js 排序
  const byModel = getActiveSettings(items, { text: "" }, {}).map(s => s.id);
  // 关键：只看 priority 的相对顺序（相同 priority 下两者会用不同 tie-break，那部分不该锁）
  const priorityOf = Object.fromEntries(items.map(s => [s.id, s.priority]));
  const keyPriority = (ids) => ids.map(id => priorityOf[id]);
  // 降序：300 300 200 100 100
  assert.deepEqual(keyPriority(byBudget), [300, 300, 200, 100, 100], `budget 顺序 ${byBudget}`);
  assert.deepEqual(keyPriority(byModel), [300, 300, 200, 100, 100], `model 顺序 ${byModel}`);
});

ok("⑤ 修改方向的历史坑：priority 值全部相同时不产生排序错误", () => {
  // 100 全同 → 应该按 order 升序（tie-break）
  const items = [
    entry({ id: "a", priority: 100, order: 3 }),
    entry({ id: "b", priority: 100, order: 1 }),
    entry({ id: "c", priority: 100, order: 2 })
  ];
  const active = getActiveSettings(items, { text: "" }, {});
  assert.deepEqual(active.map(s => s.id), ["b", "c", "a"], "priority 全同时按 order 升序");
});

ok("⑥ model.js 里 priority 降序（这是修复的核心断言）", () => {
  const items = [
    entry({ id: "core-300", priority: 300 }),
    entry({ id: "common-200", priority: 200 }),
    entry({ id: "rare-100", priority: 100 })
  ];
  // 打乱输入顺序，验证输出仍然是 300, 200, 100
  const shuffled = [items[2], items[0], items[1]];
  const active = getActiveSettings(shuffled, { text: "" }, {});
  assert.deepEqual(active.map(s => s.priority), [300, 200, 100], "priority 未降序");
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
