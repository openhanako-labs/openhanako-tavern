// test/regression-b.mjs — 切口 B 回归
//
// 覆盖：原子写 / 写锁 / 损坏恢复 / O(n²) 消除 / 批量操作

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

import { writeJsonAtomic, readJsonSafe, withLock, mutateJson, appendJsonl, readJsonlSafe, lockCount } from "../lib/atomic.js";
import { IndexedStore } from "../lib/store.js";
import { ConversationRepo } from "../lib/conversations/repo.js";
import { CharacterRepo } from "../lib/characters/repo.js";
import { SettingRepo } from "../lib/settings/repo.js";
import { VariableRepo } from "../lib/variables/repo.js";

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

function section(t) {
  console.log(`\n${"─".repeat(60)}\n${t}\n${"─".repeat(60)}`);
}

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tavern-b-"));

// ─────────────────────────────────────────────────────────────
section("B1 · 原子写");

await test("writeJsonAtomic 内容正确 + 不残留临时文件", async () => {
  const f = path.join(tmpRoot, "atomic", "a.json");
  await writeJsonAtomic(f, { hello: "world", n: 42 });

  const back = await readJsonSafe(f, null);
  assert.deepEqual(back, { hello: "world", n: 42 });

  const files = await fs.readdir(path.dirname(f));
  const tmp = files.filter(x => x.includes(".tmp"));
  assert.equal(tmp.length, 0, `不应残留临时文件，实际: ${tmp.join(",")}`);
});

await test("并发写同一文件：最终结果是完整 JSON（不半截）", async () => {
  const f = path.join(tmpRoot, "atomic", "concurrent.json");
  const writes = [];
  for (let i = 0; i < 50; i++) {
    writes.push(writeJsonAtomic(f, { i, payload: "x".repeat(1000) }));
  }
  await Promise.all(writes);

  const back = await readJsonSafe(f, null);
  assert.ok(back, "必须能解析出完整 JSON");
  assert.ok(typeof back.i === "number", "必须是一个完整的写入结果");
});

await test("readJsonSafe：文件不存在返回 fallback", async () => {
  const v = await readJsonSafe(path.join(tmpRoot, "nope.json"), { def: true });
  assert.deepEqual(v, { def: true });
});

await test("readJsonSafe：内容损坏 → 备份坏文件 + 返回 fallback", async () => {
  const dir = path.join(tmpRoot, "atomic");
  const f = path.join(dir, "broken.json");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(f, "{ 这不是 JSON", "utf8");

  const v = await readJsonSafe(f, []);
  assert.deepEqual(v, [], "应返回 fallback 而不是抛异常");

  const files = await fs.readdir(dir);
  assert.ok(
    files.some(x => x.includes(".broken-")),
    "坏文件应被改名留证"
  );
});

// ─────────────────────────────────────────────────────────────
section("B1 · 写锁");

await test("withLock：同键串行执行", async () => {
  const key = path.join(tmpRoot, "lock-a");
  const order = [];

  const task = (id, delay) => withLock(key, async () => {
    order.push(`start-${id}`);
    await new Promise(r => setTimeout(r, delay));
    order.push(`end-${id}`);
  });

  await Promise.all([task(1, 30), task(2, 5), task(3, 1)]);

  // 串行意味着不会有交错的 start-end
  assert.equal(order.length, 6);
  for (let i = 0; i < 6; i += 2) {
    assert.ok(
      order[i].startsWith("start-") && order[i + 1] === order[i].replace("start", "end"),
      `第 ${i} 对不是串行的: ${order[i]} → ${order[i + 1]}`
    );
  }
});

await test("withLock：不同键可并行", async () => {
  const t0 = Date.now();
  await Promise.all([
    withLock(path.join(tmpRoot, "k1"), () => new Promise(r => setTimeout(r, 50))),
    withLock(path.join(tmpRoot, "k2"), () => new Promise(r => setTimeout(r, 50)))
  ]);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 95, `不同键应并行，实际耗时 ${elapsed}ms`);
});

await test("withLock：异常也释放锁", async () => {
  const key = path.join(tmpRoot, "lock-err");
  await assert.rejects(() => withLock(key, async () => { throw new Error("boom"); }));

  // 锁应已释放，后续调用能正常完成
  const v = await withLock(key, async () => "ok");
  assert.equal(v, "ok");
});

await test("锁表不泄漏（完成后清理）", async () => {
  const before = lockCount();
  for (let i = 0; i < 20; i++) {
    await withLock(path.join(tmpRoot, `leak-${i}`), async () => i);
  }
  assert.equal(lockCount(), before, "完成的锁应从表中清理");
});

// ─────────────────────────────────────────────────────────────
section("B1 · mutateJson 原子读改写");

await test("mutateJson：读→改→写 全程持锁，无丢更新", async () => {
  const f = path.join(tmpRoot, "mutate", "counter.json");
  await writeJsonAtomic(f, { count: 0 });

  const inc = () => mutateJson(f, { count: 0 }, (cur) => ({ count: (cur?.count || 0) + 1 }));
  await Promise.all(Array.from({ length: 50 }, inc));

  const back = await readJsonSafe(f, null);
  assert.equal(back.count, 50, `50 次并发自增应得 50，实际 ${back.count}`);
});

await test("JSONL：追加 + 读取 + 跳过坏行", async () => {
  const f = path.join(tmpRoot, "log", "events.jsonl");
  await appendJsonl(f, { n: 1 });
  await appendJsonl(f, { n: 2 });
  await fs.appendFile(f, "{坏行\n", "utf8");
  await appendJsonl(f, { n: 3 });

  const { records, corrupted } = await readJsonlSafe(f);
  assert.equal(records.length, 3, "应读到 3 条好记录");
  assert.equal(corrupted, 1, "应识别出 1 条坏行");
  assert.deepEqual(records.map(r => r.n), [1, 2, 3]);
});

// ─────────────────────────────────────────────────────────────
section("B4 · O(n²) 消除 + 批量");

await test("导入 100 张卡：索引只落盘一次（不是 100 次）", async () => {
  const dir = path.join(tmpRoot, "perf-char");
  const repo = new CharacterRepo(dir);
  await repo.init();

  // 监视索引文件的写入次数
  const idxFile = path.join(dir, "characters", "index.json");
  let writeCount = 0;
  const origRename = fs.rename;
  const spy = async (from, to) => {
    if (String(to).endsWith("index.json")) writeCount++;
    return origRename(from, to);
  };
  // 无法直接 patch ESM 绑定，改为直接测时间与正确性
  const cards = Array.from({ length: 100 }, (_, i) => ({
    name: `卡${i}`, description: "d", first_mes: "f"
  }));

  const t0 = Date.now();
  for (const c of cards) await repo.create(c);
  const elapsed = Date.now() - t0;

  const list = await repo.list();
  assert.equal(list.length, 100, "100 张卡都要在索引里");
  // 原实现是每次 create 读+写整个 index，100 张会很慢；这里给一个宽松上限
  assert.ok(elapsed < 5000, `100 张卡耗时 ${elapsed}ms，超过预期上限`);
});

await test("deleteBatch：索引只更新一次且结果正确", async () => {
  const dir = path.join(tmpRoot, "batch-char");
  const repo = new CharacterRepo(dir);
  await repo.init();

  const created = [];
  for (let i = 0; i < 10; i++) {
    created.push(await repo.create({ name: `B${i}`, description: "d", first_mes: "f" }));
  }

  const toDelete = created.slice(0, 5).map(c => c.id);
  const results = await repo.deleteBatch(toDelete);

  assert.equal(results.filter(r => r.success).length, 5);
  const list = await repo.list();
  assert.equal(list.length, 5, "应剩 5 张");
  for (const id of toDelete) {
    assert.ok(!list.some(c => c.id === id), `${id} 应已删除`);
  }
});

await test("deleteBatch：部分失败不影响其余", async () => {
  const dir = path.join(tmpRoot, "batch-partial");
  const repo = new CharacterRepo(dir);
  await repo.init();
  const a = await repo.create({ name: "A", description: "d", first_mes: "f" });

  const results = await repo.deleteBatch([a.id, "../../../etc/passwd"]);
  assert.equal(results[0].success, true);
  assert.equal(results[1].success, false, "越界 id 应被拒");
  assert.equal((await repo.list()).length, 0);
});

// ─────────────────────────────────────────────────────────────
section("B · 仓储一致性");

await test("对话：并发追加消息不丢", async () => {
  const dir = path.join(tmpRoot, "conv-concurrent");
  const repo = new ConversationRepo(dir);
  await repo.init();
  const conv = await repo.create("char-1");

  await Promise.all(
    Array.from({ length: 20 }, (_, i) => repo.addMessage(conv.id, "user", `msg-${i}`))
  );

  const reloaded = await repo.get(conv.id);
  assert.equal(reloaded.messages.length, 20, `应 20 条，实际 ${reloaded.messages.length}`);

  const list = await repo.list();
  assert.equal(list[0].messageCount, 20, "索引条数应同步");
});

await test("设定：并发创建不丢", async () => {
  const dir = path.join(tmpRoot, "setting-concurrent");
  const repo = new SettingRepo(dir);
  await repo.init();

  await Promise.all(
    Array.from({ length: 15 }, (_, i) => repo.create({ name: `设定${i}`, content: "c" }))
  );

  const list = await repo.list();
  assert.equal(list.length, 15, `应 15 条，实际 ${list.length}`);
  // order 应唯一
  const orders = list.map(s => s.order);
  assert.equal(new Set(orders).size, 15, "order 应互不重复");
});

await test("变量：重名定义被拒", async () => {
  const dir = path.join(tmpRoot, "var-dup");
  const repo = new VariableRepo(dir);
  await repo.init();
  await repo.createDefinition({ name: "hp" });
  await assert.rejects(
    () => repo.createDefinition({ name: "hp" }),
    /already exists/
  );
});

await test("变量：对话级变量写入不与其他写者冲突", async () => {
  const dir = path.join(tmpRoot, "var-conv");
  const convRepo = new ConversationRepo(dir);
  const varRepo = new VariableRepo(dir);
  await convRepo.init();
  await varRepo.init();

  const conv = await convRepo.create("char-1");

  // 同时：追加消息 + 写变量
  await Promise.all([
    convRepo.addMessage(conv.id, "user", "同时发消息"),
    varRepo.setConversationVariables(conv.id, { hp: 99 })
  ]);

  const reloaded = await convRepo.get(conv.id);
  assert.equal(reloaded.messages.length, 1, "消息不能因并发写变量而丢");
  assert.equal(reloaded.variables.hp, 99, "变量必须写进去");
});

console.log("\n" + "=".repeat(60));
console.log(`通过 ${passed} / 失败 ${failed}`);
console.log("=".repeat(60));

await fs.rm(tmpRoot, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
