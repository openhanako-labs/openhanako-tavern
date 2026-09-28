// lib/director/report.js — 模型的上报语法
//
// 光有规则还不够：模型得能**推动状态**，否则它只能自由发挥文字，
// 而状态照旧死着——张力永远停在基线的进度上，人物永远不记得自己刚承认过什么。
//
// 所以给一条可选的上报语法，跟 `[场景]` 标记同族：
//
//     [状态 tension+2 flag:confessed]
//
// 三个原则：
//   · **可选**。不写不报错——基线的 `always` 规则保证剧情照样往前走。
//   · **要校验**。数值不许越界、开关必须在配方里声明过；非法的丢弃，
//     由 engine 记进 rejected，不静默吞掉。
//   · **不外泄**。标记是给引擎看的，落到正文里就成了读者眼里的乱码，
//     所以解析完要从文本中摘掉。

import { VAR_NAME_PATTERN } from "./model.js";

/** 一对标记：`[状态 …]`（半角/全角冒号都认）。 */
const MARK_RE = /\[状态[:：]?\s*([^\]]*)\]/g;

/** 数值上报：`tension+2` / `tension-1` / `tension=3`。 */
const DELTA_RE = new RegExp("^(" + VAR_NAME_PATTERN + ")([+\\-=])(\\d+(?:\\.\\d+)?)$");

/** 开关上报：`flag:confessed` 置真；`flag:!confessed` 或 `-flag:confessed` 置假。 */
const FLAG_ON_RE = new RegExp("^flag[:：](" + VAR_NAME_PATTERN + ")$");
const FLAG_OFF_RE = new RegExp("^(?:-|!)?flag[:：]!?(" + VAR_NAME_PATTERN + ")$");

/**
 * 从文本里抽出所有上报，并返回摘掉标记后的正文。
 *
 * @param {string} text
 * @returns {{reports: Array, text: string, bad: string[]}}
 */
export function parseDirectorReport(text) {
  const src = String(text ?? "");
  const reports = [];
  const bad = [];

  const cleaned = src.replace(MARK_RE, (_whole, inner) => {
    for (const token of String(inner || "").trim().split(/\s+/).filter(Boolean)) {
      const delta = DELTA_RE.exec(token);
      if (delta) {
        reports.push({ kind: "num", name: delta[1], op: delta[2], value: Number(delta[3]), raw: token });
        continue;
      }
      if (FLAG_ON_RE.test(token)) {
        reports.push({ kind: "flag", name: FLAG_ON_RE.exec(token)[1], value: true, raw: token });
        continue;
      }
      // `-flag:x` / `flag:!x`：关掉。放在置真之后判，免得 `flag:x` 被这条抢走。
      if (/[-!]/.test(token) && FLAG_OFF_RE.test(token)) {
        reports.push({ kind: "flag", name: FLAG_OFF_RE.exec(token)[1], value: false, raw: token });
        continue;
      }
      bad.push(token);
    }
    return "";   // 标记不上屏
  });

  return { reports, text: cleaned, bad };
}

/** 只摘标记，不要上报（渲染历史消息时用）。 */
export function stripDirectorReport(text) {
  return String(text ?? "").replace(MARK_RE, "").replace(/[ \t]+\n/g, "\n").trim();
}
