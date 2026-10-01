// lib/story/protocol.js — 剧情卡输出协议（cwv1）解析器
//
// 设计目标（对齐 plans/2026-10-01-story-protocol-p1.md）：
//
//   1. **纯函数**：`parseStoryProtocol(text) → result`。无副作用、无 IO、无随机。
//      好处：可以单独跑测试、可以在管线任何位置重复调用（幂等），
//      也可以让 UI 前端复制一份来渲染历史消息。
//
//   2. **降级是底线**：没有一处会抛异常。任何解析失败都走 fallback ——
//      未知标签块整体忽略；混排里剥不掉的段进 plainRemainder；
//      完全没标签 = `found:false`，UI 走旧气泡渲染（与现状逐像素一致）。
//
//   3. **协议是命门**：版本常量 `PROTOCOL_VERSION` 显式挂出。
//      未来演进加 cwv2，老前端读到 cwv1 的解析结果照旧，
//      新前端读到 cwv2 时可以走扩展解析器，语义不改。
//
// 协议语法（行首 `【名】` 打头，一行一个块）：
//
//   【剧情】                     → story { type, title, scene }
//   【对话】                     → dialogue[]（【角色|心情】: 台词 / 【旁白】: 叙述）
//   【效果】                     → effects[]（`name +N` / `name -N` / `name = 值`）
//   【场景更新】                 → sceneUpdates[]（新增人物 / 新增物品 / - 移除…）
//   【选项】                     → choices[]（`A. 内容`）
//   【摘要】                     → summary string（拼进前情提要，不进界面）
//
// 未知标签：整块忽略（不崩、不进 plainRemainder）。
// 混排：剥掉所有已知块与未知块之后剩下的行拼进 plainRemainder。

/** 协议版本号。写死在这里，UI 与预设共用。 */
export const PROTOCOL_VERSION = "cwv1";

/** 顶层已识别的标签名。其它 【…】 视为未知块。 */
const KNOWN_TOP_TAGS = new Set([
  "剧情",
  "对话",
  "效果",
  "场景更新",
  "选项",
  "摘要"
]);

/** 块首：一整行恰好是 `【名】`（允许行尾空白）。 */
const TAG_LINE_RE = /^\s*【([^】]+)】\s*$/;

/** 对话行：`【角色名|心情】: 台词` 或 `【旁白】: 叙述`（同一行有 `: 内容`）。 */
const DIALOGUE_LINE_RE = /^\s*【([^】]+)】\s*[:：]\s*(.*)$/;

/** 效果行：`name +N` / `name -N` / `name = 值`。变量名允许 `角色.属性` 层级。 */
// 名字部分允许中文、字母、数字、下划线、点、连字符；不允许空白
// 注：JS 的 \w 不认汉字——名字段用否定集（非空白、非算子字符）而不是 \w，
// 否则「体力 -10」这种中文变量名整条不匹配（2026-10-01 实测 effects 全空）。
const EFFECT_LINE_RE = /^\s*([^\s+\-=][^+\-=]*?)\s*(?:(\+|-)\s*([0-9]+(?:\.[0-9]+)?)|(=)\s*(.+))\s*$/;

/** 选项行：`A. 内容` / `a) 内容` / `A：内容`（一个大写字母开头）。 */
const CHOICE_LINE_RE = /^\s*([A-Za-z])\s*[.．、)：:]\s*(.+)\s*$/;

/** 场景更新行：`新增人物: 名|性别|心情|重要性：描述` / `新增物品: 名：描述` / `- 移除…`。 */
const SCENE_NEW_PERSON_RE = /^\s*新增人物\s*[:：]\s*(.+)$/;
const SCENE_NEW_ITEM_RE = /^\s*新增物品\s*[:：]\s*(.+)$/;
const SCENE_REMOVE_RE = /^\s*-\s*移除\s*[:：]\s*(.+)$/;

/** 空结果。 */
function emptyResult() {
  return {
    found: false,
    version: PROTOCOL_VERSION,
    story: null,
    dialogue: [],
    effects: [],
    sceneUpdates: [],
    choices: [],
    summary: null,
    plainRemainder: ""
  };
}

/**
 * 解析剧情卡协议文本。
 *
 * @param {string} text 原始回复文本（一字不动）
 * @returns {{found:boolean, version:string, story:object|null, dialogue:object[],
 *            effects:object[], sceneUpdates:object[], choices:object[],
 *            summary:string|null, plainRemainder:string}}
 */
export function parseStoryProtocol(text) {
  if (typeof text !== "string" || text.length === 0) return emptyResult();

  const lines = text.split(/\r?\n/);
  const result = emptyResult();
  result.found = false;

  const plainLines = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 尝试匹配块首。只认 KNOWN_TOP_TAGS；其它 【…】 行整块忽略。
    const tagM = line.match(TAG_LINE_RE);
    if (tagM) {
      const tag = tagM[1].trim();

      if (!KNOWN_TOP_TAGS.has(tag)) {
        // 未知标签：吞掉整个块直到下一个已知块首或 EOF
        i++;
        while (i < lines.length) {
          const next = lines[i];
          const nextM = next.match(TAG_LINE_RE);
          if (nextM && KNOWN_TOP_TAGS.has(nextM[1].trim())) break;
          i++;
        }
        continue;
      }

      // 收集块内行（不含块首，直到下一个已知块首或 EOF）
      const blockLines = [];
      i++;
      while (i < lines.length) {
        const next = lines[i];
        const nextM = next.match(TAG_LINE_RE);
        if (nextM && KNOWN_TOP_TAGS.has(nextM[1].trim())) break;
        blockLines.push(next);
        i++;
      }

      // 分派到各块的解析器
      const parsed = parseBlock(tag, blockLines);
      mergeBlockResult(result, tag, parsed);
      result.found = true;
      // 严格行形块没吃掉的非空行还回正文（块后的混排正文不丢）
      for (const lo of leftoverLines(tag, blockLines)) plainLines.push(lo);
      continue;
    }

    // 非块首行：属于 plainRemainder（剥掉块之后剩下的正文）
    // 块外的空行也进 plainLines，最后 join 时会自然带上
    plainLines.push(line);
    i++;
  }

  result.plainRemainder = plainLines.join("\n").replace(/^\s+/, "").replace(/\s+$/, "");
  return result;
}

/** 分派块解析。tag 已经过 KNOWN_TOP_TAGS 校验。 */
function parseBlock(tag, blockLines) {
  switch (tag) {
    case "剧情": return parseStoryBlock(blockLines);
    case "对话": return parseDialogueBlock(blockLines);
    case "效果": return parseEffectsBlock(blockLines);
    case "场景更新": return parseSceneUpdatesBlock(blockLines);
    case "选项": return parseChoicesBlock(blockLines);
    case "摘要": return parseSummaryBlock(blockLines);
    default: return null;
  }
}

/** 合并块解析结果到主结果对象。 */
function mergeBlockResult(result, tag, parsed) {
  if (!parsed) return;
  switch (tag) {
    case "剧情": result.story = parsed; break;
    case "对话": result.dialogue = parsed; break;
    case "效果": result.effects = parsed; break;
    case "场景更新": result.sceneUpdates = parsed; break;
    case "选项": result.choices = parsed; break;
    case "摘要": result.summary = parsed; break;
  }
}

/**
 * 块内没吃掉的行还回 plainRemainder（2026-10-01）。
 *
 * 混排场景：AI 在【效果】块后又写了一句普通正文。块收集循环会把
 * 这句吞进 blockLines，块解析器不认它（不匹配任何行形），于是它
 * 消失了——协议本意是「坏行忽略」，但「块后的正文」不该丢。
 *
 * 判定：这些块是「逐行严格形」的（剧情/效果/选项），没匹配行形的
 * 非空行还回正文；对话/场景更新/摘要本身就是自由文本，全算吃掉。
 */
const STRICT_LINE_BLOCKS = new Set(["剧情", "效果", "选项"]);
function leftoverLines(tag, blockLines) {
  if (!STRICT_LINE_BLOCKS.has(tag)) return [];
  const re = tag === "剧情" ? /^([^:：]+)\s*[:：]\s*(.*)$/
    : tag === "效果" ? EFFECT_LINE_RE
    : CHOICE_LINE_RE;
  return blockLines.filter(raw => {
    const s = raw.trim();
    return s && !re.test(raw);
  });
}

// ── 各块解析器 ──────────────────────────────────────────

/** 【剧情】块：逐行 `key: value`。识别 类型 / 标题 / 场景。 */
function parseStoryBlock(lines) {
  const story = { type: "", title: "", scene: "" };
  for (const raw of lines) {
    const s = raw.trim();
    if (!s) continue;
    const m = s.match(/^([^:：]+)\s*[:：]\s*(.*)$/);
    if (!m) continue;
    const k = m[1].trim();
    const v = m[2].trim();
    if (k === "类型") story.type = v;
    else if (k === "标题") story.title = v;
    else if (k === "场景") story.scene = v;
    // 其它 key 忽略——协议演进时新字段进来不会崩
  }
  return story;
}

/** 【对话】块：`【角色|心情】: 台词` / `【旁白】: 叙述`。非对话行忽略。 */
function parseDialogueBlock(lines) {
  const out = [];
  for (const raw of lines) {
    const m = raw.match(DIALOGUE_LINE_RE);
    if (!m) continue;
    const head = m[1].trim();
    const text = m[2].trim();
    if (!text) continue;
    if (head === "旁白") {
      out.push({ speaker: "", mood: "", text, isNarration: true });
    } else {
      const [speaker, mood] = splitSpeakerMood(head);
      out.push({ speaker, mood, text, isNarration: false });
    }
  }
  return out;
}

/** `角色名|心情` 拆开。没有 | 时 mood 为空串。 */
function splitSpeakerMood(head) {
  const parts = head.split("|").map(s => s.trim());
  return [parts[0] || "", parts[1] || ""];
}

/** 【效果】块：`体力 -10` / `薇拉.好感度 +2` / `时间 = 深夜`。坏行忽略。 */
function parseEffectsBlock(lines) {
  const out = [];
  for (const raw of lines) {
    const s = raw.trim();
    if (!s) continue;
    const m = s.match(EFFECT_LINE_RE);
    if (!m) continue;
    const name = m[1].trim();
    if (!name) continue;
    if (m[2] === "+") out.push({ name, op: "+", value: m[3], raw: s });
    else if (m[2] === "-") out.push({ name, op: "-", value: m[3], raw: s });
    else if (m[4] === "=") out.push({ name, op: "=", value: m[5].trim(), raw: s });
  }
  return out;
}

/** 【场景更新】块：新增人物 / 新增物品 / - 移除…。 */
function parseSceneUpdatesBlock(lines) {
  const out = [];
  for (const raw of lines) {
    const s = raw.trim();
    if (!s) continue;

    const person = s.match(SCENE_NEW_PERSON_RE);
    if (person) {
      const [name, gender, mood, role, desc] = splitPipeWithDesc(person[1].trim());
      out.push({
        kind: "person",
        name, gender: gender || "", mood: mood || "", role: role || "",
        description: desc || "", raw: s
      });
      continue;
    }

    const item = s.match(SCENE_NEW_ITEM_RE);
    if (item) {
      const [name, desc] = splitNameDesc(item[1].trim());
      out.push({ kind: "item", name, description: desc || "", raw: s });
      continue;
    }

    const remove = s.match(SCENE_REMOVE_RE);
    if (remove) {
      out.push({ kind: "remove", target: remove[1].trim(), raw: s });
      continue;
    }
  }
  return out;
}

/** `商队头领|男|戒备|次要：描述` → 前 4 段 pipe + 最后一段以 `：` 分隔描述。 */
function splitPipeWithDesc(body) {
  const descSep = body.search(/[:：]/);
  const head = descSep >= 0 ? body.slice(0, descSep) : body;
  const desc = descSep >= 0 ? body.slice(descSep + 1).trim() : "";
  const parts = head.split("|").map(s => s.trim());
  return [parts[0] || "", parts[1] || "", parts[2] || "", parts[3] || "", desc];
}

/** `魔族徽记：描述` → [name, description]。没有分隔符时 description 为空。 */
function splitNameDesc(body) {
  const sep = body.search(/[:：]/);
  if (sep < 0) return [body.trim(), ""];
  return [body.slice(0, sep).trim(), body.slice(sep + 1).trim()];
}

/** 【选项】块：`A. 内容`。字母大小写不敏感，只保留原文。 */
function parseChoicesBlock(lines) {
  const out = [];
  for (const raw of lines) {
    const m = raw.match(CHOICE_LINE_RE);
    if (!m) continue;
    out.push({ letter: m[1].toUpperCase(), text: m[2].trim() });
  }
  return out;
}

/** 【摘要】块：整块非空文本拼起来。允许空块（返回 null）。 */
function parseSummaryBlock(lines) {
  const joined = lines.join("\n").trim();
  return joined || null;
}

export default { PROTOCOL_VERSION, parseStoryProtocol };
