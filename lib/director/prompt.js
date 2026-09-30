// lib/director/prompt.js — 每轮注入给模型的那一块
//
// 它是**动态尾部**的一块：每轮都会变，所以它不是缓存友好的那部分，
// 这是已知代价（见计划 §4 不变式 2），不粉饰。
//
// 位置上它排在 postHistory 之后（更靠近本轮）。与用户预设的收尾指令语义重叠，
// 所以块内**显式声明**自己的身份和优先级——不能指望模型自己推断两段
// 互相冲突的收尾指令里该听谁的。

import { activeBriefs, describeState, evalWhen, previewState } from "./engine.js";
import { VAR_NAME_PATTERN, VAR_NAME_RE } from "./model.js";

const WHEN_RE = new RegExp("^(" + VAR_NAME_PATTERN + ")\\s*(>=|<=|==|!=|>|<)\\s*(-?\\d+(?:\\.\\d+)?)$");

/*
 * 节奏四选项 → 中文指令映射表（S3 / AIRP 图 07）。
 *
 * 为什么写死映射而不让模型自己解释：模型对「更日常」的理解可能是
 * 「写日常对话」，也可能是「降低冲突」——而我们要的是前者（生活细节、
 * 闲笔）而不是后者（降低张力，那是另一个问题）。写死指令避免歧义。
 *
 * key 是存储用的英文标识；label 是 UI 显示；instruction 是注入 prompt 的原句。
 */
const PACING_MAP = {
  daily:    { label: "更日常",
              instruction: "放缓冲突，多写生活细节与闲笔" },
  drama:    { label: "更戏剧",
              instruction: "提高冲突密度，每轮给一个张力点" },
  cast:     { label: "更多人物",
              instruction: "让配角主动行动，带出图鉴里的人物" },
  bond:     { label: "更多感情线",
              instruction: "推进角色间的情感变化与互动" }
};

/** 节奏数组 → 一句注入文本。空数组返回空串（不注入这行）。 */
function pacingLine(pacing) {
  if (!Array.isArray(pacing) || pacing.length === 0) return "";
  const parts = pacing
    .filter(k => PACING_MAP[k])
    .map(k => PACING_MAP[k].instruction);
  if (parts.length === 0) return "";
  return "节奏：" + parts.join("；") + "。";
}

/** 单个条件说成人话（不带「时」，由调用方决定怎么接）。 */
function humanizeSingle(part) {
  const s = String(part ?? "").trim();
  if (!s) return "";
  const m = WHEN_RE.exec(s);
  if (m) {
    // 措辞按**读起来的意思**选，不按符号：
    // `<= 5` 是「不超过 5」，不是「降到 5」（后者听着像正在往下走）
    const word = { ">=": "到", "==": "到", ">": "高过", "<=": "不超过", "<": "还没到", "!=": "不等于" }[m[2]];
    return `${m[1]} ${word} ${m[3]}`;
  }
  if (VAR_NAME_RE.test(s)) return `${s} 为真`;
  return s;   // 认不出来的原样留着——总比编一个错的读法好
}

/**
 * 把条件说成人话。
 *
 * 为什么较真：这行字是**直接给模型看的**。写成 `张力 >= 7 && 张力 < 9`
 * 模型也能懂，但那是在让它读代码——读代码的可靠程度远不如读
 * 「张力在 7 到 9 之间时」。这行不要省力气。
 */
function humanizeWhen(expr) {
  const s = String(expr ?? "").trim();
  if (!s || s === "always") return "";

  // 最常见的一种复合：两头夹一个区间（配方里几乎都长这样）
  const range = new RegExp(
    "^(" + VAR_NAME_PATTERN + ")\\s*>=\\s*(-?\\d+(?:\\.\\d+)?)\\s*&&\\s*\\1\\s*<\\s*(-?\\d+(?:\\.\\d+)?)$"
  ).exec(s);
  if (range) return `${range[1]} 在 ${range[2]} 到 ${range[3]} 之间时`;

  const parts = s.split("&&").map(humanizeSingle).filter(Boolean);
  if (parts.length > 1) return parts.join("，且") + " 时";
  return parts[0] ? parts[0] + " 时" : s;
}

/**
 * 渲染导演块。
 *
 * 约束列的是**全部带 brief 的规则**，不只是命中的那一条。
 * 理由：模型知道地形才能铺垫——它若只被告知「本轮必须出现冲突」，
 * 就永远学不会在第 6 轮先埋那颗雷。命中的那条会被标出来。
 *
 * @param {object} entity
 * @param {object} state  这一轮开始时的状态
 * @param {object} [opts]
 * @param {boolean} [opts.showName] 块头要不要带公式名
 * @param {boolean} [opts.withOverride] 要不要附「覆盖收尾指令」那句
 * @returns {string} 空字符串表示这一块不该出现（没开 / 没规则）
 */
export function renderDirectorBlock(entity, state, opts = {}) {
  if (!entity || entity.enabled === false) return "";
  const rules = Array.isArray(entity.rules) ? entity.rules : [];
  if (rules.length === 0) return "";

  const preview = previewState(entity, state);
  const lines = [];

  /*
   * 块头。
   *
   * 单条时保持原样（【导演 · 本轮】）——不改动已经在跑的对话的 prompt 形状。
   * 多条时必须带名字，否则模型看到两个一模一样的
   * 「【导演 · 本轮】」会以为重复了。
   */
  const name = String(entity.name || "").trim();
  lines.push(opts.showName && name ? `【导演 · 本轮 · ${name}】` : "【导演 · 本轮】");
  lines.push(`状态：${describeState(entity, state) || "（无）"}`);

  const withBrief = rules
    .map((r) => ({
      cond: String(r?.when ?? "").trim(),
      brief: String(r?.brief ?? "").trim(),
      effect: String(r?.effect ?? "").trim()
    }))
    .filter((r) => r.brief);

  if (withBrief.length) {
    lines.push("约束（满足条件时**必须**出现下列性质的事，性质之外怎么写随你）：");
    for (const r of withBrief) {
      const where = humanizeWhen(r.cond);
      // 命中与否按**预演后**的状态判：基线推上去的那一格才算数
      let now = false;
      try { now = evalWhen(r.cond, preview); } catch { now = false; }
      const mark = now ? "▶ 本轮：" : "· ";
      lines.push(`  ${mark}${where ? where + "，" : ""}${r.brief.replace(/[。；;]+$/, "")}。`);
    }
  } else {
    lines.push("约束：这一轮没有硬性要求——按人物自己的逻辑走。");
  }

  /*
   * 节奏注入（S3）。
   * 排在约束之后、freeform 之前——约束是硬规则，节奏是软引导，
   * freeform 是最后的收尾指令（硬覆盖）。三段优先级递减。
   * 空数组 = 不注入这行（不是空行）。
   */
  const pl = pacingLine(entity.pacing);
  if (pl) lines.push(pl);

  if (entity.freeform) lines.push(entity.freeform);

  /*
   * 覆盖声明。为什么不靠模型自己权衡：
   * 用户预设里的收尾指令（post_history）与这一块说的是同一件事——
   * 「下一句怎么写」。两段同权重的话摆在面前，模型会挑一个，
   * 而挑哪个取决于排序、措辞、甚至长度。与其赌，不如说清。
   *
   * 多条公式时**只在最后一个块里说一次**，且措辞改成「以上约束块」——
   * 每个块各自说「这一段覆盖一切」会互相否定，模型只能当没看见。
   */
  if (opts.withOverride !== false) {
    lines.push(opts.multi
      ? "硬约束：以上各段约束共同覆盖本轮的一切收尾指令；与它们冲突的写法一律以它们为准。"
      : "硬约束：这一段覆盖本轮的一切收尾指令；与它冲突的写法一律以它为准。");
  }

  lines.push("（若这一轮确实推动了状态，可在正文末尾写一行 `[状态 名字+1]`；不写也可以。）");

  return lines.join("\n");
}

/**
 * 把一批公式渲染成**一段**注入文本。
 *
 * 单条时输出与以前逐字一致（不改变已在跑的对话的 prompt）。
 * 多条时各块带名字，覆盖声明只在末尾出现一次。
 *
 * @param {Array<{entity: object, state: object}>} parts 已按 order 排好
 * @returns {{ text: string, note: string }}
 */
export function renderDirectorBlocks(parts) {
  const usable = (Array.isArray(parts) ? parts : [])
    .filter(p => p && p.entity && p.entity.enabled !== false)
    .map(p => ({
      entity: p.entity,
      state: p.state || {},
      text: renderDirectorBlock(p.entity, p.state || {}, { showName: false, withOverride: false })
    }))
    .filter(p => p.text);

  if (usable.length === 0) return { text: "", note: "没有可用的公式" };

  if (usable.length === 1) {
    // 单条：回到原样（带覆盖声明），与旧行为逐字一致
    const only = usable[0];
    return {
      text: renderDirectorBlock(only.entity, only.state),
      note: `导演「${only.entity.name}」· ${describeState(only.entity, only.state)}`
    };
  }

  // 多条：每块带名字，末尾统一声明一次
  const chunks = usable.map(p => renderDirectorBlock(p.entity, p.state, { showName: true, withOverride: false }));
  chunks.push("硬约束：以上各段约束共同覆盖本轮的一切收尾指令；与它们冲突的写法一律以它们为准。");
  chunks.push("（若这一轮确实推动了状态，可在正文末尾写一行 `[状态 名字+1]`；不写也可以。）");

  const names = usable.map(p => p.entity.name).filter(Boolean).join(" / ");
  return { text: chunks.join("\n\n"), note: `导演 ${usable.length} 条：${names}` };
}
