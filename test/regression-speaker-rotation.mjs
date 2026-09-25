// test/regression-speaker-rotation.mjs — 群聊发言顺序（纯逻辑）
//
// 这里最值钱的一条是**跨侧一致**：
// 前端 ui/assets/modules/speaker-rotation.js 的 participantsOf
// 必须与服务端 lib/conversations/model.js 的 participantsOf 同一条读法。
// 两边分叉的后果是「界面上少一个人，而 prompt 里有」——最难查的那种。
// 所以这个测试直接把两个实现放在同一批输入上对比。

import assert from "node:assert";

const { participantsOf, nextSpeaker } = await import("../ui/assets/modules/speaker-rotation.js");
const server = await import("../lib/conversations/model.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 群聊发言顺序 ===\n");

// ── 读法：新对话 / 老对话 / 都没有 ──
await okAsync("新对话：characterIds 就是参与者", () => {
  assert.deepStrictEqual(participantsOf({ characterIds: ["a", "b"] }), ["a", "b"]);
});

await okAsync("老对话：只有 characterId，也要能兜成一个人", () => {
  assert.deepStrictEqual(participantsOf({ characterId: "solo" }), ["solo"]);
});

await okAsync("空 characterIds 回退到 characterId（不是空数组）", () => {
  assert.deepStrictEqual(participantsOf({ characterIds: [], characterId: "x" }), ["x"]);
});

await okAsync("两个都没有 → 空（不是 null，调用方少一层判断）", () => {
  assert.deepStrictEqual(participantsOf({}), []);
  assert.deepStrictEqual(participantsOf(null), []);
});

// ── 跨侧一致（这个测试的存在理由） ──
await okAsync("与服务端 participantsOf 逐例一致（跨侧契约）", () => {
  const cases = [
    { characterIds: ["a", "b", "c"] },
    { characterIds: ["a"] },
    { characterId: "solo" },
    { characterIds: [], characterId: "x" },
    { characterIds: ["a", "b"], characterId: "a" },
    {},
    null
  ];
  for (const c of cases) {
    const mine = participantsOf(c);
    const theirs = server.participantsOf(c);
    assert.deepStrictEqual(mine, theirs, `输入 ${JSON.stringify(c)}：前端 ${JSON.stringify(mine)} vs 服务端 ${JSON.stringify(theirs)}`);
  }
});

// ── 轮转 ──
await okAsync("轮转：依次走完再绕回开头", () => {
  const ids = ["a", "b", "c"];
  let cur = "a";
  const seen = [];
  for (let i = 0; i < 5; i++) { cur = nextSpeaker(ids, cur); seen.push(cur); }
  assert.deepStrictEqual(seen, ["b", "c", "a", "b", "c"]);
});

await okAsync("当前的 id 不在名单里 → 落到第一位（不卡住）", () => {
  assert.strictEqual(nextSpeaker(["a", "b"], "zzz"), "a");
  assert.strictEqual(nextSpeaker(["a", "b"], null), "a");
});

await okAsync("单人：轮不到别人，回自己", () => {
  assert.strictEqual(nextSpeaker(["only"], "only"), "only");
});

await okAsync("空名单 → null（调用方据此不换人）", () => {
  assert.strictEqual(nextSpeaker([], "a"), null);
  assert.strictEqual(nextSpeaker(null, "a"), null);
});

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 过 / ${fail} 不过\n`);
process.exit(fail ? 1 : 0);
