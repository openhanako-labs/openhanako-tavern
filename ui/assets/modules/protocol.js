// protocol.js — 卡片自带变量协议块的抽取（纯函数，Node 可测）
//
// 有卡片在提示词里自带酒馆脚本系的变量协议，教模型输出
// <UpdateVariable>/<Analysis>/<JSONPatch>——夜航船不解析这套协议，
// 标签会裸奔在正文里。这里负责把块从正文里整段抽出：
//   · 闭合块整块抽；没写闭合标签（流式截断/模型忘写）折到结尾
//   · 多块依次抽出、顺序保持
// 抽出的内容不丢——渲染层折成 <details>（见 chat.js 的 renderProtoDetails）。
// 是否真按 patch 应用变量（兼容酒馆脚本协议）是另议的产品决定。

export const PROTO_RE = /<UpdateVariable>([\s\S]*?)(?:<\/UpdateVariable>|$)/gi;

export function extractProtocolBlocks(content) {
  const blocks = [];
  const text = String(content ?? "").replace(PROTO_RE, (_, inner) => {
    blocks.push(inner.trim());
    return "";
  });
  return { text, blocks };
}
