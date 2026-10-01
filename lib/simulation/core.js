// lib/simulation/core.js — 模拟经营（第 9 期）：格子/槽位/时间规则/环境规则
//
// 两种模式：
//   grow    生长型（农田/养殖）：种下 → 经过时间 → 收获
//   consume 消耗型（商店/贩卖机）：上架 → 随时间卖出 → 进账
//
// 设计（对齐 CinemaWorld 的精华但裁剪）：
//   · 格子网格（默认 25 格，5×5），每格独立字段（肥力/湿度/成熟度……自由键值）
//   · 槽位挂在格子上：{ kind: grow|consume, item, plantedAt, rules }
//   · 时间规则：字段随真实时间自动变化（tick 时按流逝秒数结算，不靠定时器）
//   · 环境规则：场景环境数据（天气/时间）影响变化速率（雨天湿度 +，夜间生长 ×）
//   · 完成规则：什么条件算"成熟/售完"，产量倍率
//
// 关键决策：**tick 是惰性的**——不跑后台定时器，每次读取（打开面板/行动）
// 时按"距上次 tick 的流逝秒数"一次性结算。关闭 App 几天回来，农场照样
// 会长（或枯掉）。这是经营系统的正确时间观：世界在你不看时也活着。

/** 默认配置。 */
export const SIM_DEFAULTS = {
  gridSize: 25,            // 格子数（5×5）
  growSeconds: 60,         // grow：从种下到成熟的基础秒数
  yieldBase: 3,            // 成熟收获的基础产量
  consumeSeconds: 45,      // consume：每件商品售出所需基础秒数
  pricePerItem: 2          // 每件售价（结算进变量「金币」）
};

/** 空农场。 */
export function createFarm(config = {}) {
  const cfg = { ...SIM_DEFAULTS, ...config };
  return {
    config: cfg,
    lastTick: Date.now(),
    grid: Array.from({ length: cfg.gridSize }, () => ({ fields: {}, slot: null }))
  };
}

/** 惰性初始化 conv.simulation。 */
export function ensureFarm(conv) {
  if (!conv || typeof conv !== "object") return null;
  if (!conv.simulation || typeof conv.simulation !== "object") conv.simulation = createFarm();
  const f = conv.simulation;
  f.config = { ...SIM_DEFAULTS, ...(f.config || {}) };
  f.grid = Array.isArray(f.grid) && f.grid.length > 0
    ? f.grid
    : Array.from({ length: f.config.gridSize }, () => ({ fields: {}, slot: null }));
  return f;
}

/**
 * 时间 + 环境结算。**惰性 tick**：按流逝秒数一次性推进所有槽位。
 *
 * @param {object} farm
 * @param {object} env  场景环境数据（{天气:"雨", 时段:"夜", ...}；缺省无加成）
 * @returns {object[]} 本次 tick 发生的事件（成熟/售出），供 UI 提示
 */
export function tick(farm, env = {}) {
  if (!farm || !Array.isArray(farm.grid)) return [];
  const cfg = farm.config;
  const now = Date.now();
  const elapsed = Math.max(0, Math.floor((now - (farm.lastTick || now)) / 1000));
  farm.lastTick = now;
  if (elapsed === 0) return [];

  const events = [];
  // 环境倍率：雨天湿度+（不加速生长）、夜间生长 ×10（CinemaWorld 的设定抄一半，太猛改成 ×2）
  const weather = String(env["天气"] ?? env["天气"] ?? "").trim();
  const isRain = weather.includes("雨") || weather.includes("雪");
  const nightBoost = String(env["时段"] ?? env["时间"] ?? "").includes("夜") ? 2 : 1;

  for (let i = 0; i < farm.grid.length; i++) {
    const cell = farm.grid[i];
    const slot = cell.slot;
    if (!slot) continue;

    if (slot.kind === "grow") {
      // 生长进度按"有效秒数"累计：夜间 ×2
      const effSeconds = elapsed * nightBoost;
      slot.progress = (slot.progress || 0) + effSeconds;
      // 环境字段：雨天湿度随时间 +，否则 -（格子字段自由演化）
      cell.fields["湿度"] = Math.max(0, (cell.fields["湿度"] ?? 5) + (isRain ? Math.floor(elapsed / 8) : -Math.floor(elapsed / 8)));
      if (slot.progress >= cfg.growSeconds && !slot.ready) {
        slot.ready = true;
        events.push({ cell: i, type: "ready", text: `第 ${i + 1} 格的${slot.item}成熟了` });
      }
    } else if (slot.kind === "consume") {
      // 每件商品按 consumeSeconds 卖出
      const sellCount = Math.floor((elapsed * (slot.rate || 1)) / cfg.consumeSeconds);
      if (sellCount > 0 && slot.stock > 0) {
        const sold = Math.min(sellCount, slot.stock);
        slot.stock -= sold;
        slot.earned = (slot.earned || 0) + sold * cfg.pricePerItem;
        events.push({ cell: i, type: "sold", count: sold, text: `第 ${i + 1} 格卖出 ${sold} 件${slot.item}` });
        if (slot.stock <= 0) events.push({ cell: i, type: "soldout", text: `第 ${i + 1} 格的${slot.item}售罄` });
      }
    }
  }
  return events;
}

/**
 * 种下 / 上架。
 * @param {object} farm
 * @param {number} cellIndex
 * @param {{kind:"grow"|"consume", item:string, stock?:number, rate?:number}} spec
 */
export function plant(farm, cellIndex, spec) {
  if (!farm) throw new Error("农场未初始化");
  if (cellIndex < 0 || cellIndex >= farm.grid.length) throw new Error("格子序号越界");
  const cell = farm.grid[cellIndex];
  if (cell.slot) throw new Error(`第 ${cellIndex + 1} 格已有 ${cell.slot.item}`);
  const kind = spec.kind === "consume" ? "consume" : "grow";
  cell.slot = {
    kind,
    item: String(spec.item || (kind === "grow" ? "作物" : "商品")).slice(0, 30),
    progress: 0,
    ready: false,
    stock: kind === "consume" ? Math.max(1, Number(spec.stock) || 10) : null,
    rate: Number(spec.rate) || 1,
    earned: 0
  };
  cell.fields["湿度"] = cell.fields["湿度"] ?? 5;
  return cell.slot;
}

/**
 * 收获（grow 且 ready）。返回产量。
 * 产量 = yieldBase × 湿度加成（湿度 ≥5 → ×1，否则 ×0.5，向下取整，至少 1）。
 */
export function harvest(farm, cellIndex) {
  const cell = farm.grid?.[cellIndex];
  if (!cell?.slot || cell.slot.kind !== "grow") throw new Error("这格没有可收获的作物");
  if (!cell.slot.ready) throw new Error(`还没成熟（进度 ${Math.floor((cell.slot.progress || 0) / farm.config.growSeconds * 100)}%）`);
  const humidity = Number(cell.fields["湿度"] ?? 0);
  const yieldN = Math.max(1, Math.floor(farm.config.yieldBase * (humidity >= 5 ? 1 : 0.5)));
  cell.slot = null;
  cell.fields["湿度"] = Math.max(0, humidity - 3);   // 收获消耗地力
  return { yield: yieldN, item: cell.slot?.item ?? "作物" };
}

/** 摘除槽位（清格子）。 */
export function clearCell(farm, cellIndex) {
  const cell = farm.grid?.[cellIndex];
  if (!cell) throw new Error("格子序号越界");
  const removed = cell.slot;
  cell.slot = null;
  return removed;
}

export default { SIM_DEFAULTS, createFarm, ensureFarm, tick, plant, harvest, clearCell };
