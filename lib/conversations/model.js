// lib/conversations/model.js — 对话数据模型

import crypto from "node:crypto";

export const MessageRole = {
  USER: "user",
  ASSISTANT: "assistant",
  SYSTEM: "system"
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
    ...overrides
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
export function createMessage(role, content, overrides = {}) {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    timestamp: new Date().toISOString(),
    usage: null,
    rawContent: null,
    model: null,
    reasoning: null,
    ...overrides
  };
}

// 更新对话时间
export function touchConversation(conv) {
  conv.updatedAt = new Date().toISOString();
  return conv;
}
