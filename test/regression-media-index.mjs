// test/regression-media-index.mjs — 图片台账（第 1 批）
//
// 判据来自计划第五节：
//   · 台账里 file 全是绝对路径
//   · 删掉文件后索引能自愈，不连带整表损坏
//
// 反证（改坏必红）：
//   ① 把 upsert 里的绝对路径校验去掉 → 断言「insert 相对路径要报错」直接红
//   ② 把 insert 改成不查重复 id → 断言「重复 id 抛错」直接红
//   ③ 把 readIndexFile 里的 normRecord 循环去掉 → 断言「单条坏行不炸全表」直接红
//   ④ 把 delete 时的空态检查去掉 → 断言「记录被删但文件还在」能继续读回其他条目

import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const {
  insert, upsert, getById, list, readIndex, update, remove, getBytes,
  indexPath, MediaKind
} = await import("../lib/media/index-store.js");

let pass = 0;
const failed = [];
async function okAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed.push(name);
    console.error(`  ❌ ${name}\n     ${e?.stack?.split("\n").slice(0, 3).join("\n     ") || e}`);
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tavern-media-idx-"));
const dataDir = path.join(tmp, "data");
await fs.mkdir(dataDir, { recursive: true });
const indexFile = indexPath(dataDir);

// 造一个真文件放在 dataDir 里，测试 file 存在时的取字节
const realFile = path.join(tmp, "sample.png");
await fs.writeFile(realFile, Buffer.from("89504e470d0a1a0a", "hex"));

// ── ① 新增 + 读回 ──
await okAsync("① insert → getById/list 都能读到", async () => {
  const rec = await insert(dataDir, {
    kind: MediaKind.PORTRAIT,
    characterId: "char-1",
    file: realFile,
    bytes: 8,
    prompt: "测试提示词"
  });
  assert.ok(rec.id, "insert 应返回 id");
  assert.match(rec.id, /^m_[0-9a-f]{12}$/, "id 应为 m_<12位hex>");
  assert.equal(rec.kind, "portrait");
  assert.equal(rec.characterId, "char-1");
  assert.equal(rec.file, realFile);
  assert.equal(rec.bytes, 8);

  const got = await getById(dataDir, rec.id);
  assert.equal(got.id, rec.id);
  assert.equal(got.characterId, "char-1");

  const all = await list(dataDir);
  assert.equal(all.length, 1);
});

// ── ② 相对路径拒绝（BUG-059 同源）──
await okAsync("② insert 相对路径必须抛错（file 只能是绝对路径）", async () => {
  await assert.rejects(
    () => insert(dataDir, { kind: "portrait", file: "relative/path.png" }),
    /相对路径/,
    "相对路径不该被接受"
  );
  await assert.rejects(
    () => insert(dataDir, { kind: "portrait", file: "avatar.png" }),
    /相对路径/,
    "裸文件名也该被拒"
  );
  // 已存在的记录不该被污染
  const { records } = await readIndex(dataDir);
  assert.equal(records.length, 1, "拒绝之后不应该把坏记录写进去");
});

// ── ③ 重复 id 覆盖（upsert） vs 抛错（insert）──
await okAsync("③ insert 拒绝重复 id，upsert 覆盖", async () => {
  const id = "m_manual0001";
  await insert(dataDir, { id, kind: "portrait", characterId: "char-A", file: realFile });
  // 同 id 再 insert 应抛
  await assert.rejects(
    () => insert(dataDir, { id, kind: "portrait", characterId: "char-B", file: realFile }),
    /已存在/,
    "insert 不该静默覆盖"
  );
  // 同 id 用 upsert 应覆盖
  const up = await upsert(dataDir, { id, kind: "portrait", characterId: "char-B", file: realFile });
  assert.equal(up.characterId, "char-B", "upsert 应覆盖");
  const got = await getById(dataDir, id);
  assert.equal(got.characterId, "char-B");
});

// ── ④ 过滤 ──
await okAsync("④ list 支持 kind / characterId 过滤", async () => {
  await insert(dataDir, { kind: "scene", conversationId: "conv-9", file: realFile });
  const byKind = await list(dataDir, { kind: "scene" });
  assert.equal(byKind.length, 1, "按 kind 过滤");
  assert.equal(byKind[0].conversationId, "conv-9");
  const byConv = await list(dataDir, { conversationId: "conv-9" });
  assert.equal(byConv.length, 1);
  const byChar = await list(dataDir, { characterId: "char-B" });
  assert.equal(byChar.length, 1);
});

// ── ⑤ 更新 ──
await okAsync("⑤ update 能改字段，改不存在 id 要报 ENOENT", async () => {
  const { records } = await readIndex(dataDir);
  const target = records[0];
  const updated = await update(dataDir, target.id, { prompt: "改过的提示词" });
  assert.equal(updated.prompt, "改过的提示词");
  await assert.rejects(
    () => update(dataDir, "m_nonexistent12", { prompt: "x" }),
    (e) => e.code === "ENOENT" && /台账里没有/.test(e.message)
  );
});

// ── ⑥ 删除 + 幂等 ──
await okAsync("⑥ remove 删掉的记录读不到，重复删返回 false", async () => {
  const { records } = await readIndex(dataDir);
  const before = records.length;
  const id = records[0].id;
  assert.equal(await remove(dataDir, id), true);
  const after = await readIndex(dataDir);
  assert.equal(after.records.length, before - 1);
  // 再删一次返回 false，不抛
  assert.equal(await remove(dataDir, id), false);
  // 其他记录不受影响
  const still = await getById(dataDir, "m_manual0001");
  assert.ok(still, "其他 id 不该被牵连");
});

// ── ⑦ getBytes ──
await okAsync("⑦ getBytes 能读到字节；文件没了能优雅回退", async () => {
  // 现存的一条记录指向 realFile
  const { records } = await readIndex(dataDir);
  const rec = records.find((r) => r.file === realFile);
  assert.ok(rec, "该至少有一条 file 指向 realFile");
  const got = await getBytes(dataDir, rec.id);
  assert.equal(got.ok, true);
  assert.equal(got.base64, Buffer.from("89504e470d0a1a0a", "hex").toString("base64"));
  assert.equal(got.mime, "image/png");
  assert.equal(got.bytes, 8);
});

await okAsync("⑧ 记录指向的文件被删了 → 不 500，返回 fileMissing=true", async () => {
  const { records } = await readIndex(dataDir);
  const rec = records.find((r) => r.file === realFile);
  await fs.rm(realFile, { force: true });
  const got = await getBytes(dataDir, rec.id);
  assert.equal(got.ok, false, "文件不在应返回 ok=false");
  assert.equal(got.fileMissing, true, "该带 fileMissing 标记");
  assert.match(got.reason, /ENOENT|系统找不到/, "该把 errno 带出来");
});

await okAsync("⑨ 台账里没有的 id → getBytes 抛 ENOENT", async () => {
  await assert.rejects(
    () => getBytes(dataDir, "m_not_exists0"),
    (e) => e.code === "ENOENT"
  );
});

// ── ⑩ 自愈：单条损坏的行不炸全表 ──
await okAsync("⑩ 索引里出现坏行时只丢那些不是对象的行，其他保留", async () => {
  // 直接写一个含坏行的数组到盘上，模拟“半路写坏”
  await fs.writeFile(indexFile, JSON.stringify([
    { id: "m_good000001", kind: "portrait", file: realFile },
    null,                                    // 坏：null（不是对象，丢）
    { kind: "portrait", file: realFile },    // 缺 id：归一化时补一个（不算坏行）
    "这是一个字符串",                          // 坏：不是对象（丢）
    { id: "m_good000002", kind: "scene", file: realFile }
  ]), "utf8");
  const { records } = await readIndex(dataDir);
  const ids = records.map((r) => r.id);
  assert.ok(ids.includes("m_good000001"), "第一条应保留");
  assert.ok(ids.includes("m_good000002"), "最后一条应保留");
  assert.equal(records.length, 3, `应保留 3 条（null 与 string 被丢），实际 ${records.length} 条：${JSON.stringify(ids)}`);
});

// ── ⑪ 自愈：整个文件坏了 → 返回空表 + 留下 .broken- 备份 ──
await okAsync("⑪ 整个 JSON 解析不了 → 返回空表，坏文件留在盘上", async () => {
  await fs.writeFile(indexFile, "{这不是 JSON", "utf8");
  const { records } = await readIndex(dataDir);
  assert.equal(records.length, 0, "解析不了时不该把上一版内容误当成有效");
  const broken = fsSync.readdirSync(dataDir).filter((f) => /\.broken-\d+$/.test(f));
  assert.equal(broken.length, 1, "该留下一个 .broken- 备份，不静默吞掉");
});

// ── ⑫ 空 id / 空 file 记录的处理 ──
await okAsync("⑫ file 为 null 的记录（生成中占位）能写进去，读取时能看见 dropped", async () => {
  // 先把坏文件删掉
  for (const f of fsSync.readdirSync(dataDir).filter((x) => x.startsWith("media-index.json"))) {
    await fs.rm(path.join(dataDir, f), { force: true });
  }
  const rec = await insert(dataDir, {
    id: "m_pending001",
    kind: "scene",
    conversationId: "conv-1",
    // file 不给，模拟"生成中"
    prompt: "生成中的提示词"
  });
  assert.equal(rec.file, null);
  const { records, dropped } = await readIndex(dataDir);
  assert.equal(records.length, 1);
  assert.equal(dropped, 1, "该计数出来：1 条记录没有 file");
  const got = await getBytes(dataDir, "m_pending001");
  assert.equal(got.ok, false);
  assert.match(got.reason, /没有 file/);
});

await fs.rm(tmp, { recursive: true, force: true });

console.log("");
if (failed.length) {
  console.error(`❌ 图片台账：${pass} 过 / ${failed.length} 败`);
  process.exit(1);
}
console.log(`✅ 图片台账：${pass} 过 / 0 败`);
