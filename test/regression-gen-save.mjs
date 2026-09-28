// test/regression-gen-save.mjs — 生成结果落库这条路
//
// 生成台按"写进卡库"时走的是两件现成的机器：
//   ① POST /characters                 建卡（卡里带 character_book）
//   ② POST /characters/:id/import-book 卡内世界书 → 设定库条目（replace=true）
//
// 为什么单独钉这两步：它们各自都有別的测试，但**串在一起**是这次新加的用法。
// 串起来失败的样子很糟——卡建出来了、世界书没进去，用户看到的是一张
// 没有任何世界书条目的卡，而且没有任何地方报错。
//
// 判据：
//   ① 建卡：卡进库，GET /characters 看得到，has_book 为真
//   ② import-book：条目真的进了设定库，条数与 keys 都对
//   ③ 再导一次（replace=true）：不堆重复

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeApp, request } from "./lib/route-harness.mjs";

const { CharacterRepo } = await import("../lib/characters/repo.js");
const { CharacterTransfer } = await import("../lib/characters/transfer.js");
const { SettingRepo } = await import("../lib/settings/repo.js");
const { registerCharacterRoutes } = await import("../lib/characters/routes.js");

let pass = 0, fail = 0;
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log("\n=== 生成结果落库 ===\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-gensave-"));
const charRepo = new CharacterRepo(tmp);
await charRepo.init();
const setRepo = new SettingRepo(tmp);
await setRepo.init();
const transfer = new CharacterTransfer(charRepo);

const app = makeApp();
registerCharacterRoutes(app, charRepo, transfer, setRepo);

const CARD = {
  name: "初音未来",
  description: "初音未来是 Crypton Future Media 开发的歌声合成软件。",
  personality: "活泼",
  scenario: "录音室",
  first_mes: "「今天也一起唱吧。」",
  mes_example: "",
  creator_notes: "由 eleckoi 生成",
  tags: ["歌声合成"],
  character_book: {
    entries: [
      { name: "初音未来", keys: ["初音未来", "初音"], content: "初音未来是 Crypton Future Media 开发的歌声合成软件。", position: "before_char" },
      { name: "录音室", keys: ["录音室"], content: "录音室里有台老合成器。", position: "before_char" }
    ]
  }
};

let cardId = null;

await okAsync("① 建卡：进库、看得到、has_book 为真", async () => {
  const r = await request(app, "POST", "/characters", { body: { card: CARD } });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  cardId = (r.data || {}).id;
  assert.ok(cardId, "没拿到卡 id");

  const list = await request(app, "GET", "/characters");
  const row = (list.data || []).find((c) => c.id === cardId);
  assert.ok(row, "新卡不在列表里");
  assert.strictEqual(row.has_book, true, "has_book 该为真——它是左栏「带世界书」那行的依据");
});

await okAsync("② import-book：条目进了设定库，条数与 keys 都对", async () => {
  const r = await request(app, "POST", `/characters/${cardId}/import-book`, { body: { replace: true } });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.strictEqual(r.data.total, 2, `该导 2 条，实为 ${r.data.total}`);
  assert.strictEqual(r.data.added, 2, `added=${r.data.added}`);

  const all = await setRepo.list({});
  const mine = (Array.isArray(all) ? all : []).filter((s) => s.characterId === cardId);
  assert.strictEqual(mine.length, 2, `设定库里该有 2 条，实为 ${mine.length}`);
  const keys = mine.flatMap((s) => s.keywords || []);
  assert.ok(keys.includes("初音未来"), "触发词没进去：" + JSON.stringify(keys));
  assert.ok(keys.includes("录音室"), "第二条的触发词没进去");
});

await okAsync("③ 再导一次（replace=true）：不堆重复", async () => {
  const r = await request(app, "POST", `/characters/${cardId}/import-book`, { body: { replace: true } });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  const all = await setRepo.list({});
  const mine = (Array.isArray(all) ? all : []).filter((s) => s.characterId === cardId);
  assert.strictEqual(mine.length, 2, `重导后该还是 2 条，实为 ${mine.length}`);
});

await okAsync("④ 条目不带 name 也不丢：内容不同就是两条（原墓碑，已翻面）", async () => {
  // 这曾经是个坑：设定库按 name 去重，没名字的条目全叫「（无名称）」，
  // 于是生成十条世界书、进库只剩一条，而且哪一步都不报错。
  // 那时这条测试是「墓碑」——它记下这个已知的坏行为。
  //
  // 2026-09-27 判重改成身份（源 + 原始 id，退了用内容指纹）后，坑填了：
  // 名字不再是身份，两条内容不同的条目不会再互相吞。
  // 墓碑翻面，改成正面断言——它现在守的是「不许吞」。
  const bare = await charRepo.create({ name: "没名字的卡", description: "d", first_mes: "f" });
  await charRepo.update(bare.id, {
    character_book: {
      entries: [
        { keys: ["甲"], content: "第一条。" },
        { keys: ["乙"], content: "第二条。" }
      ]
    }
  });

  const r = await request(app, "POST", `/characters/${bare.id}/import-book`, { body: { replace: true } });
  assert.strictEqual(r.status, 200, `状态 ${r.status}：${r.error || ""}`);
  assert.strictEqual(r.data.total, 2, "转换层该看到两条");
  assert.strictEqual(r.data.added, 2, "两条内容不同，都该进库（以前第二条会被静默吞掉）");
});

console.log(`\n${fail === 0 ? "✅" : "❌"} 落库：${pass} 过 / ${fail} 败\n`);
process.exit(fail === 0 ? 0 : 1);
