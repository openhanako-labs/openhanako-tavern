// tools/flows/panels-b.js —— 试三个面板的**主要动作**，不只看内容
//
// 为什么这一趟非做不可：今天六个 bug 里有一半是「看着有、点下去接的是别的线」
// （测试替换读孤儿框、工具面板打错路径、删消息打不存在的路由）。
// 光看内容永远看不出来——**得按下去，再回头核对状态**。
//
// 做法：不猜按钮 id。点「新建」，然后找可见的保存按钮、点它，
// 最后用 API 核对后端状态。找不到就把可见按钮列出来（下一次就知道叫什么了）。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = document.createElement("style");
st.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
document.head.appendChild(st);

window.__errs = window.__errs || [];
window.addEventListener("error", (e) => window.__errs.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) =>
  window.__errs.push("unhandled: " + String((e.reason && e.reason.message) || e.reason)));

await sleep(900);

const CONV = "e952e1c7-f779-49f3-ae75-c84daf4269b3";
const chat = await import(new URL("./assets/modules/chat.js", location.href).href);
const shell = await import(new URL("./assets/modules/shell.js", location.href).href);
await chat.openConversation(CONV);
await sleep(600);

const visible = (el) => !!(el && el.offsetParent !== null);
// 后端响应形状不猜：直接把信封拆到能用的那层，拆不动就把它长什么样报回去。
const apiRaw = async (p) => await (await fetch("/__api/" + p)).json();
const listOf = (raw, key) => {
  const d = raw?.data ?? raw;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.[key])) return d[key];
  if (Array.isArray(d?.items)) return d.items;
  return null;
};
// 黑板格分「世界级」与「本场」两栏（data.world / data.chat）——
// 我第一次按 data.cells 找，于是把一个 3 格的列表读成了 0 格。
const boardCells = (raw) => [...(raw?.data?.world || []), ...(raw?.data?.chat || [])];

/** 页面上所有可见按钮的文字（找不到保存键时用来学词）。 */
const visibleButtons = () =>
  [...document.querySelectorAll("button")]
    .filter(visible)
    .map((b) => `${b.id || b.className}:${(b.textContent || "").trim().slice(0, 12)}`)
    .slice(-18);

/** 点第一个文字匹配的可见按钮；找不到返回 null。 */
function clickByText(res) {
  for (const b of document.querySelectorAll("button")) {
    if (!visible(b)) continue;
    const t = (b.textContent || "").trim();
    if (res.some((r) => t === r || t.includes(r))) { b.click(); return t; }
  }
  return null;
}

const out = {};

// ── 世界：新建 → 核对 → 编辑 → 核对 → 删除 → 核对 ──────────
shell.openDrawer("board");
await sleep(700);

const beforeRaw = await apiRaw(`board/cells?conversationId=${CONV}`);
const before = boardCells(beforeRaw);
out["世界·接口形状"] = `世界级 ${(beforeRaw?.data?.world || []).length} + 本场 ${(beforeRaw?.data?.chat || []).length}`;
document.getElementById("create-board-cell-btn")?.click();
await sleep(500);

const form = document.getElementById("board-form");
out["世界·表单出现了吗"] = visible(form);
if (visible(form)) {
  document.getElementById("bc-title").value = "探针格：月台尽头";
  document.getElementById("bc-body").value = "站台的灯忽明忽暗，风里有铁锈味。";
  const clicked = clickByText(["保存", "确定", "创建", "添加"]);
  out["世界·点了哪个按钮"] = clicked;
  if (!clicked) out["世界·可见按钮"] = visibleButtons();
  await sleep(900);

  const afterRaw = await apiRaw(`board/cells?conversationId=${CONV}`);
  const after = boardCells(afterRaw);
  out["世界·新建后格数"] = `${before.length} → ${after.length}`;
  const mine = after.find((c) => c.title === "探针格：月台尽头");
  out["世界·找到新建的格"] = !!mine;
  out["世界·它的字段"] = mine ? { lifespan: mine.lifespan, activation: mine.activation, visible: mine.visible } : null;

  // 删除它（把演示数据收干净）
  if (mine) {
    const card = [...document.querySelectorAll(".board-cell")].find((c) => (c.innerText || "").includes("探针格"));
    const del = card && [...card.querySelectorAll("button")].find((b) => (b.textContent || "").includes("删除"));
    del?.click();
    await sleep(700);
    // 可能的确认弹窗
    clickByText(["确定", "确认", "删除"]);
    await sleep(700);
    const after2 = boardCells(await apiRaw(`board/cells?conversationId=${CONV}`));
    out["世界·删除后格数"] = after2.length;
  }
} else {
  out["世界·可见按钮"] = visibleButtons();
}

// ── 设定库：新建（先故意漏必填，看它是否如实拒绝） ─────────
shell.openDrawer("settings");
await sleep(700);

const sBefore = listOf(await apiRaw("settings"), "settings") || [];
document.getElementById("create-setting-btn")?.click();
await sleep(500);

const sForm = document.getElementById("setting-form");
out["设定库·表单出现了吗"] = visible(sForm);
if (visible(sForm)) {
  // 1) 漏掉必填的「内容」，点保存 —— 期望被拒（不是静默没事发生）
  document.getElementById("sf-name").value = "探针设定";
  document.getElementById("sf-content").value = "";
  const c1 = clickByText(["保存", "确定", "创建"]);
  await sleep(700);
  const sMid = listOf(await apiRaw("settings"), "settings") || [];
  out["设定库·漏必填时点的是"] = c1;
  out["设定库·漏必填被拒了吗"] = sMid.length === sBefore.length;
  out["设定库·拒绝的理由（toast）"] = [...document.querySelectorAll(".toast, .toast-line")]
    .map((t) => t.textContent.trim().slice(0, 60)).slice(0, 2);

  // 2) 补齐再存
  document.getElementById("sf-content").value = "探针用：内容是这条设定的主体。";
  document.getElementById("sf-keywords").value = "探针, 月台";
  const c2 = clickByText(["保存", "确定", "创建"]);
  await sleep(900);
  const sAfter = listOf(await apiRaw("settings"), "settings") || [];
  out["设定库·保存后条数"] = `${sBefore.length} → ${sAfter.length}`;
  // 名字字段不猜：整条 JSON 里含「探针」就算找到（第一次按 s.name 找，没找到）
  const mine = sAfter.find((s) => JSON.stringify(s).includes("探针"));
  out["设定库·找到新建的"] = !!mine;
  out["设定库·它的字段名"] = mine ? Object.keys(mine).join(",") : null;
  out["设定库·它的触发词"] = mine ? (mine.keywords ?? mine.keys ?? null) : null;

  // 收干净
  if (mine) {
    const del = await fetch(`/__api/settings/${mine.id}`, { method: "DELETE" });
    out["设定库·清理"] = del.status;
    const left = listOf(await apiRaw("settings"), "settings") || [];
    out["设定库·清理后条数"] = left.length;
  }
} else {
  out["设定库·可见按钮"] = visibleButtons();
}

out["页面报错"] = (window.__errs || []).slice(0, 5);
return out;
