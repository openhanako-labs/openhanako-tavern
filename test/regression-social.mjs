// test/regression-social.mjs — 虚拟社交（第 7 期：feed 存储 + 路由 mock）
// node test/regression-social.mjs

import { FeedRepo } from "../lib/social/feed.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  ✅ " + label); }
  else { fail++; console.log("  ❌ " + label); }
}

// ── FeedRepo round-trip ──
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-social-"));
  const repo = new FeedRepo(dir);
  await repo.init();

  const p1 = await repo.addPost({ characterId: "c1", characterName: "薇拉", text: "今夜北境有雨。" });
  const p2 = await repo.addPost({ characterId: "c2", characterName: "爱莉丝", text: "训练到深夜。" });
  ok(p1.id && p2.id && p1.id !== p2.id, "两条动态各自有 id");

  const list = await repo.list();
  ok(list.length === 2 && list[0].id === p2.id, "列表新的在前");

  const mine = await repo.list({ characterId: "c1" });
  ok(mine.length === 1 && mine[0].characterId === "c1", "按角色过滤");

  // 点赞 / 取消
  const liked = await repo.toggleLike(p1.id, "玩家");
  ok(liked.likes.includes("玩家"), "点赞");
  const unliked = await repo.toggleLike(p1.id, "玩家");
  ok(!unliked.likes.includes("玩家"), "再点取消");

  // 评论 + 角色回应
  await repo.addComment(p1.id, { by: "玩家", text: "注意保暖" });
  const comments = await repo.addComment(p1.id, { by: "薇拉", text: "嗯。", isCharacter: true });
  ok(comments.length === 2 && comments[1].isCharacter === true, "评论与角色回应");

  // 空内容拒绝
  let threw = false;
  try { await repo.addPost({ characterId: "c1", text: "  " }); } catch { threw = true; }
  ok(threw, "空动态拒绝");
  threw = false;
  try { await repo.addComment(p1.id, { by: "玩家", text: "" }); } catch { threw = true; }
  ok(threw, "空评论拒绝");

  // 删除
  const r = await repo.removePost(p2.id);
  ok(r.removed === 1 && (await repo.list()).length === 1, "删动态");

  // 不存在的动态
  threw = false;
  try { await repo.toggleLike("nope", "玩家"); } catch { threw = true; }
  ok(threw, "点赞不存在的动态报错");

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 淘汰上限 ──
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-social2-"));
  const repo = new FeedRepo(dir);
  await repo.init();
  for (let i = 0; i < 30; i++) {
    await repo.addPost({ characterId: "c1", characterName: "x", text: `动态 ${i}` });
  }
  const all = await repo.list({ limit: 1000 });
  ok(all.length === 30, "30 条全在（上限 200 远未到）");
  ok(all[0].text === "动态 29", "最新在前");
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
