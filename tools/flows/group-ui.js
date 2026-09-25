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
// ④b 0 消息时的“开场”：该显示**当前选中那位**的开场白。
// 默认选中任十九（探针自己造的卡，有 first_mes）→ 块应该在。
out["④b 开场块（选中任十九）"] = (document.querySelector(".scene-kicker")?.textContent || "(没有)").trim();
out["④b 开场正文"] = (document.querySelector(".scene-body")?.textContent || "(空)").trim().slice(0, 40);

// ⑤ 换个人说话
const chips = row ? [...row.querySelectorAll("[data-speaker]")] : [];
if (chips.length >= 2) {
  chips[1].click();
  await sleep(300);
  out["⑤ 换了之后高亮"] = row.querySelector(".speaker-chip.on")?.textContent.trim() || "";
}

// ⑤c 换人之后，开场块跟着换（薇拉的卡没写 first_mes → 宁可不显示，也不拿别人的顶）
out["⑤c 开场块（选中薇拉）"] = (document.querySelector(".scene-kicker")?.textContent || "(没有)").trim();

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

// ⑥.5 「发完自动轮换」开关：默认关 / 点一下开 / 存进 localStorage
// （按钮每次重画都会换成新元素，所以要点之前重新取）
const autoEl = () => document.getElementById("speaker-auto");
out["⑥b 自动按钮在不在"] = !!autoEl();
out["⑥b 默认"] = autoEl()?.classList.contains("on") ? "开" : "关";
out["⑥b aria-pressed"] = autoEl()?.getAttribute("aria-pressed") || "(无)";
autoEl()?.click();
await sleep(250);
out["⑥b 点一下"] = autoEl()?.classList.contains("on") ? "开" : "关";
out["⑥b localStorage"] = (() => { try { return String(localStorage.getItem("eleckoi:auto-rotate")); } catch { return "(读不到)"; } })();
out["⑥b 发完那一次没换人（默认关）"] = document.querySelector(".speaker-chip.on")?.textContent.trim() || "";

// ⑦ 开着「自动」再发一条：说话人应该真的轮到下一位
{
  // 先直接验那个新模块能不能加载——它是本轮新加的，最可疑。
  try {
    const sr = await import(new URL("./assets/modules/speaker-rotation.js", location.href).href);
    out["⑦ 新模块加载"] = `OK（nextSpeaker=${typeof sr.nextSpeaker}，participantsOf=${typeof sr.participantsOf}）`;
  } catch (e) {
    out["⑦ 新模块加载"] = `失败：${e.message}`;
  }

  const st = await import(new URL("./assets/modules/state.js", location.href).href);
  // 服务端到底在发哪一份 chat.js？——切一刀，不再猜。
  try {
    const src = await fetch(new URL("./assets/modules/chat.js", location.href).href).then((r) => r.text());
    out["⑦ 服务端 chat.js 字节数"] = src.length;
    out["⑦ 里面有 rotateSpeaker() 调用"] = (src.match(/rotateSpeaker\(\)/g) || []).length;
    out["⑦ 里面有没有那句重画注释"] = src.includes("界面撒谎比不轮换更坏") ? "有" : "没有";
  } catch (e) {
    out["⑦ 取 chat.js"] = e.message;
  }
  const before = document.querySelector(".speaker-chip.on")?.textContent.trim() || "";
  out["⑦ 发前 state.speakerId"] = st.state.speakerId || "(空)";
  out["⑦ 发前 localStorage"] = (() => { try { return String(localStorage.getItem("eleckoi:auto-rotate")); } catch { return "?"; } })();
  const ta2 = document.getElementById("chat-input");
  if (ta2) {
    ta2.value = "那你呢？";
    document.getElementById("send-btn")?.click();
    await sleep(6000);
  }
  const after = document.querySelector(".speaker-chip.on")?.textContent.trim() || "";
  out["⑦ 发完气泡数"] = document.querySelectorAll(".message").length;
  out["⑦ 发后 state.speakerId"] = st.state.speakerId || "(空)";
  out["⑦ 自动开：发前→发后"] = `${before} → ${after}`;
  out["⑦ 轮换了吗"] = before && after && before !== after ? "换了" : "没换（这条该红了）";
  autoEl()?.click();
  await sleep(150);
  out["⑦ 关回去"] = autoEl()?.classList.contains("on") ? "开" : "关";
}
out["⑧ 顶栏标题"] = document.getElementById("chat-title")?.textContent || "";

return out;
