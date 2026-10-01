// test/regression-settings-books.mjs — 世界书（书 → 条目 两级）核心行为
//
// 2026-10-01 引入。计划里钉了七件事，每件都是一次真实踩坑的教训：
//
//   ① 回填幂等 —— 老数据进书体系时，跑两遍不能产生重复书或重复 bookId。
//      这是「隐式写盘」最危险的性质：跑一次正常，跑两次就把整表搬坏了。
//   ② listEffective 书关过滤 —— 书关了整书条目不进管线；
//      bookId 空 / 指向已删书 都当「开」处理（宁可留着，不可静默消失）。
//   ③ 书 CRUD —— 建 / 改名 / 开关 / 删 都要真的落盘。
//   ④ import-st 建书 —— 导入 ST 世界书时自动建同名书，条目挂上。
//   ⑤ importCharacterBook 挂 bookId —— 卡的世界书导入后，条目自动归到卡的书。
//   ⑥ 删书连带删条目 —— 删书 = 书没了 + 书内条目也没了（先备份再动）。
//   ⑦ bookId 空不崩 —— 未归档条目在任何下游都不能炸。
//
// 每个测试用独立临时目录，避免跨用例污染。

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { createSettingRepo } from "../lib/settings/repo.js";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${e.message}`);
    failed++;
  }
}

async function freshRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tavern-wb-books-"));
  const repo = createSettingRepo(dir);
  await repo.init();
  return { dir, repo };
}

// 清理临时目录（失败不阻断测试收尾）
const tmpdirs = [];
const origFreshRepo = freshRepo;
const freshRepoTracked = async () => {
  const r = await origFreshRepo();
  tmpdirs.push(r.dir);
  return r;
};

const CHAR = "char-A";
const OTHER = "char-B";

const cardEntry = (name, content = "来自卡") =>
  ({ name, content, source: "character_book", characterId: CHAR });

console.log("\n世界书（书 → 条目）· 七条钉住");

// ── ① 回填幂等 ────────────────────────────────────────

await test("回填：第一次按 source+characterId 归档，第二次跑不产生重复", async () => {
  const { dir, repo } = await freshRepoTracked();

  // 造一堆老数据：两张卡的 character_book + 一些 native
  const entries = [
    { id: "e1", name: "卡A-1", content: "a1", characterId: CHAR, source: "character_book" },
    { id: "e2", name: "卡A-2", content: "a2", characterId: CHAR, source: "character_book" },
    { id: "e3", name: "卡B-1", content: "b1", characterId: OTHER, source: "character_book" },
    { id: "e4", name: "全局1", content: "g1", characterId: "", source: "native" },
    { id: "e5", name: "全局2", content: "g2", characterId: "", source: "sillytavern" }
  ];
  // 直接落盘绕过 create() 的默认 bookId=""
  await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify(entries, null, 2), "utf8");
  await repo.init(); // 重新 init 让 repo 状态跟磁盘一致

  const r1 = await repo.backfillBooks((cid) => (cid === CHAR ? "甲" : "乙"));
  assert.equal(r1.createdBooks, 3, `应建 3 本：卡A / 卡B / 散置，实际 ${r1.createdBooks}`);
  assert.equal(r1.updatedEntries, 5, `5 条都应被挂上，实际 ${r1.updatedEntries}`);

  // 第二次跑：全部已归档，一本书都不该新建，一条都不该改
  const r2 = await repo.backfillBooks((cid) => (cid === CHAR ? "甲" : "乙"));
  assert.equal(r2.createdBooks, 0, `第二次不该建新书，实际 ${r2.createdBooks}`);
  assert.equal(r2.updatedEntries, 0, `第二次不该改条目，实际 ${r2.updatedEntries}`);

  const books = await repo.listBooks();
  assert.equal(books.length, 3, `应有 3 本书，实际 ${books.length}`);
  const aBook = books.find(b => b.characterId === CHAR);
  assert.ok(aBook, "应有卡A 的书");
  assert.equal(aBook.name, "甲", "卡书名应取角色名");
  assert.equal(aBook.entryCount, 2, "卡A 应挂 2 条");
  const scattered = books.find(b => b.name === "散置条目");
  assert.ok(scattered, "应有「散置条目」书");
  assert.equal(scattered.entryCount, 2, "散置条目应挂 2 条");
});

// ── ② listEffective 书关过滤 ────────────────────────────

await test("listEffective：书关 → 整书条目不进；bookId 空 / 指向已删书 都当开", async () => {
  const { repo } = await freshRepoTracked();

  const bookA = await repo.createBook({ name: "书A", characterId: CHAR, source: "character_book" });
  const bookB = await repo.createBook({ name: "书B", characterId: OTHER, source: "character_book" });
  await repo.create({ name: "书A 条目1", characterId: CHAR, bookId: bookA.id });
  await repo.create({ name: "书A 条目2", characterId: CHAR, bookId: bookA.id });
  await repo.create({ name: "书B 条目", characterId: OTHER, bookId: bookB.id });
  await repo.create({ name: "全局条目", characterId: "", source: "native" }); // 未归档

  // 全开：4 条都生效
  let eff = await repo.listEffective();
  assert.equal(eff.length, 4, `全开时应 4 条生效，实际 ${eff.length}`);

  // 关书A：书A 两条消失，剩下 2 条
  await repo.toggleBook(bookA.id, false);
  eff = await repo.listEffective();
  assert.equal(eff.length, 2, `书A 关后应 2 条生效，实际 ${eff.length}`);
  assert.ok(!eff.some(s => s.name.startsWith("书A")), "书A 条目不该出现");
  assert.ok(eff.some(s => s.name === "书B 条目"), "书B 条目应仍在");
  assert.ok(eff.some(s => s.name === "全局条目"), "未归档条目应仍在");

  // 开回来
  await repo.toggleBook(bookA.id, true);
  eff = await repo.listEffective();
  assert.equal(eff.length, 4, "书A 再开回来应 4 条");
});

await test("listEffective：bookId 空 / 指向已删书 都当「开」处理", async () => {
  const { repo } = await freshRepoTracked();

  const bookA = await repo.createBook({ name: "书A", source: "native" });
  await repo.create({ name: "空 bookId 条目", characterId: "" });
  await repo.create({ name: "指向书A 条目", bookId: bookA.id });
  // 一条 bookId 指向不存在的书
  await repo.create({ name: "指向已删书 条目", bookId: "does-not-exist" });

  let eff = await repo.listEffective();
  assert.equal(eff.length, 3, "三个都应生效（都是开）");

  // 删掉书A —— 那条例目被连带删，剩下“空 bookId” + “指向已删书” 2 条（后者的 bookId 不是 A 的 id，不会被扫到）
  await repo.deleteBook(bookA.id);
  eff = await repo.listEffective();
  assert.equal(eff.length, 2, `删书A 后应 2 条，实际 ${eff.length}`);
  const names = eff.map(s => s.name).sort();
  assert.deepEqual(names, ["指向已删书 条目", "空 bookId 条目"], `名字对不上：${names.join(",")}`);
  // 而且指向不存在的书的条目仍能活（宁留不删）
});

// ── ③ 书 CRUD ──────────────────────────────────────────

await test("书 CRUD：建 / 改名 / 开关 / 删 全落盘", async () => {
  const { repo } = await freshRepoTracked();

  const book = await repo.createBook({ name: "新书", source: "native" });
  assert.ok(book.id, "新建书应有 id");
  assert.equal(book.name, "新书");
  assert.equal(book.enabled, true, "新建书默认启用");
  assert.ok(book.createdAt, "应有 createdAt");

  // 列表能看到
  let books = await repo.listBooks();
  assert.equal(books.length, 1);
  assert.equal(books[0].entryCount, 0, "空书 entryCount=0");

  // 改名
  const renamed = await repo.renameBook(book.id, "改名后");
  assert.equal(renamed.name, "改名后");
  books = await repo.listBooks();
  assert.equal(books[0].name, "改名后");

  // 开关
  await repo.toggleBook(book.id, false);
  books = await repo.listBooks();
  assert.equal(books[0].enabled, false);
  await repo.toggleBook(book.id, true);
  books = await repo.listBooks();
  assert.equal(books[0].enabled, true);

  // 空名字应该报错
  await assert.rejects(() => repo.renameBook(book.id, ""), /name is required/);

  // 删掉不存在的书应该报错
  await assert.rejects(() => repo.renameBook("does-not-exist", "x"), /not found/i);
});

// ── ④ import-st 建书 ───────────────────────────────────

await test("importSettings：source=sillytavern 的条目通过 ensureBookByName 挂书", async () => {
  const { repo } = await freshRepoTracked();

  // 建一本全局书（模拟 ST 世界书的入口）
  const book = await repo.ensureBookByName("测试世界书");
  assert.equal(book.name, "测试世界书");
  assert.equal(book.characterId, "", "ST 世界书是全局书");

  // 重复 ensure 同名书，应该拿到同一本
  const bookAgain = await repo.ensureBookByName("测试世界书");
  assert.equal(bookAgain.id, book.id, "同名书应复用，不应建新的");

  // 挂条目
  await repo.importSettings([
    { name: "ST 条目1", content: "a", source: "sillytavern", bookId: book.id, externalId: "e1" },
    { name: "ST 条目2", content: "b", source: "sillytavern", bookId: book.id, externalId: "e2" }
  ]);
  const books = await repo.listBooks();
  const hit = books.find(b => b.id === book.id);
  assert.equal(hit.entryCount, 2, `书应有 2 条，实际 ${hit.entryCount}`);
});

// ── ⑤ importCharacterBook 挂 bookId ────────────────────

await test("importCharacterBook：卡的世界书自动归到卡的书（不建重复）", async () => {
  const { repo } = await freshRepoTracked();

  const charNameOf = (cid) => (cid === CHAR ? "角色甲" : "角色乙");
  const r1 = await repo.importCharacterBook(CHAR, [
    { name: "卡条目1", content: "a", source: "character_book" },
    { name: "卡条目2", content: "b", source: "character_book" }
  ], { characterNameOf: charNameOf });
  assert.equal(r1.added, 2);

  const books1 = await repo.listBooks();
  assert.equal(books1.length, 1, `应只建 1 本书，实际 ${books1.length}`);
  assert.equal(books1[0].name, "角色甲", "卡书名应取角色名");
  assert.equal(books1[0].entryCount, 2);

  // 重导同一张卡（内容变了）—— 应替换内容，不应建新书
  const r2 = await repo.importCharacterBook(CHAR, [
    { name: "卡条目1", content: "改过", source: "character_book" },
    { name: "卡条目2", content: "b", source: "character_book" },
    { name: "新加一条", content: "c", source: "character_book" }
  ], { characterNameOf: charNameOf });
  assert.equal(r2.removed, 2, "先清掉卡先前带来的 2 条");
  assert.equal(r2.added, 3, "3 条全新加入");

  const books2 = await repo.listBooks();
  assert.equal(books2.length, 1, `重导后仍应 1 本书，实际 ${books2.length}`);
  assert.equal(books2[0].entryCount, 3);

  // 每条都挂了 bookId
  const all = await repo.list();
  for (const s of all) {
    assert.ok(s.bookId, `${s.name} 应有 bookId`);
    assert.equal(s.bookId, books2[0].id, `${s.name} 应挂到卡的书`);
  }
});

// ── ⑥ 删书连带删条目 ───────────────────────────────────

await test("删书：书没了 + 书内条目也没了 + 备份路径返回", async () => {
  const { dir, repo } = await freshRepoTracked();

  const book = await repo.createBook({ name: "要删的书", source: "native" });
  await repo.importSettings([
    { name: "条目1", bookId: book.id, source: "native" },
    { name: "条目2", bookId: book.id, source: "native" },
    { name: "条目3", bookId: book.id, source: "native" }
  ]);
  // 加一条不属于这本书的条目（未归档）
  await repo.create({ name: "未归档条目" });

  const r = await repo.deleteBook(book.id);
  assert.equal(r.removedEntries, 3, `应连带删 3 条，实际 ${r.removedEntries}`);
  assert.equal(r.removedBook, 1, "应删掉 1 本书");
  assert.ok(r.backupPath, "应返回备份路径");
  assert.ok(fs.stat(r.backupPath).then(() => true).catch(() => false), "备份文件应存在");

  const books = await repo.listBooks();
  assert.equal(books.length, 0, "书表应为空");
  const all = await repo.list();
  assert.equal(all.length, 1, "只剩未归档那条");
  assert.equal(all[0].name, "未归档条目");
});

await test("删书：书不存在时抛错", async () => {
  const { repo } = await freshRepoTracked();
  await assert.rejects(() => repo.deleteBook("does-not-exist"), /not found|is required/i);
});

// ── ⑦ bookId 空不崩 ────────────────────────────────────

await test("bookId 空：list / listEffective / getActive 都不崩", async () => {
  const { repo } = await freshRepoTracked();

  // 用 create() 建未归档条目（model.js 里 bookId 默认 ""）
  await repo.create({ name: "空 bookId", content: "c", keywords: ["kw"], characterId: "" });
  await repo.create({ name: "空 bookId 2", content: "d", keywords: ["kw2"], characterId: "" });

  // list 正常
  const all = await repo.list();
  assert.equal(all.length, 2);

  // listEffective 正常（空 bookId 当开）
  const eff = await repo.listEffective();
  assert.equal(eff.length, 2);

  // listBooks 正常（0 本书）
  const books = await repo.listBooks();
  assert.equal(books.length, 0);

  // getActive 正常（走 listEffective）
  const active = await repo.getActive({ text: "kw" });
  assert.ok(Array.isArray(active), "getActive 应返回数组");
});

await test("listBooks：空 bookId 的条目不进任何书的 entryCount", async () => {
  const { repo } = await freshRepoTracked();

  const book = await repo.createBook({ name: "书A", source: "native" });
  await repo.importSettings([
    { name: "书内", bookId: book.id, source: "native" },
    { name: "书外", source: "native" } // 无 bookId
  ]);
  const books = await repo.listBooks();
  assert.equal(books[0].entryCount, 1, "只有书内的算，书外的不算");
});

// ── 收尾 ───────────────────────────────────────────────

for (const dir of tmpdirs) {
  try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${passed} / 失败 ${failed}`);
process.exit(failed > 0 ? 1 : 0);
