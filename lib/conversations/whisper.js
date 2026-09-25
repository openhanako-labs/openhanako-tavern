/**
 * 私语（audience）——让**角色**也能私下说话。
 *
 * 这个文件是「私语」这件事的契约本体：标记的写法、怎么认、提示词怎么告诉模型，
 * 全在这里。分成两份（一份解析、一份写提示词）迟早会各说各话。
 *
 * 它同时堵住了那个更隐蔽的漏：
 * 收到私语的人如果**公开复述**，等于半个公开。所以给听得到私语的那位
 * 单独加一段约束（whisperRule），并把「私下回应」这条路交到她手上。
 *
 * ── 标记 ────────────────────────────────────────────────
 *   回复的第一行写：  [[私语:任十九、薇拉·霜语]]
 *   正文从第二行开始。
 *
 * ── 三条规矩 ────────────────────────────────────────────
 *   · 没有标记 → audience 为 undefined = 公开（旧消息全是这样）
 *   · 写了标记、名字一个都没对上 → audience: [] = **谁都不给**
 *     （fail closed，与黑板 charVisibility 同一条纪律：说不清给谁看，就当谁都不给。
 *      而且它是**看得见**的空——气泡上会标「私语 · 谁都没给」，不闷声改语义。）
 *   · 用户落成哨兵 `@user`：它永远匹配不上任何角色 id，
 *     所以任何角色都看不到 —— 这正是「只跟你说」。
 */

export const USER_SENTINEL = "@user";

// 只认**开头第一行**的标记：正文中间出现同样的字样是台词，不是协议。
const MARKER_RE = /^[ \t]*\[\[\s*私语\s*(?::([^\]]*))?\]\][ \t]*\r?\n?/;

const USER_WORDS = ["你", "我", "user", "me", "you", "userself"];

/**
 * 解析回复开头的私语标记。
 *
 * @param {string} text            模型/角色写的正文
 * @param {object} opts
 * @param {Array<{id:string,name:string}>} opts.roster 这一场的角色名册（用来把名字换成 id）
 * @param {string} opts.userName   用户的名字（对上也算"只说给你"）
 * @returns {{text:string, audience:string[]|undefined, resolved:number}}
 *          resolved = 认出了几个名字（诊断用；0 且写了标记就是 fail closed）
 */
export function parsePrivateMarker(text, { roster = [], userName = "User" } = {}) {
  const raw = String(text ?? "");
  const m = raw.match(MARKER_RE);
  if (!m) return { text: raw, audience: undefined, resolved: 0 };

  const body = raw.slice(m[0].length);
  const words = String(m[1] ?? "")
    .split(/[、,，/|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const uname = String(userName || "User");

  const ids = [];
  let resolved = 0;
  for (const w of words) {
    if (USER_WORDS.includes(w.toLowerCase()) || w === uname) {
      if (!ids.includes(USER_SENTINEL)) ids.push(USER_SENTINEL);
      resolved++;
      continue;
    }
    // 名字对上就给；用 includes 兜"薇拉"对上"薇拉·霜语"这种半名
    const hit =
      roster.find((p) => String(p?.name || "").trim() === w) ||
      roster.find((p) => w.length >= 2 && String(p?.name || "").includes(w));
    if (hit && !ids.includes(hit.id)) {
      ids.push(hit.id);
      resolved++;
    }
  }
  return { text: body, audience: ids, resolved };
}

/** 这一段只在**听得到私语的人**的提示词里出现。 */
export function whisperRule(count) {
  return [
    "## 私语",
    `上面有 ${count} 句是私下说给你听的，别人不知道。`,
    "· 你可以公开回应（别人看得到你的回应），但**不要复述**私语里的内容——除非你选择当场把它说出来。",
    "· 想让你的回复也只有对方听得到：正文第一行只写 `[[私语:对方的名字]]`，回复内容从第二行开始。",
  ].join("\n");
}

/**
 * 这一位发言者听得到的私语有几条。
 * 判据与 visibleMessagesFor 一致：带 audience 且包含她（或 @user 那种给用户的）。
 */
export function whispersHeardBy(messages, viewerId) {
  const vid = String(viewerId ?? "");
  return (messages || []).filter(
    (m) => Array.isArray(m?.audience) && (m.audience.includes(vid) || m.audience.includes(USER_SENTINEL))
  );
}
