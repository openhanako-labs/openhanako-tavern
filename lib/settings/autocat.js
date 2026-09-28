// lib/settings/autocat.js — 设定库的启发式分类（纯函数，无副作用）
//
// 判据来自方案文档 2026-09-27-settings-library-ui.md 的四、6：
//
//   自动初判**只填高置信的三类**（组织 / 系统 / 地点）。
//
//   |         | 实测（106 条真库） |
//   |---      |---                 |
//   | 准的   | 组织 8、系统 13、地点 6（靠「企业」「[xxx]」「塔/星/港」） |
//   | 漏的   | 角色只认出 14/27 —— `拉斯提/男性原版`、`莉娜·许奈德` 全进了「设定」 |
//   | 兜底   | 「设定」桶 55 条 —— **兜底桶一大，分类就等于没分** |
//
// 之所以只填三类、其余留空：
//   · 「角色」是**最容易猜错**的一类——真库里 27 条角色，靠关键词只能认出 14 条，
//     剩下的全被误归进「设定」；猜错的条目得用户一条一条改，比不分类还费时。
//   · 「物品/能力/事件/设定」的启发式信号弱，一猜就是兜底桶，兜底桶一大分类就等于没做。
//   · 宁可空着让用户自己点，也不要猜错一百条让他回头改。
//
// 输出约定：只返回 `"组织" | "系统" | "地点" | ""`（空串 = 无把握，交给用户）。
// 不返回 `"未分类"` —— 空串就是「未分类」，UI 层负责把它们聚合到一个桶里。

/** 判定一条设定的类目。纯函数，不修改入参。 */
export function guessCategory(setting) {
  if (!setting || typeof setting !== "object") return "";
  const raw = String(setting.name || setting.comment || "").trim();
  if (!raw) return "";

  const name = stripDecor(raw);
  if (!name) return "";

  // ── 早退：像人名的直接留空 ──
  // 名字里出现分隔符「·」（东亚人名与西人名常见）、或带「/」的性别后缀
  // （真库里有 `拉斯提/男性原版`），启发式一律识别不了，硬猜就是 55 条错一半。
  if (name.includes("·") || name.includes("/")) return "";

  // 明确的人物标记 —— 「男性」「女性」「原版」出现在名字里，基本都是人。
  if (/(?:男性|女性|原版|男|女)$/.test(name)) return "";

  // ── 组织：靠「企业-」这类前缀，或明确的机构后缀 ──
  if (/^(?:企业|机构|协会|公会|商会|公司|工会|党|派|军|宗|教|盟|院|会|司|府)\s*[－\-—]/.test(name)
    || /\s*(?:企业|协会|商会|公司|公会|工会|党|派|军|宗|教|盟|组织|学院|研究所|舰队|舰队本部|王国|帝国|共和国)$/.test(name)) {
    return "组织";
  }

  // ── 系统：ST 世界书常用 `[tag]` 前缀做元指令（[initvar]/[mvu_update]），
  //         或名字以「系统」「协议」结尾（数值系统 / 骰子系统 / DM核心协议解释）──
  if (/^\s*\[.+?\]/.test(name)) return "系统";
  if (/\s*(?:系统|协议|机制)$/.test(name)) return "系统";

  // ── 地点：靠地形词结尾。真库里是「哨塔」「🌎 祖星」「旧宇宙港」这类 ──
  if (/\s*(?:塔|城|村|镇|港|山|岛|湖|海|原|野|界|星|林|岸|大陆|王国|帝国)$/.test(name)) {
    return "地点";
  }
  if (/\s*(?:大陆|群岛|海域|山脉)$/.test(name)) return "地点";

  // ── 都不像：宁可留空 ──
  return "";
}

/**
 * 批量：对每条调用 guessCategory，只写回**有把握**的三类。
 *
 * 为什么是"只写回有把握的"：
 *   · 空串 = 「未分类」，UI 会聚成一个兜底桶，用户一眼看到要自己分的部分。
 *   · 强行把空串都填成"设定"就是回到 55 条「设定」桶那天的老路。
 *
 * @param {object[]} settings
 * @returns {Map<string, string>} id → 判出的类目（空串代表没判出）
 */
export function guessForAll(settings) {
  const map = new Map();
  if (!Array.isArray(settings)) return map;
  for (const s of settings) {
    if (!s || typeof s !== "object") continue;
    const key = String(s.id || "");
    if (!key) continue;
    map.set(key, guessCategory(s));
  }
  return map;
}

/**
 * 剥掉名字前面的 emoji 装饰。
 *
 * 真库里的写法很杂：`🌺 故事主舞台-梨花大学`、`🐦 企业-许奈德`、`🌎 祖星`。
 * emoji 后面跟一个半角空格再进名字。
 *
 * 用字面量时**必须带 u 标志**，否则 \p{...} 属性会被当成普通字符（`p{Extended...}`）——
 * 那正则就永远不命中，stripDecor 变恒等函数，后面所有基于 stripDecor 的规则都失效。
 */
function stripDecor(raw) {
  return raw
    .replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji}\uFE0F\u20E3]{1,6}\s*/u, "")
    .trim();
}
