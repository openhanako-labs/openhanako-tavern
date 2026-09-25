// tools/flows/probe-speaker.js —— 发言者行没出现：是"元素不在"还是"没渲染"？
//
// 上一版探针只问 `!classList.contains("hidden")`，两种可能都回 false——
// 那等于没问。（"目标不存在"和"我在找错东西"必须分开验。）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (p, opt) => fetch(`/__api/${p}`, opt).then((r) => r.json());
const post = (p, body) => api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const out = {};

// ① 元素本身在不在（HTML 里写没写）
const row = document.getElementById("speaker-row");
out["① #speaker-row 在吗"] = !!row;
out["① 它的 class"] = row ? row.className : "(元素都没有)";
out["① 它在哪个容器里"] = row?.parentElement?.id || row?.parentElement?.className || "-";

// ② 页面里所有 id 里带 speaker 的
out["② HTML 里带 speaker 的 id"] = [...document.querySelectorAll("[id*='speaker']")].map((e) => e.id).join(",") || "(一个都没有)";

// ③ 模块导出了吗
const chat = await import(new URL("./assets/modules/chat.js", location.href).href);
out["③ chat.js 导出了 renderSpeakerRow 吗"] = typeof chat.renderSpeakerRow;

// ④ 开一场群聊再看
// 临时宿主每次启动重拷数据 → 每次跑都得自己造第二张卡。
let chars = (await api("characters"))?.data || [];
if (chars.length < 2) {
  await post("characters", {
    name: "任十九",
    description: "山下杂货铺的老板娘，什么都听得到",
    first_mes: "「山上的风变了。」"
  });
  chars = (await api("characters"))?.data || [];
}
out["④ 角色数"] = chars.length;
out["④ 都是谁"] = chars.map((c) => c.name).join(" / ");
if (chars.length >= 2) {
  const created = await api("conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ characterId: chars[0].id, characterIds: [chars[0].id, chars[1].id], greeting: false })
  });
  const conv = created?.data || created;
  const chatMod2 = await import(new URL("./assets/modules/characters.js", location.href).href);
  await chatMod2.loadCharacters();   // 让 charNameOf 有名字可解
  await sleep(300);
  await chat.openConversation(conv.id);
  await sleep(1000);

  out["⑤ 开完对话后 row 的 class"] = document.getElementById("speaker-row")?.className;
  out["⑤ 开完对话后 chip 数"] = document.querySelectorAll("#speaker-row [data-speaker]").length;

  const st = await import(new URL("./assets/modules/state.js", location.href).href);
  out["⑤ state.currentConv 的 characterIds"] = JSON.stringify(st.state.currentConv?.characterIds);
  out["⑤ state.currentConv 的 characterId"] = String(st.state.currentConv?.characterId).slice(0, 8);
  out["⑤ state.charList 里有几个"] = (st.state.charList || []).length;

  // 手动调一次，看它是抛错还是正常（直接看它写完 DOM 的样子）
  let manual = "没抛错";
  try { chat.renderSpeakerRow(); } catch (e) { manual = "抛错: " + e.message; }
  out["⑥ 手动调 renderSpeakerRow"] = manual;
  out["⑥ 调用后 class"] = document.getElementById("speaker-row")?.className;
  out["⑥ 调用后 chip 数"] = document.querySelectorAll("#speaker-row [data-speaker]").length;
}

return out;
