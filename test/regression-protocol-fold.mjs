// test/regression-protocol-fold.mjs — 卡片变量协议块的折叠抽取
//
// 背景（2026-10-02）：有卡片在提示词里自带酒馆脚本系的变量协议，教模型输出
// <UpdateVariable>/<Analysis>/<JSONPatch>——夜航船不解析这套协议，标签就
// 裸奔在正文里。渲染层的选择：整块抽出折成 <details>，正文不再被淹没，
// 内容不丢。是否真按 patch 应用变量是另议的产品决定。
//
// 这里锁抽取器的三条行为：
//   ① 闭合块整块抽出，正文干净
//   ② 没写闭合标签（流式截断 / 模型忘写）→ 折到结尾，不吐半个标签
//   ③ 多块依次抽出、顺序保持

import assert from "node:assert";

const { extractProtocolBlocks } = await import("../ui/assets/modules/protocol.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 卡片协议块折叠 ===\n");

await okAsync("① 闭合块整块抽出，正文干净", async () => {
  const raw = "前情一句。\n<UpdateVariable><Analysis>开场</Analysis><JSONPatch>[]</JSONPatch></UpdateVariable>\n正文开始。";
  const { text, blocks } = extractProtocolBlocks(raw);
  assert.strictEqual(text.includes("<UpdateVariable>"), false, "正文里不该再有标签");
  assert.strictEqual(text.includes("正文开始。"), true, "正文内容要留住");
  assert.strictEqual(blocks.length, 1);
  assert.ok(blocks[0].includes("<Analysis>"), "块内容应含 Analysis");
});

await okAsync("② 没写闭合标签 → 折到结尾，不吐半个标签", async () => {
  const raw = "开场白正文。<UpdateVariable><Analysis>只有头</Analysis>";
  const { text, blocks } = extractProtocolBlocks(raw);
  assert.strictEqual(text.includes("<Analysis>"), false);
  assert.strictEqual(text.trim(), "开场白正文。");
  assert.strictEqual(blocks.length, 1);
});

await okAsync("③ 多块依次抽出、顺序保持", async () => {
  const raw = "A<UpdateVariable>一</UpdateVariable>B<UpdateVariable>二</UpdateVariable>C";
  const { text, blocks } = extractProtocolBlocks(raw);
  assert.deepStrictEqual(text, "ABC");
  assert.deepStrictEqual(blocks, ["一", "二"]);
});

console.log(`\n${fail === 0 ? "✅" : "❌"} 协议折叠：${pass} 过 / ${fail} 败\n`);
process.exit(fail === 0 ? 0 : 1);
