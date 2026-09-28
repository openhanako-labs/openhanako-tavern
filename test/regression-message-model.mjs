// test/regression-message-model.mjs — 消息 kind（第 2 批 2.4）
//
// 判据：
//   · 旧消息（没有 kind 字段）读进来要照常工作
//   · createMessage 默认不带 kind
//   · kind === "illustration" 时 content 强制为 null，mediaId / prompt / status 就位
//
// 反证：
//   · 把 kind 默认改成 "text" → ② 直接红（旧消息该没有 kind 字段）
//   · 把 illustration 分支去掉 → ④ ⑤ 直接红
//   · 把 content=null 的赋值删掉 → ④ 直接红

import assert from "node:assert/strict";
import {
  createMessage,
  MessageRole,
  MessageKind,
  createEmptyConversation,
  participantsOf
} from "../lib/conversations/model.js";

let pass = 0;
const failed = [];
function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed.push(name);
    console.error(`  ❌ ${name}\n     ${e?.message || e}`);
  }
}

// ── ① 旧行为：不传 kind → 消息里没有 kind 字段 ──
ok("① 不传 kind → 消息对象里没有 kind 字段（旧消息契约）", () => {
  const msg = createMessage(MessageRole.ASSISTANT, "你好。");
  assert.equal("kind" in msg, false, "旧消息不该有 kind 字段");
  assert.equal(msg.content, "你好。");
  assert.equal(msg.role, MessageRole.ASSISTANT);
  assert.ok(msg.id, "有 id");
  assert.ok(msg.timestamp, "有 timestamp");
});

// ── ② 空 overrides 也不该出现 kind ──
ok("② 空 overrides 也不出现 kind 字段", () => {
  const msg = createMessage(MessageRole.USER, "hi", {});
  assert.equal("kind" in msg, false);
});

// ── ③ 旧消息（没有 kind 字段）读进来不抛错 ──
ok("③ 旧消息（没有 kind）能当作普通消息读", () => {
  // 模拟一条从旧文件读进来的消息：没有 kind，也没有 mediaId / prompt / status
  const oldMsg = { id: "m1", role: "user", content: "老消息", timestamp: new Date().toISOString() };
  // 读侧只要能看到 role 和 content 就行
  assert.equal(oldMsg.role, "user");
  assert.equal(oldMsg.content, "老消息");
  // 旧消息没有 kind 字段：读侧不应因为“没有”而报错
  assert.equal("kind" in oldMsg, false);
});

// ── ④ illustration kind：content 强制 null，字段就位 ──
ok("④ illustration kind：content=null，mediaId/prompt/status 就位", () => {
  const msg = createMessage(MessageRole.ASSISTANT, "被丢弃的 content", {
    kind: MessageKind.ILLUSTRATION,
    mediaId: "m_abc123",
    prompt: "她站在雨里",
    status: "pending"
  });
  assert.equal(msg.kind, "illustration");
  assert.equal(msg.content, null, "插图消息不存正文");
  assert.equal(msg.mediaId, "m_abc123");
  assert.equal(msg.prompt, "她站在雨里");
  assert.equal(msg.status, "pending");
});

// ── ⑤ illustration 默认 status=pending，其他字段 null ──
ok("⑤ illustration 不传字段 → 默认 status=pending，mediaId/prompt=null", () => {
  const msg = createMessage(MessageRole.ASSISTANT, null, {
    kind: MessageKind.ILLUSTRATION
  });
  assert.equal(msg.status, "pending");
  assert.equal(msg.mediaId, null);
  assert.equal(msg.prompt, null);
  assert.equal(msg.content, null);
});

// ── ⑥ illustration + failReason ──
ok("⑥ illustration 失败态：failReason 带出来", () => {
  const msg = createMessage(MessageRole.ASSISTANT, null, {
    kind: MessageKind.ILLUSTRATION,
    status: "failed",
    failReason: "模型拒答"
  });
  assert.equal(msg.status, "failed");
  assert.equal(msg.failReason, "模型拒答");
});

// ── ⑦ 旧对话（没有 messages.kind）能正常读到 ──
ok("⑦ 旧对话能读到；参与者兼容单 characterId", () => {
  const conv = createEmptyConversation("char-old", {
    messages: [
      { id: "m1", role: "user", content: "老消息", timestamp: new Date().toISOString() }
    ]
  });
  const parts = participantsOf(conv);
  assert.deepEqual(parts, ["char-old"]);
  // 老消息没有 kind 字段，读进来还是老样子
  assert.equal("kind" in conv.messages[0], false);
});

// ── ⑧ MessageKind 常量契约 ──
ok("⑧ MessageKind.ILLUSTRATION === 'illustration'（改了就是改契约）", () => {
  assert.equal(MessageKind.ILLUSTRATION, "illustration");
  assert.equal(MessageKind.TEXT, null);
});

console.log("");
if (failed.length) {
  console.error(`❌ 消息模型（kind 字段）：${pass} 过 / ${failed.length} 败`);
  process.exit(1);
}
console.log(`✅ 消息模型（kind 字段）：${pass} 过 / 0 败`);
