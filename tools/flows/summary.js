// tools/flows/summary.js —— 前情提要在界面上有没有家：读得到 / 改得了
//
// 数据写在**临时宿主**的副本上（%TEMP%\eleckoi-ui-host-data，每次启动重拷），
// 碰不到真数据。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONV = "e952e1c7-f779-49f3-ae75-c84daf4269b3";
const api = (p, opt) => fetch(`/__api/${p}`, opt).then((r) => r.json());

const out = {};

// ① 先写入一份摘要（探针写的）
const put = await api(`conversations/${CONV}/summary`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: "（探针写的）她在塔顶守了三夜，霜花结在袖口上。" })
});
out["① 写入回话"] = JSON.stringify(put).slice(0, 120);

// ② 开对话 → 开角色面板（面板会渲染 state.currentConv）
const chat = await import(new URL("./assets/modules/chat.js", location.href).href);
await chat.openConversation(CONV);
await sleep(900);
// 开对话时角色面板常常已经自己站出来了；那一下再 openDrawer 是**开关**，反而会关掉它。
if (!document.querySelector("main")?.classList.contains("ctx-open")) {
  const shell = await import(new URL("./assets/modules/shell.js", location.href).href);
  await shell.openDrawer("character");
  await sleep(900);
}
out["② 右栏开着吗"] = !!document.querySelector("main")?.classList.contains("ctx-open");

// ③ 那个块在不在、写着什么
const box = document.getElementById("char-ctx-body");
out["② 块在"] = !!box?.querySelector(".ctx-summary");
out["② 标题行"] = box?.querySelector(".ctx-summary-head")?.innerText.replace(/\s+/g, " ");
const ta = box?.querySelector("#ctx-summary-text");
out["② 是输入框（能改）"] = !!ta;
out["② 框里文字"] = (ta?.value || "").slice(0, 60);
out["② 有保存按钮"] = !!box?.querySelector("#ctx-summary-save");
out["② 有清掉按钮"] = !!box?.querySelector("#ctx-summary-clear");

// ④ 改一改、点保存，再从接口核一遍（不是看界面说成功就算）
if (ta) {
  ta.value = "（界面上改的）她把霜从袖口抖下去，说冷是给活着的人准备的。";
  box.querySelector("#ctx-summary-save")?.click();
  await sleep(1200);
  const read = await api(`conversations/${CONV}/summary`);
  out["③ 接口里现在是什么"] = String(read?.data?.summary?.text ?? read?.summary?.text ?? "").slice(0, 70);
  out["③ 覆盖范围保住了吗"] = String(
    (read?.data?.summary || read?.summary || {}).coveredCount
  );
}

// ⑤ 留着面板给人看
return out;
