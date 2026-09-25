// tools/flows/cast-edit.js —— 同场角色：在界面上真的加人、减人
//
// 这条路的意义：参与者过去只能建对话时定。现在能改了——
// 但"能改"必须证明在**界面上**能改，不能只看服务端测试绿。
// 服务端严格（主角不在名单里就报错），界面负责替他把话说完；
// 两边都要在这条探针里走一遍。
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
const charactersMod = await import(new URL("./assets/modules/characters.js", location.href).href);
await charactersMod.loadCharacters();
await sleep(400);
out["① 有谁"] = chars.map((c) => c.name).join(" / ");

// ② 先建一场**单人**对话
const chat = await import(new URL("./assets/modules/chat.js", location.href).href);
const shell = await import(new URL("./assets/modules/shell.js", location.href).href);
const stateMod = await import(new URL("./assets/modules/state.js", location.href).href);
const state = stateMod.state;

const created = await post("conversations", { characterId: chars[0].id, greeting: false });
const convId = (created?.data || created)?.id;
await chat.openConversation(convId);
await sleep(700);
out["② 初始名单"] = (state.currentConv?.characterIds || []).join(",") === chars[0].id ? "单人 ✓" : `意外：${JSON.stringify(state.currentConv?.characterIds)}`;
out["② 发言者行"] = (() => {
  const row = document.getElementById("speaker-row");
  return row && !row.classList.contains("hidden") ? "显示" : "隐藏（单人该隐藏 ✓）";
})();

// ③ 打开角色面板，看有没有名单编辑器
await shell.openDrawer("character");
await sleep(400);
const sel = document.getElementById("ctx-cast-select");
out["③ 面板里有名单编辑器"] = !!sel;
out["③ 可选项数 / 当前选中数"] = sel
  ? `${sel.options.length} / ${sel.selectedOptions.length}`
  : "(没有)";
out["③ 面板里显示的名单"] = (document.querySelector(".ctx-cast-now")?.textContent || "(空)").trim();

// ④ 勾上第二个人，保存 → 应该变成群聊
if (sel) {
  const opt = [...sel.options].find((o) => o.value === chars[1].id);
  if (opt) opt.selected = true;
  document.getElementById("ctx-cast-save")?.click();
  await sleep(1200);
}
out["④ 保存后名单"] = (state.currentConv?.characterIds || []).join(" / ") === chars.map((c) => c.id).join(" / ")
  ? "两位 ✓"
  : JSON.stringify(state.currentConv?.characterIds);
out["④ 发言者行"] = (() => {
  const row = document.getElementById("speaker-row");
  return row && !row.classList.contains("hidden")
    ? `显示：${[...row.querySelectorAll("[data-speaker]")].map((b) => b.textContent.trim()).join("/")}`
    : "隐藏（群聊该显示 ✗）";
})();
out["④ 面板名单"] = (document.querySelector(".ctx-cast-now")?.textContent || "(空)").trim();

// ⑤ 只留主角一位，保存 → 应该变回单人
const sel2 = document.getElementById("ctx-cast-select");
if (sel2) {
  [...sel2.options].forEach((o) => { o.selected = o.value === chars[0].id; });
  document.getElementById("ctx-cast-save")?.click();
  await sleep(1200);
}
out["⑤ 保存后名单"] = (state.currentConv?.characterIds || []).join(",") === chars[0].id
  ? "变回单人 ✓"
  : JSON.stringify(state.currentConv?.characterIds);
out["⑤ 发言者行"] = (() => {
  const row = document.getElementById("speaker-row");
  return row && !row.classList.contains("hidden") ? "显示（单人该隐藏 ✗）" : "隐藏 ✓";
})();

return out;
