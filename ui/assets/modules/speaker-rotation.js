// ui/assets/modules/speaker-rotation.js — 群聊发言顺序（纯逻辑，不碰 DOM）
//
// 为什么单独一个文件：这段是唯一能在 Node 里测的部分。
// chat.js 那份要 document / localStorage，测不了；而"轮到谁"本身是纯的，
// 抽出来就能被钉住——包括那条最容易错的生产约定：
// **旧对话文件里只有 characterId，读侧必须能兜**。

/**
 * 这一场的参与者 id 列表。
 *
 * ⚠️ 必须与 lib/conversations/model.js 的 participantsOf 保持同一条读法：
 * 老对话文件只有 characterId（单角色），新的是 characterIds。
 * 两边分叉的后果是"界面上少了一个人，而 prompt 里有"——最难查的那种。
 */
export function participantsOf(conv) {
  if (Array.isArray(conv?.characterIds) && conv.characterIds.length > 0) {
    return conv.characterIds;
  }
  return conv?.characterId ? [conv.characterId] : [];
}

/**
 * 下一位发言者。绕回开头，未知的当前值落到第一位。
 *
 * 单人（<2）由调用方处理：这里只负责"轮"。
 */
export function nextSpeaker(ids, current) {
  if (!Array.isArray(ids) || ids.length === 0) return null;
  const i = ids.indexOf(current);
  if (i < 0) return ids[0];
  return ids[(i + 1) % ids.length];
}
