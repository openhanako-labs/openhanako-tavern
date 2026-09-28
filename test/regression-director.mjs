// test/regression-director.mjs — 导演层：状态约束引擎
//
// 这一层是配方式文游的**剧情公式**。v1 把它写成节拍清单（beats），
// 被判定为根本方向错——无限的是表面文字，骨架仍被写死。
// v2 换成元规则：规定「满足什么条件时必须发生什么性质的事」，
// 不规定「具体发生什么」。
//
// 所以这个测试盯的是**性质**而不是文字：
//   · 条件在正确的轮次命中（早一轮、晚一轮都算错）
//   · 状态确实被推动，且推不出去的量会被拦住
//   · 模型的上报改得动状态，但改不动配置
//   · 看不懂的语法要报错，不许静默失效

import assert from "node:assert";

const { createDirectorEntity, validateDirectorEntity, initialDirectorState, normalizeDirectorState, hasBaseline, varKindOf } =
  await import("../lib/director/model.js");
const { evalWhen, applyEffect, settle, previewState, describeState } =
  await import("../lib/director/engine.js");
const { parseDirectorReport, stripDirectorReport } = await import("../lib/director/report.js");
const { renderDirectorBlock } = await import("../lib/director/prompt.js");

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log("  ✅ " + name); pass++; }
  catch (e) { console.log("  ❌ " + name + "\n     " + e.message); fail++; }
}

/** 三幕剧那类配方：张力涨、到阈值回落、极高时不可逆。 */
function act() {
  return createDirectorEntity({
    id: "act-3",
    name: "三幕剧",
    state: {
      tension: { init: 1, min: 0, max: 10 },
      turn: { init: 0 },
      confessed: { init: false }
    },
    rules: [
      { when: "always", effect: "tension += 5" },
      { when: "always", effect: "turn += 1" },
      { when: "tension >= 10", effect: "tension = 2", brief: "触发一次不可逆事件" },
      { when: "tension >= 7", effect: "tension -= 4", brief: "必须出现一次正面冲突" },
      { when: "confessed", effect: "tension += 0" }
    ]
  });
}

console.log("\n=== 导演层：状态约束 ===\n");

// ── ① 实体与校验 ──────────────────────────────────────
ok("开关与数值量只按 init 的类型分，不另立字段", () => {
  assert.strictEqual(varKindOf({ init: false }), "flag");
  assert.strictEqual(varKindOf({ init: 1, max: 10 }), "number");
});

ok("一份好配方没有告警", () => {
  assert.deepStrictEqual(validateDirectorEntity(act()), []);
});

ok("写错的地方会被顶回来（不是静默失效）", () => {
  const bad = createDirectorEntity({
    state: { a: { init: 1, min: 9, max: 3 }, "坏 名字": { init: 0 } },
    rules: [
      { when: "always", effect: "a += 1" },
      { when: "always", effect: "b += 1" },        // b 没声明
      { when: "", effect: "a += 1" },              // 缺 when
      { when: "always" }                            // 缺 effect
    ]
  });
  const p = validateDirectorEntity(bad).join(" | ");
  assert.ok(/min 大于 max/.test(p), "没抓到 min>max：" + p);
  assert.ok(/状态名不合法/.test(p), "没抓到非法名字：" + p);
  assert.ok(/"b" 没在 state 里声明/.test(p), "没抓到未声明的量：" + p);
  assert.ok(/缺 when/.test(p) && /缺 effect/.test(p), "没抓到缺字段：" + p);
});

ok("条件里拼错变量名会被顶回来（否则那条规则永远不命中）", () => {
  const bad = createDirectorEntity({
    state: { tension: { init: 1, max: 10 } },
    rules: [
      { when: "always", effect: "tension += 1" },
      { when: "tensin >= 7", effect: "tension = 0", brief: "拼错的那个字母" }
    ]
  });
  const p = validateDirectorEntity(bad).join(" | ");
  assert.ok(/"tensin".*没在 state 里声明/.test(p), "没抓到条件里的错名字：" + p);
});

ok("看不懂的条件在校验期就报，不拖到运行时", () => {
  const bad = createDirectorEntity({
    state: { a: { init: 0 } },
    rules: [{ when: "a ~~ 3", effect: "a += 1" }]
  });
  assert.ok(validateDirectorEntity(bad).some(m => /条件看不懂/.test(m)),
    "`a ~~ 3` 这种该在保存时就被拦住");
});

ok("多处条件引用同一个变量不会重复报", () => {
  const good = createDirectorEntity({
    state: { a: { init: 0, max: 9 } },
    rules: [
      { when: "a >= 1 && a <= 5", effect: "a += 1" },
      { when: "always", effect: "a = 0" }
    ]
  });
  assert.deepStrictEqual(validateDirectorEntity(good), []);
});

ok("一条规则都没有 → 明确说不行", () => {
  assert.ok(validateDirectorEntity(createDirectorEntity({ rules: [] })).some(m => /什么也不做/.test(m)));
});

ok("有没有基线（always 推得动）能判", () => {
  assert.strictEqual(hasBaseline(act()), true);
  assert.strictEqual(hasBaseline(createDirectorEntity({
    state: { a: { init: 0 } },
    rules: [{ when: "a >= 1", effect: "a += 1" }]
  })), false, "只有条件规则、没有基线，状态会永远停在原地");
});

// ── ② 条件求值 ────────────────────────────────────────
ok("always / never / 六种比较", () => {
  const s = { tension: 7 };
  assert.strictEqual(evalWhen("always", s), true);
  assert.strictEqual(evalWhen("never", s), false);
  assert.strictEqual(evalWhen("tension >= 7", s), true);
  assert.strictEqual(evalWhen("tension > 7", s), false);
  assert.strictEqual(evalWhen("tension <= 7", s), true);
  assert.strictEqual(evalWhen("tension < 7", s), false);
  assert.strictEqual(evalWhen("tension == 7", s), true);
  assert.strictEqual(evalWhen("tension != 7", s), false);
});

ok("&& 与 || 能串", () => {
  const s = { tension: 8, turn: 3 };
  assert.strictEqual(evalWhen("tension >= 7 && turn >= 3", s), true);
  assert.strictEqual(evalWhen("tension >= 9 && turn >= 3", s), false);
  assert.strictEqual(evalWhen("tension >= 9 || turn >= 3", s), true);
});

ok("开关当 0/1 用，也能光写名字当条件", () => {
  // `confessed` 单独写 = 「这个开关开着」——用户会这么写，所以得收
  assert.strictEqual(evalWhen("confessed", { confessed: true }), true);
  assert.strictEqual(evalWhen("confessed", { confessed: false }), false);
  assert.strictEqual(evalWhen("confessed >= 1", { confessed: true }), true);
  assert.strictEqual(evalWhen("turn", { turn: 3 }), true, "数值量非零即真");
  assert.strictEqual(evalWhen("turn", { turn: 0 }), false);
});

ok("看不懂的条件**抛错**，不静默返回 false", () => {
  assert.throws(() => evalWhen("tension ~~ 3", {}), /看不懂的条件/);
  assert.throws(() => evalWhen("(tension >= 3)", {}), /看不懂的条件/);
});

// ── ③ 效果 ────────────────────────────────────────────
ok("+= -= = 三种赋值", () => {
  const e = act();
  assert.strictEqual(applyEffect("tension += 2", { tension: 3 }, e).state.tension, 5);
  assert.strictEqual(applyEffect("tension -= 2", { tension: 3 }, e).state.tension, 1);
  assert.strictEqual(applyEffect("tension = 8", { tension: 3 }, e).state.tension, 8);
});

ok("按声明夹住越界（规则是作者写的，可信）", () => {
  const e = act();
  assert.strictEqual(applyEffect("tension += 100", { tension: 1 }, e).state.tension, 10);
  assert.strictEqual(applyEffect("tension -= 100", { tension: 1 }, e).state.tension, 0);
});

ok("效果不改原对象（纯函数）", () => {
  const before = { tension: 3 };
  applyEffect("tension += 1", before, act());
  assert.strictEqual(before.tension, 3);
});

ok("看不懂的效果抛错", () => {
  assert.throws(() => applyEffect("tension **= 2", { tension: 1 }, act()), /看不懂的效果/);
});

// ── ④ 出场状态 ────────────────────────────────────────
ok("出场状态按各变量自己的 init", () => {
  assert.deepStrictEqual(initialDirectorState(act()), { tension: 1, turn: 0, confessed: false });
});

ok("补齐缺失的量，但不丢声明外的数据", () => {
  const s = normalizeDirectorState(act(), { tension: 5, 别的: "用户自己的" });
  assert.strictEqual(s.tension, 5, "已有的值不该被重置");
  assert.strictEqual(s.turn, 0, "缺的该补上");
  assert.strictEqual(s.confessed, false);
  assert.strictEqual(s.别的, "用户自己的", "声明外的量不许被静默丢掉");
});

// ── ⑤ 轮次推进（这一条是它的意义所在） ──────────────────
ok("多轮推进：张力按配方的意图走，冲突在正确的轮次被要求", () => {
  const e = act();
  let s = initialDirectorState(e);
  const trail = [];

  for (let i = 1; i <= 6; i++) {
    const before = s.tension;
    const preview = previewState(e, s);
    // 这一轮摆在模型面前的约束
    const block = renderDirectorBlock(e, s);
    const { state: next } = settle(e, s, []);
    trail.push({ turn: i, before, preview: preview.tension, after: next.tension, block });
    s = next;
  }

  assert.deepStrictEqual(trail.map(t => t.before), [1, 6, 2, 3, 4, 5]);
  assert.deepStrictEqual(trail.map(t => t.after), [6, 2, 3, 4, 5, 2]);
  assert.strictEqual(trail[5].turn, 6, "第 6 轮：5 抬到 10 后不可逆事件落下");

  // 约束的“本轮”标记要出现在预演越线的**那一轮**，不是下一轮
  assert.ok(/▶ 本轮：tension 到 10 时，触发一次不可逆事件/.test(trail[1].block),
    "第 2 轮（预演 11）该标出不可逆事件：\n" + trail[1].block);
  assert.ok(/▶ 本轮：tension 到 7 时，必须出现一次正面冲突/.test(trail[1].block),
    "预演到 11 时两条阈值都该命中：\n" + trail[1].block);
  assert.ok(/· tension 到 10 时|· tension 到 7 时/.test(trail[0].block),
    "第 1 轮两条都不命中，但都得列出来（模型得知道地形）");
  assert.ok(!/▶/.test(trail[0].block), "第 1 轮不该有命中标记");
});

ok("基线与条件写在数组哪个位置都行（两阶段，不看顺序）", () => {
  /*
   * 这条是拿“给用户的示例”反推出来的：我写示例时想把 `张力 += 3` 放到数组末尾
   * 读着更顺，一算才发现结果全变了——因为原来的实现是“顺着数组跑”，
   * 而预览只跑基线。两者一对不上，就会出现“预览说这一轮到 7 了、
   * 结算却没触发 7 的规则”，而且两边都不报错。
   */
  const base = act();
  const reordered = createDirectorEntity({
    ...base,
    rules: [
      { when: "tension >= 10", effect: "tension = 2", brief: "触发一次不可逆事件" },
      { when: "tension >= 7", effect: "tension -= 4", brief: "必须出现一次正面冲突" },
      { when: "always", effect: "tension += 5" },
      { when: "always", effect: "turn += 1" }
    ]
  });

  let a = initialDirectorState(base);
  let b = initialDirectorState(reordered);
  for (let i = 0; i < 6; i++) {
    a = settle(base, a, []).state;
    b = settle(reordered, b, []).state;
  }
  assert.deepStrictEqual(b, a, "把 always 挪到后面就跑出了不同结果——那说明还在看数组顺序");
});

ok("预览与结算对得上：预览算出来的那一格，结算时真的会被判到", () => {
  const e = act();
  // 6 → 基线 +5 = 11：预览应当越过 10，结算也应当真的触发不可逆事件
  const before = { tension: 6, turn: 0, confessed: false };
  // 6 → 基线 +5 = 11，但 max=10 会当场夹住 → 预览是 10，仍然越过 10 这条线
  //（夹住是对的：声明了上限就该夹；但它意味着 `>= 11` 这类阈值永远不可能命中）
  assert.strictEqual(previewState(e, before).tension, 10, "预览没跑基线（或没夹住上限）");
  const after = settle(e, before, []).state;
  assert.strictEqual(after.tension, 2, "结算没按预览的线触发：" + JSON.stringify(after));
});

ok("约束那行是说给模型听的**人话**，不是条件原文", () => {
  const e = createDirectorEntity({
    state: { 张力: { init: 0, min: 0, max: 12 }, 回合: { init: 0 } },
    rules: [
      { when: "always", effect: "张力 += 1" },
      { when: "always", effect: "回合 += 1" },
      { when: "张力 >= 8 && 张力 < 12", effect: "张力 -= 3", brief: "出现一次正面冲突" },
      { when: "回合 <= 3", effect: "回合 += 0", brief: "先铺垫" }
    ]
  });
  const block = renderDirectorBlock(e, initialDirectorState(e));

  // `&&` 不能原样丢给模型——那是在让它读代码
  assert.ok(!/&&/.test(block), "条件原文漏进注入块了：\n" + block);
  assert.ok(/张力 在 8 到 12 之间时/.test(block), "区间没说成人话：\n" + block);
  // `<=` 是「不超过」，不是「降到」——后者听“正在往下走”
  assert.ok(/回合 不超过 3 时/.test(block), "`<=` 的措辞不对：\n" + block);
});

ok("约束列的是全部带 brief 的规则，不是只有命中的那条", () => {
  const block = renderDirectorBlock(act(), initialDirectorState(act()));
  assert.ok(/不可逆事件/.test(block) && /正面冲突/.test(block));
  assert.ok(/本轮发生什么由你决定/.test(block), "少了那句 freeform——它才是「不按清单走」的保障");
});

ok("注入块声明了覆盖收尾指令", () => {
  const block = renderDirectorBlock(act(), initialDirectorState(act()));
  assert.ok(/覆盖本轮的一切收尾指令/.test(block));
});

ok("关掉的配方 / 没规则的配方 → 不注入", () => {
  assert.strictEqual(renderDirectorBlock(null, {}), "");
  assert.strictEqual(renderDirectorBlock(createDirectorEntity({ rules: [] }), {}), "");
  const off = act(); off.enabled = false;
  assert.strictEqual(renderDirectorBlock(off, initialDirectorState(act())), "");
});

// ── ⑥ 模型上报 ────────────────────────────────────────
ok("解析上报，并把它从正文里摘掉", () => {
  const r = parseDirectorReport("他停了一下。\n[状态 tension+2 flag:confessed]\n然后说了出来。");
  assert.strictEqual(r.reports.length, 2);
  assert.deepStrictEqual(r.reports[0], { kind: "num", name: "tension", op: "+", value: 2, raw: "tension+2" });
  assert.deepStrictEqual(r.reports[1], { kind: "flag", name: "confessed", value: true, raw: "flag:confessed" });
  assert.ok(!/\[状态/.test(r.text), "标记不该留在正文里");
  assert.ok(/然后说了出来。/.test(r.text));
});

ok("一条标记里可以塞多个量", () => {
  const r = parseDirectorReport("[状态 tension-1 turn+2]");
  assert.deepStrictEqual(r.reports.map(x => x.name + x.op + x.value), ["tension-1", "turn+2"]);
});

ok("关掉开关的两种写法", () => {
  assert.strictEqual(parseDirectorReport("[状态 flag:!confessed]").reports[0].value, false);
  assert.strictEqual(parseDirectorReport("[状态 -flag:confessed]").reports[0].value, false);
});

ok("看不懂的 token 记进 bad，不装作没看见", () => {
  const r = parseDirectorReport("[状态 tension?? 什么鬼]");
  assert.deepStrictEqual(r.bad, ["tension??", "什么鬼"]);
  assert.strictEqual(r.reports.length, 0);
});

ok("没有标记的文本原样返回", () => {
  assert.strictEqual(parseDirectorReport("普通一句话。").text, "普通一句话。");
  assert.strictEqual(stripDirectorReport("普通一句话。"), "普通一句话。");
});

// ── ⑦ 上报与配置的边界 ────────────────────────────────
ok("上报推得动状态", () => {
  const e = act();
  const { state, changes } = settle(e, { tension: 1, turn: 0, confessed: false }, parseDirectorReport("[状态 tension+2]").reports);
  assert.strictEqual(state.tension, 8, "1 → 基线 +5 = 6 → 上报 +2 = 8");
  assert.ok(changes.some(c => c.by === "report" && c.name === "tension"));
});

ok("上报越界 → 丢弃并说清原因（不像规则那样夹住）", () => {
  const e = act();
  const { state, rejected } = settle(e, { tension: 8, turn: 0 }, parseDirectorReport("[状态 tension+9]").reports);
  assert.strictEqual(rejected.length, 1);
  assert.ok(/越界/.test(rejected[0].rejected));
  // 越界那一笔不算，但基线照样走：8 → +5 = 13 → 夹到 10 → 不可逆事件 → 2
  assert.strictEqual(state.tension, 2, "基线不该因为上报被拒就停下");
});

ok("上报没声明的开关 → 拒绝（模型改不动配置）", () => {
  const e = act();
  const { state, rejected } = settle(e, { tension: 1, turn: 0 }, parseDirectorReport("[状态 flag:我是主角]").reports);
  assert.strictEqual(rejected.length, 1);
  assert.ok(/不是这个配方声明的开关/.test(rejected[0].rejected));
  assert.strictEqual(state.我是主角, undefined, "不该凭空多出一个开关");
});

ok("上报声明的开关 → 生效", () => {
  const e = act();
  const { state } = settle(e, { tension: 1, turn: 0, confessed: false }, parseDirectorReport("[状态 flag:confessed]").reports);
  assert.strictEqual(state.confessed, true);
});

ok("不给上报也照常推进（可选语法，不是义务）", () => {
  const e = act();
  const { state } = settle(e, { tension: 1, turn: 0, confessed: false }, []);
  assert.strictEqual(state.turn, 1);
});

ok("状态摘要给人看的那一行", () => {
  const s = describeState(act(), { tension: 5, turn: 2, confessed: true });
  assert.ok(/tension 5\/10/.test(s), s);
  assert.ok(/confessed/.test(s), "开关为真时该露出来：" + s);
  assert.ok(!/turn 2\//.test(s), "没上限的量不该编一个出来：" + s);
});

console.log("\n通过 " + pass + " / 失败 " + fail + "\n");
if (fail > 0) process.exit(1);
