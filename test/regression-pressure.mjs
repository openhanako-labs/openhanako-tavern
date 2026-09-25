// test/regression-pressure.mjs — 上下文压力读数：用了多少 / 上限多少 / 谁吃掉的
//
// 这一块的命在**诚实**上：
//   · 拿不到模型真实窗口时，allocateBudget 会拿 8000 兜底。
//     用兜底值算出来的百分比是**假读数**——它让人以为还有余量，
//     比不显示比例更坏。所以 windowReal 必须跟着一起给。
//   · 分段之和 ≤ 发出去的总数：段是正则改写前、且不含尾部时间块与分隔符。
//     差额不补平——补平就是编。
//   · 账与读数必须是同一个数，不能两处各算一遍（迟早对不上）。

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { ConversationRepo } = await import("../lib/conversations/repo.js");
const { CharacterRepo } = await import("../lib/characters/repo.js");
const { SettingRepo } = await import("../lib/settings/repo.js");
const { buildGenerationInput } = await import("../lib/conversations/pipeline.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 上下文压力 ===\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-pressure-"));
const charRepo = new CharacterRepo(tmp); await charRepo.init();
const convRepo = new ConversationRepo(tmp); await convRepo.init();
const setRepo = new SettingRepo(tmp); await setRepo.init();
const repos = { conversationRepo: convRepo, characterRepo: charRepo, settingRepo: setRepo, regexRepo: null, boardRepo: null };

const character = await charRepo.create({
  name: "薇拉", description: "北境第七哨塔的守夜法师，银发，左眼有一道旧疤。说话简短。",
  first_mes: "「又是你。」"
});

const conv = await convRepo.create(character.id);
await convRepo.addMessage(conv.id, "user", "你在守什么？");
await convRepo.addMessage(conv.id, "assistant", "「守着别让人上来。」");

await okAsync("给了真窗口 → 有比例，且 windowReal 为真", async () => {
  const fresh = await convRepo.get(conv.id);
  const out = await buildGenerationInput(repos, fresh, character, "她抬头看你。", { contextWindow: 32000, maxTokens: 1000 });

  const p = out.meta.pressure;
  assert.ok(p, "没有压力读数");
  assert.strictEqual(p.window, 32000);
  assert.strictEqual(p.windowReal, true, "传了真窗口却标成不可信");
  assert.ok(p.used > 0, `used 应当是正数：${p.used}`);
  assert.strictEqual(p.pct, Math.round((p.used / p.window) * 100));
  assert.ok(p.pct >= 0 && p.pct < 100, `短对话不该爆表：${p.pct}%`);
});

await okAsync("**没给窗口 → 如实说上限不可信**（不拿 8000 兜底冒充真值）", async () => {
  const fresh = await convRepo.get(conv.id);
  const out = await buildGenerationInput(repos, fresh, character, "嗯。", {});

  const p = out.meta.pressure;
  assert.strictEqual(p.windowReal, false, "没传窗口却标成可信——那会让 8000 兜底值伪装成真上限");
  // 兜底值还在（budget 要用），但它是兜底，调用方不许拿它算比例给人看
  assert.strictEqual(p.window, 8000);
});

await okAsync("账与读数是同一个数（只算一次）", async () => {
  const fresh = await convRepo.get(conv.id);
  const out = await buildGenerationInput(repos, fresh, character, "嗯。", { contextWindow: 32000 });
  assert.strictEqual(
    out.meta.pressure.used, out.audit.totalTokens,
    "账和读数各算了一遍——将来只改一处，屏幕上就会两个数打架"
  );
});

await okAsync("分段之和 ≤ 发出去的总数（差额不补平）", async () => {
  const fresh = await convRepo.get(conv.id);
  const out = await buildGenerationInput(repos, fresh, character, "她抬起头。", { contextWindow: 32000 });

  const p = out.meta.pressure;
  const partsTotal = Object.values(p.parts).reduce((n, v) => n + v, 0);
  assert.ok(partsTotal > 0, "分段是空的");
  assert.ok(
    partsTotal <= p.used,
    `分段之和 ${partsTotal} 超过了发出去的总数 ${p.used}——不可能，说明有一段的 token 数算错了`
  );
  // 至少要有这两段：底子（system）与本轮输入
  assert.ok(p.parts.base > 0, `没有底子段：${JSON.stringify(p.parts)}`);
  assert.ok(p.parts.input > 0, `没有本轮输入段：${JSON.stringify(p.parts)}`);
});

await okAsync("长历史 → 折叠的条数记进读数里（压力高时这条比百分比有用）", async () => {
  const longConv = await convRepo.create(character.id);
  for (let i = 0; i < 24; i++) {
    await convRepo.addMessage(longConv.id, "user", `第 ${i} 轮：${"话".repeat(60)}`);
    await convRepo.addMessage(longConv.id, "assistant", `回 ${i}：${"答".repeat(60)}`);
  }

  const fresh = await convRepo.get(longConv.id);
  const out = await buildGenerationInput(repos, fresh, character, "现在呢？", { contextWindow: 2000, maxTokens: 200 });

  const p = out.meta.pressure;
  assert.ok(out.meta.droppedMessages > 0, "窗口这么小，历史却没被折叠？");
  assert.strictEqual(p.dropped, out.meta.droppedMessages, "读数与账里的折叠条数不一致");
  assert.ok(p.historyBudget > 0, "没有历史预算");
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
