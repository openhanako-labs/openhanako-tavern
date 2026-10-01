// test/regression-simulation.mjs — 模拟经营（第 9 期）
// node test/regression-simulation.mjs

import { createFarm, ensureFarm, tick, plant, harvest, clearCell, SIM_DEFAULTS } from "../lib/simulation/core.js";

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  ✅ " + label); }
  else { fail++; console.log("  ❌ " + label); }
}

// ── createFarm / ensureFarm ──
{
  const f = createFarm();
  ok(f.grid.length === 25 && f.grid.every(c => !c.slot), "默认 25 格全空");
  const conv = {};
  const a = ensureFarm(conv);
  ok(a === conv.simulation && a.grid.length === 25, "ensureFarm 惰性初始化");
  const b = ensureFarm(conv);
  ok(b === a, "幂等");
}

// ── plant / 冲突 / 越界 ──
{
  const f = createFarm();
  plant(f, 0, { kind: "grow", item: "霜麦" });
  ok(f.grid[0].slot.item === "霜麦" && f.grid[0].fields["湿度"] === 5, "种下+初始湿度");
  let threw = false;
  try { plant(f, 0, { kind: "grow", item: "重复" }); } catch { threw = true; }
  ok(threw, "同格重复种植拒绝");
  threw = false;
  try { plant(f, 99, { kind: "grow" }); } catch { threw = true; }
  ok(threw, "越界拒绝");
}

// ── tick：生长（夜间 ×2）──
{
  const f = createFarm({ growSeconds: 60 });
  plant(f, 0, { kind: "grow", item: "霜麦" });
  f.lastTick = Date.now() - 30 * 1000;                 // 模拟过了 30 秒
  tick(f, {});
  ok(!f.grid[0].slot.ready, "30s 不足 60s 不成熟");
  f.lastTick = Date.now() - 40 * 1000;                 // 再过 40s（累计 70 > 60）
  const ev = tick(f, {});
  ok(f.grid[0].slot.ready && ev.some(e => e.type === "ready"), "累计 70s 成熟");
  // 夜间：20 秒有效 40
  const f2 = createFarm({ growSeconds: 60 });
  plant(f2, 1, { kind: "grow", item: "夜麦" });
  f2.lastTick = Date.now() - 20 * 1000;
  tick(f2, { "时段": "夜" });
  ok((f2.grid[1].slot.progress || 0) >= 40, "夜间生长 ×2（20s 有效 40s）");
}

// ── 收获 + 湿度加成 ──
{
  const f = createFarm();
  plant(f, 0, { kind: "grow", item: "霜麦" });
  f.grid[0].slot.ready = true;
  f.grid[0].slot.progress = 999;
  f.grid[0].fields["湿度"] = 8;                        // ≥5 → ×1
  const r = harvest(f, 0);
  ok(r["yield"] === SIM_DEFAULTS.yieldBase, "湿度足 → 满产量");
  ok(f.grid[0].slot === null && f.grid[0].fields["湿度"] === 5, "收获后槽清空、地力 -3");
  // 干旱 → 减产
  plant(f, 1, { kind: "grow", item: "旱麦" });
  f.grid[1].slot.ready = true;
  f.grid[1].fields["湿度"] = 1;
  ok(harvest(f, 1)["yield"] === Math.floor(SIM_DEFAULTS.yieldBase * 0.5), "干旱 → 减产");
  // 未成熟
  plant(f, 2, { kind: "grow", item: "青苗" });
  let threw = false;
  try { harvest(f, 2); } catch (e) { threw = e.message.includes("成熟"); }
  ok(threw, "未成熟收获拒绝（带进度提示）");
}

// ── tick：消耗型（卖出）──
{
  const f = createFarm({ consumeSeconds: 45, pricePerItem: 2 });
  plant(f, 3, { kind: "consume", item: "烤鱼", stock: 5 });
  f.lastTick = Date.now() - 90 * 1000;                 // 90s → 卖 2 件
  const ev = tick(f, {});
  const slot = f.grid[3].slot;
  ok(slot.stock === 3 && slot.earned === 4, "90s 卖 2 件（5→3，赚 4）");
  ok(ev.some(e => e.type === "sold"), "卖出事件");
  f.lastTick = Date.now() - 200 * 1000;                // 大量时间 → 售罄
  const ev2 = tick(f, {});
  ok(slot.stock === 0 && ev2.some(e => e.type === "soldout"), "售罄事件");
}

// ── 惰性 tick：lastTick 语义（世界在你看不见时也在走）──
{
  const f = createFarm({ growSeconds: 10 });
  plant(f, 0, { kind: "grow", item: "速生麦" });
  f.lastTick = Date.now() - 3600 * 1000;               // 一小时前
  const ev = tick(f, {});
  ok(f.grid[0].slot.ready, "一小时后早熟了（惰性 tick 追账）");
  ok(ev.length > 0, "事件带出来");
  const ev2 = tick(f, {});                              // 立刻再 tick
  ok(ev2.length === 0, "无流逝无事件");
}

// ── clearCell ──
{
  const f = createFarm();
  plant(f, 5, { kind: "grow", item: "废苗" });
  const removed = clearCell(f, 5);
  ok(removed?.item === "废苗" && f.grid[5].slot === null, "摘除槽位");
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
