// tools/flows/whisper.js —— 私语：在界面上真开、真选、真发
//
// 服务端测试能证明"过滤对了"，但证明不了界面把 audience 真带上了——
// 那正是最容易断的地方（两条发送路径各写一份 body）。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (p, opt) => fetch(`/__api/${p}`, opt).then((r) => r.json());
const post = (p, body) =>
  api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const out = {};

let chars = (await api("characters"))?.data || [];
if (chars.length < 2) {
  await post("characters", { name: "任十九", description: "山下杂货铺的老板娘", first_mes: "「山上的风变了。」" });
  chars = (await api("characters"))?.data || [];
}
const charactersMod = await import(new URL("./assets/modules/characters.js", location.href).href);
await charactersMod.loadCharacters();
await sleep(400);

const chat = await import(new URL("./assets/modules/chat.js", location.href).href);

// ── 群聊 ──
const created = await post("conversations", {
  characterId: chars[0].id,
  characterIds: [chars[0].id, chars[1].id],
  greeting: false
});
const convId = (created?.data || created).id;
await chat.openConversation(convId);
await sleep(700);

const wr = () => document.getElementById("whisper-row");
out["① 私语行在不在"] = !!wr();
out["① 群聊里可见吗"] = wr() && !wr().classList.contains("hidden") ? "可见 ✓" : "隐藏 ✗";
out["① 没开时的提示"] = (wr()?.querySelector(".whisper-note")?.textContent || "(无)").trim();
out["① 没开时目标数"] = document.querySelectorAll("[data-whisper]").length;

// ── 打开私语 ──
document.getElementById("whisper-toggle")?.click();
await sleep(300);
out["② 打开后目标数"] = document.querySelectorAll("[data-whisper]").length;
out["② 默认选中"] = [...document.querySelectorAll("[data-whisper].on")].map((b) => b.textContent.trim()).join("/");
out["② aria-pressed"] = document.getElementById("whisper-toggle")?.getAttribute("aria-pressed");

// ── 点掉一个，只留给第二个人 ──
[...document.querySelectorAll("[data-whisper]")][0]?.click();
await sleep(250);
out["③ 点掉一个之后"] = [...document.querySelectorAll("[data-whisper].on")].map((b) => b.textContent.trim()).join("/");

// ── 发一条，看落盘里有没有 audience ──
const ta = document.getElementById("chat-input");
if (ta) {
  ta.value = "只跟你说一句。";
  document.getElementById("send-btn")?.click();
  await sleep(6500);
}
const fresh = await api(`conversations/${convId}`);
const msgs = (fresh?.data || fresh)?.messages || [];
const mine = msgs.find((m) => typeof m.content === "string" && m.content.includes("只跟你说一句"));
out["④ 落盘的 audience"] = mine ? JSON.stringify(mine.audience) : "(没找到这条)";
out["④ 气泡上的标记"] = [...document.querySelectorAll(".whisper-badge")].map((b) => b.textContent.trim()).join(" | ") || "(没有)";
out["④ 发完复位了吗"] = document.querySelector(".whisper-toggle")?.classList.contains("on") ? "还开着 ✗" : "复位了 ✓";

// ── 单人对话：整行不该出现 ──
const solo = await post("conversations", { characterId: chars[0].id, greeting: false });
await chat.openConversation((solo?.data || solo).id);
await sleep(600);
out["⑤ 单人时这一行"] = wr()?.classList.contains("hidden") ? "隐藏 ✓" : "还显示着 ✗";

return out;
