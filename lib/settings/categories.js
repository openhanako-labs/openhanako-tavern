// lib/settings/categories.js — 设定库的类目表（ElecKoi 本地概念）
//
// 存 app-data/eleckoi-tavern/categories.json，形状是一个**有序数组**：
//   ["角色", "组织", "地点", ...]
// 顺序即 UI 里「分类维度」分组抬头的顺序，别的地方不再另维护一份。
//
// 判据（写这层之前定下的，别在函数里再解释一遍）：
//   · 它是本地标签，不是世界书语义——绝不出现在 ST 导出里（见 export.js 里的 delete entry.category）
//   · 「并到」比「删除」诚实：删了条目掉进未分类无从追溯，并了它们还知道去哪
//   · 增删改都要连锁 settings.json 里已经标了这个类目的条目——
//     只改类目表不改条目，两边对不上就是「改了没生效」的经典 bug
//
// 复用 atomic.js 的 mutateJson：并发写不会互相覆盖。

import path from "node:path";
import { mutateJson, readJsonSafe, ensureDir } from "../atomic.js";

/** 默认 8 个。方案文档里定过：这比用户举的三个多——「能力」「事件」在真库各有一批。 */
export const DEFAULT_CATEGORIES = ["角色", "组织", "地点", "物品", "能力", "事件", "设定", "系统"];

/** 类目表文件在数据目录下的相对位置。 */
export const CATEGORIES_FILE = "categories.json";

/**
 * 类目表的门面。仓库式的读写接口，业务逻辑都在这。
 *
 * 为什么单独一个类而不是散函数：
 *   「改名」和「并到」都要连锁 settings.json 里已经用了这个类目的条目——
 *   两步都得走 mutateJson，两个文件两把锁，逻辑得绑在一起才不易写错。
 */
export class CategoryStore {
  /**
   * @param {string} dataDir  App 数据目录（app-data/eleckoi-tavern）
   * @param {import("../atomic.js").mutateJson} [mutateFn]  可注入的 mutateJson，测试用
   */
  constructor(dataDir, mutateFn = mutateJson) {
    if (!dataDir) throw new Error("dataDir is required");
    this.dataDir = dataDir;
    this.file = path.join(dataDir, CATEGORIES_FILE);
    this.settingsFile = path.join(dataDir, "settings.json");
    this._mutate = mutateFn;
  }

  /**
   * 文件不存在 → 写默认 8 个。
   * 已经是数组 → 不动。
   * 坏形状（对象/字符串/undefined）→ 先备份留证再写默认。
   *
   * 备份是必须的：readJsonSafe 只在 JSON 解析失败时自动备份，
   * 「能解析但不是数组」的形状它不管——那正好是用户手改过又写坏的典型态。
   */
  async init() {
    await ensureDir(this.dataDir);
    await this._mutate(this.file, DEFAULT_CATEGORIES, async (cur) => {
      if (Array.isArray(cur)) return undefined; // 已存在，不动
      if (cur !== null && cur !== undefined) {
        try {
          const fs = await import("node:fs/promises");
          const broken = `${this.file}.broken-${Date.now()}`;
          await fs.rename(this.file, broken);
          console.error(`[categories] 形状错误，已备份到 ${broken}`);
        } catch { /* 备份失败不阻断启动 */ }
      }
      return DEFAULT_CATEGORIES.slice();
    });
    return this;
  }

  /** 返回一份拷贝——防止调用方误改内部状态。 */
  async list() {
    const raw = await readJsonSafe(this.file, DEFAULT_CATEGORIES);
    if (!Array.isArray(raw)) return DEFAULT_CATEGORIES.slice();
    return raw.map(s => String(s)).filter(Boolean);
  }

  /**
   * 计数某个类目下的条目数（含 enabled=false 的）。
   * 用于弹层里的「类目名 · N 条」。
   */
  async count(name) {
    const key = String(name || "").trim();
    if (!key) return 0;
    const raw = await readJsonSafe(this.settingsFile, []);
    if (!Array.isArray(raw)) return 0;
    return raw.filter(s => String(s?.category || "").trim() === key).length;
  }

  /** 添加一个类目。已存在或空串 → 不写盘，返回当前列表。 */
  async add(name) {
    const key = String(name || "").trim();
    if (!key) return this.list();
    return this._mutate(this.file, DEFAULT_CATEGORIES, (cur) => {
      const arr = Array.isArray(cur) ? cur.map(String) : [];
      if (arr.includes(key)) return undefined;
      arr.push(key);
      return arr;
    });
  }

  /**
   * 改名。连锁改 settings.json 里所有 category === oldName 的条目。
   *
   * 为什么连锁：不连锁的话，用户重命名「物品 → 道具」，类目表改了、条目里还是「物品」，
   * UI 那边「未分类」桶一下多出几十条——比不重命名还糟。
   */
  async rename(oldName, newName) {
    const from = String(oldName || "").trim();
    const to = String(newName || "").trim();
    if (!from || !to) return this.list();
    if (from === to) return this.list();

    // 类目表先改——如果撞名就报错，settings 不动
    await this._mutate(this.file, DEFAULT_CATEGORIES, (cur) => {
      const arr = Array.isArray(cur) ? cur.map(String) : [];
      const idx = arr.indexOf(from);
      if (idx === -1) throw new Error(`类目不存在: ${from}`);
      if (arr.includes(to)) throw new Error(`类目已存在: ${to}`);
      arr[idx] = to;
      return arr;
    });

    // 条目连锁
    await this._mutate(this.settingsFile, [], (cur) => {
      const arr = Array.isArray(cur) ? cur : [];
      let touched = false;
      const next = arr.map(s => {
        if (s && String(s.category || "").trim() === from) {
          touched = true;
          return { ...s, category: to, updatedAt: new Date().toISOString() };
        }
        return s;
      });
      return touched ? next : undefined;
    });

    return this.list();
  }

  /**
   * 「并到」——把 from 类目下的所有条目改标成 to，然后从类目表删掉 from。
   *
   * 与 rename 的区别：rename 是「同一批东西换个叫法」，merge 是「两批东西合成一批」。
   * 用户按下的时候是「这两堆本来就是一类，我写重了」，不是「我改了个主意」。
   */
  async merge(fromName, toName) {
    const from = String(fromName || "").trim();
    const to = String(toName || "").trim();
    if (!from || !to) throw new Error("源和目标类目名不能为空");
    if (from === to) return this.list();

    await this._mutate(this.file, DEFAULT_CATEGORIES, (cur) => {
      const arr = Array.isArray(cur) ? cur.map(String) : [];
      if (!arr.includes(from)) throw new Error(`源类目不存在: ${from}`);
      if (!arr.includes(to)) throw new Error(`目标类目不存在: ${to}`);
      return arr.filter(n => n !== from);
    });

    await this._mutate(this.settingsFile, [], (cur) => {
      const arr = Array.isArray(cur) ? cur : [];
      let touched = false;
      const next = arr.map(s => {
        if (s && String(s.category || "").trim() === from) {
          touched = true;
          return { ...s, category: to, updatedAt: new Date().toISOString() };
        }
        return s;
      });
      return touched ? next : undefined;
    });

    return this.list();
  }

  /**
   * 删除类目。**不**清条目上的 category——那样条目会静默掉进「未分类」，用户看不出发生了什么。
   * 想清的是「并到」——那才是一致性动作。
   *
   * 但类目从表里拿掉之后，条目上的 category 就是「已废弃标签」：
   *   UI 分组时会退化成「（已废弃）」这类兜底抬头，而不是把用户误带进空桶。
   */
  async remove(name) {
    const key = String(name || "").trim();
    if (!key) return this.list();
    return this._mutate(this.file, DEFAULT_CATEGORIES, (cur) => {
      const arr = Array.isArray(cur) ? cur.map(String) : [];
      if (!arr.includes(key)) return undefined;
      return arr.filter(n => n !== key);
    });
  }
}

/** 工厂：与 repo.js 里的 createSettingRepo 对齐。 */
export function createCategoryStore(dataDir) {
  return new CategoryStore(dataDir);
}
