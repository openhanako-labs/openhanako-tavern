// test/regression-director-multi.mjs — 一场绑多条公式：顺序、优先级、按名路由
//
// 为什么要测这个：
//   2026-09-28 之前一场只绑一条公式，所以「顺序」和「优先级」两个字段
//   在引擎里**没有语义**——没有第二个选手，排序排给谁看。
//
//   改成多条之后它们才有意义，而两个字段回答的是**不同的问题**：
//     order    —— 「谁先写」：影响块在 prompt 里的先后
//     priority —— 「谁算数」：两条都声明同名量时，谁的值留下
//
//   最容易搞混的就是把这两个当成一件事。这个测试把它们的差别钉死：
//   把 order 和 priority 分别改成相反方向，结果必须不同。

import assert from "node:assert/strict";
import { createDirectorEntity } from "../lib/director/model.js";
import { sortByOrder, ownerOfVar, settleMany } from "../lib/director/engine.js";
import { renderDirectorBlocks } from "../lib/director/prompt.js";

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { fail++; console.log("  ✗ " + name + "\n      " + (e?.message ?? e)); }
}

/** 造一条最小公式。 */
const mk = (over = {}) => createDirectorEntity({
  id: "d1", name: "公式", state: { 张力: { init: 0, min: 0, max: 10 } },
  rules: [{ when: "always", effect: "张力 += 1" }],
  ...over
});

console.log("\n── ① order：注入先后 ──");

ok("order 小的排前面", () => {
  const a = mk({ id: "a", order: 3 });
  const b = mk({ id: "b", order: 1 });
  const c = mk({ id: "c", order: 2 });
  assert.deepEqual(sortByOrder([a, b, c]).map(e => e.id), ["b", "c", "a"]);
});

ok("同 order → 保持原数组顺序（稳定）", () => {
  const a = mk({ id: "a", order: 1 });
  const b = mk({ id: "b", order: 1 });
  const c = mk({ id: "c", order: 1 });
  assert.deepEqual(sortByOrder([a, b, c]).map(e => e.id), ["a", "b", "c"]);
});

ok("order 缺失 / 非法 → 当 1 处理（不 NaN）", () => {
  const a = mk({ id: "a" });
  const b = mk({ id: "b", order: 0 });
  const sorted = sortByOrder([a, b]);
  assert.equal(sorted.length, 2, "排序把元素弄丢了");
  assert.deepEqual(sorted.map(e => e.id), ["b", "a"], "order=0 应排在默认 1 之前");
});

ok("空输入 → 空数组（不抛）", () => {
  assert.deepEqual(sortByOrder([]), []);
  assert.deepEqual(sortByOrder(null), []);
});

console.log("\n── ② priority：状态同名时谁算数 ──");

ok("只有一条声明该名字 → 它就是主人", () => {
  const a = mk({ id: "a", state: { 张力: { init: 0 } } });
  const b = mk({ id: "b", state: { 好感: { init: 0 } } });
  const { owner } = ownerOfVar([a, b], "张力");
  assert.equal(owner.id, "a");
});

ok("两条都声明 → priority 大的赢", () => {
  const a = mk({ id: "a", priority: 100, state: { 张力: { init: 0 } } });
  const b = mk({ id: "b", priority: 300, state: { 张力: { init: 0 } } });
  const { owner, losers } = ownerOfVar([a, b], "张力");
  assert.equal(owner.id, "b", "高优先级没赢");
  assert.deepEqual(losers.map(e => e.id), ["a"]);
});

ok("同 priority → order 小的赢（先写的占位）", () => {
  const a = mk({ id: "a", priority: 100, order: 5, state: { 张力: { init: 0 } } });
  const b = mk({ id: "b", priority: 100, order: 1, state: { 张力: { init: 0 } } });
  const { owner } = ownerOfVar([a, b], "张力");
  assert.equal(owner.id, "b", "同优先级时应按 order 小的");
});

ok("没人声明 → owner 为 null", () => {
  const a = mk({ id: "a", state: { 好感: { init: 0 } } });
  const { owner } = ownerOfVar([a], "张力");
  assert.equal(owner, null);
});

ok("关掉的公式不参与认领", () => {
  const a = mk({ id: "a", priority: 999, enabled: false, state: { 张力: { init: 0 } } });
  const b = mk({ id: "b", priority: 100, state: { 张力: { init: 0 } } });
  const { owner } = ownerOfVar([a, b], "张力");
  assert.equal(owner.id, "b", "关掉的公式抢走了认领权");
});

console.log("\n── ③ order 与 priority 是两件事（关键）──");

ok("把 priority 反过来，主人就换人（order 不变）", () => {
  const a = mk({ id: "a", order: 1, priority: 100, state: { 张力: { init: 0 } } });
  const b = mk({ id: "b", order: 2, priority: 300, state: { 张力: { init: 0 } } });
  const first = ownerOfVar([a, b], "张力").owner.id;

  // 只动 priority
  const a2 = mk({ id: "a", order: 1, priority: 500, state: { 张力: { init: 0 } } });
  const b2 = mk({ id: "b", order: 2, priority: 100, state: { 张力: { init: 0 } } });
  const second = ownerOfVar([a2, b2], "张力").owner.id;

  assert.notEqual(first, second, "改了 priority 主人没变——那这两个字段就是同一个东西");
});

ok("把 order 反过来（priority 同），主人也换人", () => {
  const a = mk({ id: "a", order: 1, priority: 100, state: { 张力: { init: 0 } } });
  const b = mk({ id: "b", order: 2, priority: 100, state: { 张力: { init: 0 } } });
  const first = ownerOfVar([a, b], "张力").owner.id;

  const a2 = mk({ id: "a", order: 9, priority: 100, state: { 张力: { init: 0 } } });
  const b2 = mk({ id: "b", order: 2, priority: 100, state: { 张力: { init: 0 } } });
  const second = ownerOfVar([a2, b2], "张力").owner.id;

  assert.notEqual(first, second);
});

console.log("\n── ④ 结算一批：各归各家 ──");

ok("两条公式各推各的，互不干扰", () => {
  const a = mk({ id: "a", name: "A", state: { 张力: { init: 0, min: 0, max: 10 } },
                 rules: [{ when: "always", effect: "张力 += 2" }] });
  const b = mk({ id: "b", name: "B", state: { 好感: { init: 0, min: 0, max: 10 } },
                 rules: [{ when: "always", effect: "好感 += 3" }] });
  const r = settleMany([a, b], { a: { 张力: 0 }, b: { 好感: 0 } }, []);
  assert.equal(r.states.a.张力, 2);
  assert.equal(r.states.b.好感, 3);
});

ok("上报按名路由：张力只进声明了它的那条", () => {
  const a = mk({ id: "a", name: "A", state: { 张力: { init: 0, min: 0, max: 10 } },
                 rules: [{ when: "always", effect: "张力 += 0" }] });
  const b = mk({ id: "b", name: "B", state: { 好感: { init: 0, min: 0, max: 10 } },
                 rules: [{ when: "always", effect: "好感 += 0" }] });
  const r = settleMany([a, b], { a: { 张力: 0 }, b: { 好感: 0 } },
                       [{ kind: "num", name: "张力", op: "+", value: 5 }]);
  assert.equal(r.states.a.张力, 5, "张力没进 A");
  assert.equal(r.states.b.好感, 0, "张力错误地进了 B");
});

ok("同名量 + 优先级 → 高优先级的收，低优先级的记 rejected", () => {
  const a = mk({ id: "a", name: "低", priority: 100, state: { 张力: { init: 0, min: 0, max: 10 } },
                 rules: [{ when: "always", effect: "张力 += 0" }] });
  const b = mk({ id: "b", name: "高", priority: 300, state: { 张力: { init: 0, min: 0, max: 10 } },
                 rules: [{ when: "always", effect: "张力 += 0" }] });
  const r = settleMany([a, b], { a: { 张力: 0 }, b: { 张力: 0 } },
                       [{ kind: "num", name: "张力", op: "+", value: 4 }]);
  assert.equal(r.states.b.张力, 4, "高优先级那条没收到");
  assert.equal(r.states.a.张力, 0, "低优先级那条不该收到");
  assert.ok(r.rejected.some(x => /优先接管/.test(x.rejected || "")),
    "低优先级那条被接管时应该留一条 rejected");
});

ok("没人声明的上报 → rejected，不静默吞", () => {
  const a = mk({ id: "a", state: { 张力: { init: 0 } }, rules: [{ when: "always", effect: "张力 += 0" }] });
  const r = settleMany([a], { a: { 张力: 0 } },
                       [{ kind: "num", name: "不存在", op: "+", value: 1 }]);
  assert.ok(r.rejected.some(x => /没有任何公式声明过/.test(x.rejected || "")));
});

ok("关掉的公式不参与结算", () => {
  const a = mk({ id: "a", enabled: false, state: { 张力: { init: 0, min: 0, max: 10 } },
                 rules: [{ when: "always", effect: "张力 += 5" }] });
  const b = mk({ id: "b", state: { 好感: { init: 0, min: 0, max: 10 } },
                 rules: [{ when: "always", effect: "好感 += 1" }] });
  const r = settleMany([a, b], { a: { 张力: 0 }, b: { 好感: 0 } }, []);
  assert.equal(r.states.a.张力, 0, "关掉的公式还在推");
  assert.equal(r.states.b.好感, 1);
});

ok("changes 带上来源公式（界面要知道是谁推的）", () => {
  const a = mk({ id: "a", name: "甲", state: { 张力: { init: 0, min: 0, max: 10 } },
                 rules: [{ when: "always", effect: "张力 += 1" }] });
  const r = settleMany([a], { a: { 张力: 0 } }, []);
  const ch = r.changes.find(c => c.name === "张力");
  assert.ok(ch, "没记下变化");
  assert.equal(ch.directorId, "a");
  assert.equal(ch.directorName, "甲");
});

console.log("\n── ⑤ 多块注入 ──");

ok("单条：输出与旧行为一致（块头不带名字）", () => {
  const a = mk({ id: "a", name: "三幕剧", state: { 张力: { init: 0, max: 10 } } });
  const r = renderDirectorBlocks([{ entity: a, state: { 张力: 0 } }]);
  assert.ok(/【导演 · 本轮】/.test(r.text), "块头变了");
  assert.ok(!/三幕剧/.test(r.text.split("\n")[0]), "单条时块头不该带名字");
  assert.ok(/这一段覆盖本轮的一切收尾指令/.test(r.text), "单条应用「这一段」的说法");
});

ok("多条：每块带名字（否则两个一样的块头会被当成重复）", () => {
  const a = mk({ id: "a", name: "三幕剧", state: { 张力: { init: 0, max: 10 } } });
  const b = mk({ id: "b", name: "悬疑", state: { 悬疑: { init: 0, max: 8 } },
                 rules: [{ when: "always", effect: "悬疑 += 1" }] });
  const r = renderDirectorBlocks([{ entity: a, state: { 张力: 0 } }, { entity: b, state: { 悬疑: 0 } }]);
  assert.ok(/【导演 · 本轮 · 三幕剧】/.test(r.text), "缺第一个名字");
  assert.ok(/【导演 · 本轮 · 悬疑】/.test(r.text), "缺第二个名字");
});

ok("多条：覆盖声明只出现一次，且改成「以上各段」", () => {
  const a = mk({ id: "a", name: "甲", state: { 张力: { init: 0, max: 10 } } });
  const b = mk({ id: "b", name: "乙", state: { 悬疑: { init: 0, max: 8 } },
                 rules: [{ when: "always", effect: "悬疑 += 1" }] });
  const r = renderDirectorBlocks([{ entity: a, state: { 张力: 0 } }, { entity: b, state: { 悬疑: 0 } }]);
  const hits = (r.text.match(/硬约束/g) || []).length;
  assert.equal(hits, 1, `覆盖声明出现了 ${hits} 次——每块各说一次会互相否定`);
  assert.ok(/以上各段约束共同覆盖/.test(r.text), "多条的措辞应该是「以上各段」");
});

ok("多条：块按传入顺序排列（调用方负责先 sortByOrder）", () => {
  const a = mk({ id: "a", name: "甲", state: { 张力: { init: 0, max: 10 } } });
  const b = mk({ id: "b", name: "乙", state: { 悬疑: { init: 0, max: 8 } },
                 rules: [{ when: "always", effect: "悬疑 += 1" }] });
  const r = renderDirectorBlocks([{ entity: b, state: { 悬疑: 0 } }, { entity: a, state: { 张力: 0 } }]);
  assert.ok(r.text.indexOf("乙") < r.text.indexOf("甲"), "块没按传入顺序");
});

ok("空输入 → 空文本", () => {
  assert.equal(renderDirectorBlocks([]).text, "");
  assert.equal(renderDirectorBlocks(null).text, "");
});

ok("全关掉的公式 → 空文本", () => {
  const a = mk({ id: "a", enabled: false });
  assert.equal(renderDirectorBlocks([{ entity: a, state: {} }]).text, "");
});

console.log("\n" + "=".repeat(50));
console.log(`${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
