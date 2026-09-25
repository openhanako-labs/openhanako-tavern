// tools/flows/group-ui.js —— 群聊界面那一半：建群 / 发言者行 / 气泡署名
//
// 数据写在临时宿主副本上（%TEMP%\eleckoi-ui-host-data，每次启动重拷），
// 碰不到真数据。这里会顺手造第二张角色卡——上一程就是卡在"只有一张卡"。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (p, opt) => fetch(`/__api/${p}`, opt).then((r) => r.json());
const post = (p, body) =>
  api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const out = {};

// ① 造第二张卡（如果没有）
let chars = (await api("characters"))?.data || [];
out["① 原本角色数"] = chars.length;
if (chars.length < 2) {
  const made = await post("characters", {
    name: "任十九",
    description: "山下杂货铺的老板娘，什么都听得到",
    first_mes: "「山上的风变了。」"
  });
  out["① 造卡回话"] = JSON.stringify(made?.data || made).slice(0, 90);
}
chars = (await api("characters"))?.data || [];
out["① 现在有谁"] = chars.map((c) => c.name).join(" / ");

// ② 让界面重新拉一次角色列表（charNameOf 要靠 state.charList 解名字）
const charactersMod = await import(new URL("./assets/modules/characters.js", location.href).href);
await charactersMod.loadCharacters();
await sleep(400);

// ③ 建一场群聊（第一个是主角）
const created = await post("conversations", {
  characterId: chars[0].id,
  characterIds: [chars[0].id, chars[1].id],
  greeting: false
});
const conv = created?.data || created;
out["③ 群聊 characterIds"] = JSON.stringify(conv?.characterIds);

// ④ 打开它
const chat = await import(new URL("./assets/modules/chat.js", location.href).href);
await chat.openConversation(conv.id);
await sleep(900);

const row = document.getElementById("speaker-row");
out["④ 发言者行可见"] = !!row && !row.classList.contains("hidden");
out["④ 行里有几个"] = row ? row.querySelectorAll("[data-speaker]").length : 0;
out["④ 都是谁"] = row ? [...row.querySelectorAll("[data-speaker]")].map((b) => b.textContent.trim()).join(" / ") : "";
out["④ 默认高亮"] = row?.querySelector(".speaker-chip.on")?.textContent.trim() || "";

// ⑤ 换个人说话
const chips = row ? [...row.querySelectorAll("[data-speaker]")] : [];
if (chips.length >= 2) {
  chips[1].click();
  await sleep(300);
  out["⑤ 换了之后高亮"] = row.querySelector(".speaker-chip.on")?.textContent.trim() || "";
}

// ⑥ 发一条，看回复署谁的名
const ta = document.getElementById("chat-input");
if (ta) {
  ta.value = "你们两个都在？";
  const sendBtn = document.getElementById("send-btn");
  sendBtn?.click();
  await sleep(6000);
}
const msgs = [...document.querySelectorAll(".message")];
out["⑥ 气泡数"] = msgs.length;
out["⑥ 各气泡的署名"] = msgs.map((m) => {
  const sp = m.querySelector(".msg-speaker")?.textContent.trim();
  return `${m.classList.contains("assistant") ? "角色" : "我"}${sp ? `(${sp})` : ""}`;
}).join(" | ");
out["⑥ 最后一条正文"] = (msgs[msgs.length - 1]?.querySelector(".bubble")?.innerText || "").slice(0, 60);
out["⑦ 顶栏标题"] = document.getElementById("chat-title")?.textContent || "";

return out;
