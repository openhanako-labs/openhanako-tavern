// tools/flows/group-openers.js —— 群聊开场白：建一场**带开场**的群聊，看真落成什么样
//
// 为什么单独一条：group-ui 那条流全程用 `greeting:false` 建对话，
// 所以「每位参与者各说一句」这条新路**在界面上从没被跑过**。
// 服务端测试过了（regression-group 13 条），但那只能证明库里写对了——
// 界面上到底怎么画出这几条、每条有没有署名，只有这里能回答。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (p, opt) => fetch(`/__api/${p}`, opt).then((r) => r.json());
const post = (p, body) =>
  api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const out = {};

// ① 两张卡
let chars = (await api("characters"))?.data || [];
if (chars.length < 2) {
  await post("characters", {
    name: "任十九",
    description: "山下杂货铺的老板娘，什么都听得到",
    first_mes: "「山上的风变了。」"
  });
  chars = (await api("characters"))?.data || [];
}
out["① 有谁"] = chars.map((c) => c.name).join(" / ");

// ①b 让界面重拉一次角色列表。
// 不拉的话 charNameOf 找不到刚造的卡，署名会显示“（角色已删除）”——
// 那是探针的错，不是产品的错（group-ui 里就有这一步，我这边漏了）。
const charactersMod = await import(new URL("./assets/modules/characters.js", location.href).href);
await charactersMod.loadCharacters();
await sleep(400);

// ② 建一场**带开场**的群聊（不传 greeting:false —— 默认就是带）
const created = await post("conversations", {
  characterId: chars[0].id,
  characterIds: [chars[0].id, chars[1].id]
});
const conv = created?.data || created;
const msgs = conv?.messages || [];
out["② 落盘几条"] = msgs.length;
out["② 每条的角色/署名"] = msgs
  .map((m) => `${m.role}${m.speakerId ? "·有署名" : "·无署名"}`)
  .join(" | ");
out["② 署名对得上名册吗"] = msgs
  .map((m) => `${(m.content || "").slice(0, 14)}→${m.speakerId ? (chars.find((c) => c.id === m.speakerId)?.name || "?") : "(无)"}`)
  .join(" ／ ");

// ③ 打开它，看界面画成什么样
const chat = await import(new URL("./assets/modules/chat.js", location.href).href);
await chat.openConversation(conv.id);
await sleep(900);

const bubbles = [...document.querySelectorAll(".message")];
out["③ 气泡数"] = bubbles.length;
out["③ 各气泡署名"] = bubbles
  .map((m) => m.querySelector(".msg-speaker")?.textContent.trim() || "(无)")
  .join(" | ");
out["③ 开场块还在吗"] = document.querySelector(".scene-kicker")
  ? "在（说明被当成 0 消息了 ✗）"
  : "不在 ✓";
out["③ 发言者行"] = (() => {
  const row = document.getElementById("speaker-row");
  return row && !row.classList.contains("hidden")
    ? [...row.querySelectorAll("[data-speaker]")].map((b) => b.textContent.trim()).join("/")
    : "(隐藏)";
})();

return out;
