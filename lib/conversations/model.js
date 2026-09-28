// lib/conversations/model.js — 对话数据模型

import crypto from "node:crypto";

export const MessageRole = {
  USER: "user",
  ASSISTANT: "assistant",
  SYSTEM: "system"
};

/*
 * MessageKind —— 消息的“额外种类”。
 *
 * 与 role 的关系：
 *   role  = “谁说的”（user / assistant / system）
 *   kind  = “长什么样子”（普通文本 / 插图）
 *
 * 为什么新起一个字段而不是复用 role：
 *   · 插图也是“assistant 说的”（模型触发的场景、模型给的画面描述）——
 *     把它塞进 role 就等于把“谁说的”和“长什么样”两件事混为一谈。
 *   · 旧消息完全没有 kind 字段；读侧只要看 `msg.kind` 就能区分新旧——
 *     没有就是“旧消息，普通文本”，不会因迁移而抛错。
 *
 * 新增 kind 时必须同步：
 *   1. 这里的常量表
 *   2. lib/conversations/model.js 的 createMessage 分支
 *   3. UI 里消息渲染的分派（chat.js）
 * 否则就是“新写的消息前端不知道该怎么画”。
 */
export const MessageKind = {
  TEXT: null,               // 旧消息的默认值：不写就是 text
  ILLUSTRATION: "illustration"
};

export const ConversationStatus = {
  ACTIVE: "active",
  ARCHIVED: "archived",
  DELETED: "deleted"
};

// 创建空对话
export function createEmptyConversation(characterId, overrides = {}) {
  return {
    id: crypto.randomUUID(),
    characterId,
    /*
     * 参与者（群聊）。单角色时就是 [characterId]。
     *
     * `characterId` 保留为“主角 / 开场白来源”——旧对话文件里只有它，
     * 所以**读侧必须能兜**：任何地方要用参与者，都走 participantsOf(conv)。
     */
    characterIds: Array.isArray(overrides.characterIds) && overrides.characterIds.length > 0
      ? [...new Set(overrides.characterIds.map(String).filter(Boolean))]
      : (characterId ? [String(characterId)] : []),
    /*
     * 发完一条后自动轮到下一位（群聊用）。
     *
     * 挂在对话上、而不是全局设置——与 presetId 同一条理由：
     * 「这一场怎么轮」是场景属性。有的场就该轮流开口，
     * 有的场该一直由同一个人回答；全局开关每开一场都要回去改一次，
     * 而改的还会影响别的场。
     *
     * 旧对话文件没这个字段 → **读侧要兜**（`conv.autoRotate === true`），
     * 不去重写文件。
     */
    autoRotate: overrides.autoRotate === true,
    /*
     * 绑定的「导演」配方（配方式文游的剧情公式）。
     *
     * 只存 **id**，不存规则本体：规则是纯配置，改一处全场生效；
     * 进度（张力、开关）则是**这一场自己的**，存在 variables 里。
     * 两者分开，同一张卡开两场就是同一个剧本、两次不同的演出。
     *
     * 旧对话文件没这个字段 → 读侧兜空串，不去重写文件。
     */
    directorId: String(overrides.directorId || ""),
    title: "",
    messages: [],
    variables: {}, // 对话变量状态
    // 用户人设：{user} / {{user}} 宏的来源，也是预设里的 persona 块。
    // 之前没有这两个字段，UI 里改人设后要么丢、要么落到 undefined——
    // 宏替换的结果就变成 "undefined 说"。
    userName: "",
    persona: "",
    /**
     * 这一场用哪套预设（null = 不套预设，走内置组装顺序）。
     *
     * 设计决定：**预设跟随对话**，不是全局的。
     * 同一个角色，一场用「日常对话」、一场用「战斗描写」是常事；
     * 全局的话每开一场都要回去改一次，而改的还会影响别的场。
     * 对话恰好就是「一场」这个粒度的容器，预设挂在它身上最自然。
     *
     * 之前的情况：预设编辑器能用能存，但生成时根本没人读它——
     * presetRepo 传进了路由却一次都没被引用。
     */
    presetId: null,
    // 历史折叠摘要（见 lib/llm/history.js 的 mergeSummary）
    summary: null,
    systemPrompt: "",
    status: ConversationStatus.ACTIVE,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    /*
     * 只让**有值**的 overrides 落地。
     *
     * 裸的 `...overrides` 有个安静的坑：显式传 `persona: undefined`
     * （比如“没带就从上一场继承”算出来的 undefined）会把上面的 `""` 盖成
     * undefined，宏替换就输出 "undefined 说"——正是这两行注释说的那个病。
     * undefined 的意思是“我没打算给值”，不是“我要给一个没有”。
     * （null 不在此列：presetId: null 是合法值，表示“不套预设”。）
     */
    ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined))
  };
}

/**
 * 这一场有哪些角色。
 *
 * 旧对话文件里没有 `characterIds`（那时只有单个 characterId），
 * 所以这个函数是**唯一**该被用来读参与者的地方。
 * 直接读 conv.characterIds 会在旧对话上得到 undefined。
 */
export function participantsOf(conv) {
  const ids = Array.isArray(conv?.characterIds) ? conv.characterIds.filter(Boolean) : [];
  if (ids.length > 0) return ids;
  return conv?.characterId ? [String(conv.characterId)] : [];
}

/**
 * 某个发言人**能看到**的消息（私语过滤）。
 *
 * 三条规矩：
 *   · 没有 `audience` 字段 → 所有人都看得到（旧消息全是这样，读侧必须兜）
 *   · `audience` 是空数组 → **谁都看不到**。这条是 fail closed，
 *     与黑板的 charVisibility 同一条纪律：说不清给谁看，就当谁都不给。
 *   · 没有发言人（例如系统装配）→ 私语一律不给。
 *
 * 返回的是**新数组**，元素还是原对象——调用方不要就地改元素。
 */
export function visibleMessagesFor(conv, viewerId = null) {
  const messages = Array.isArray(conv?.messages) ? conv.messages : [];
  const viewer = viewerId ? String(viewerId) : null;
  return messages.filter((m) => {
    if (!m || !Array.isArray(m.audience)) return true;
    if (m.audience.length === 0) return false;
    if (!viewer) return false;
    return m.audience.some((id) => String(id) === viewer);
  });
}

// 创建消息
//
// 缓存相关字段说明（对应宿主 SDK AppModelUsageV2 / textSignature）：
// - usage: 本轮推理用量（input/output/cacheRead/cacheWrite/cost）
// - rawContent: 原始 assistant 回合数组（含各段的 textSignature / reasoning）
// - model: 产出这条消息的模型标识（换模型后旧签名失效）
//
// 为什么存 rawContent 而不是单个 signature：
// 一个 assistant 回合可能是 [text, reasoning, text] 的混合序列，
// 每段各有自己的签名。只存"最后一段的签名"配"join 后的整段文本"
// 是钥匙和锁不配对——回传必然失配。
//
// 有效性不在写入时维护，而在**读取时校验**：
// 把 rawContent 里的文本抽出来与当前 content 比对，一致才回传。
// 这样宏替换 / 编辑 / 切变体都会自动失效，不依赖"记得在改动点清掉"。
//
// kind 字段（第 2 批）：
//   · kind === "illustration" 时，content 不存正文——插图没有“正文”。
//     而是用 { mediaId, prompt, status } 三件套存插图本体：
//       mediaId   指向媒体台账里那一条（图片字节在那里）
//       prompt    当初模型给的 [场景] 描述（不展开宏）
//       status    "pending" | "ok" | "failed"，failReason 只在 failed 时有值
//   · 旧消息（没有 kind 字段）默认按 TEXT 处理，行为与今天完全一致。
export function createMessage(role, content, overrides = {}) {
  const kind = overrides.kind == null ? null : String(overrides.kind);
  const isIllustration = kind === MessageKind.ILLUSTRATION;

  // 插图消息不存“正文”——它的实体在 mediaId 指向的那条台账。
  // 注意默认值只接 overrides.content 为**未传入**时的 content；
  // 如果调用方显式传了 content:null，那就是 null，不重新回推。
  const rawContent = overrides.content === undefined
    ? (isIllustration ? null : content)
    : overrides.content;

  const base = {
    id: crypto.randomUUID(),
    role,
    content: rawContent,
    timestamp: new Date().toISOString(),
    usage: null,
    rawContent: null,
    model: null,
    reasoning: null
  };

  // 只有 kind 存在时才写入——旧消息没有这个字段，不凭空造一个
  if (kind !== null) base.kind = kind;

  // 插图的三个伴随字段。只在 kind === "illustration" 时写入。
  if (isIllustration) {
    base.mediaId = overrides.mediaId == null ? null : String(overrides.mediaId);
    base.prompt = typeof overrides.prompt === "string" ? overrides.prompt : null;
    base.status = String(overrides.status || "pending");
    if (overrides.failReason) base.failReason = String(overrides.failReason);
  }

  // 只把有值的 overrides 铺上去，避免 undefined 把上面的默认值盖掉
  return {
    ...base,
    ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined))
  };
}

// 更新对话时间
export function touchConversation(conv) {
  conv.updatedAt = new Date().toISOString();
  return conv;
}
