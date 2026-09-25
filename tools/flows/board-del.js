// tools/flows/board-del.js —— 黑板格的「删除」为什么不生效
//
// 上一步：新建存进去了（3→4），但点卡片上的「删除」之后还是 4 格。
// 分两步问清楚：**路由有没有**、**界面接没接**。两件事要分开看——
// 混在一起就只能说"删除不工作"，而那句话对修它没有帮助。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = document.createElement("style");
st.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
document.head.appendChild(st);
window.__errs = window.__errs || [];
window.addEventListener("error", (e) => window.__errs.push(String(e.message)));

await sleep(900);

const CONV = "e952e1c7-f779-49f3-ae75-c84daf4269b3";
const chat = await import(new URL("./assets/modules/chat.js", location.href).href);
const shell = await import(new URL("./assets/modules/shell.js", location.href).href);
await chat.openConversation(CONV);
await sleep(600);

const cellsOf = async () => {
  const raw = await (await fetch(`/__api/board/cells?conversationId=${CONV}`)).json();
  return [...(raw?.data?.world || []), ...(raw?.data?.chat || [])];
};

const out = {};
const before = await cellsOf();
out["起始格数"] = before.length;
const victim = before[0];
if (!victim) { out["没有格子可删"] = true; return out; }
out["准备删"] = { id: victim.id, title: victim.title };

// ── ① 路由层：直接打 DELETE，看它存不存在 ────────────────
// conversationId **必须带**：本场的格子存在对话文件里，不带它就只在世界库里找。
//（界面是带的——见 board.js 的 deleteBoardCell）
const r = await fetch(`/__api/board/cells/${victim.id}?conversationId=${encodeURIComponent(CONV)}`, { method: "DELETE" });
out["① DELETE 路由状态"] = r.status;
out["① 响应体"] = (await r.text()).slice(0, 160);
out["① 删后格数"] = (await cellsOf()).length;

// ── ② 界面层：重新打开抽屉，点卡片上的「删除」 ────────────
// 注：① 已经把刚才那一格删了，所以这里要**重新取一个**。
//（上一版就死在这里：拿已经删掉的标题去找卡片，当然找不到。）
const remaining = await cellsOf();
out["② 剩余格数"] = remaining.length;
const target2 = remaining[0];
out["② 准备删"] = target2 ? { id: target2.id, title: target2.title } : null;

shell.openDrawer("board");
await sleep(700);
const card = target2 && [...document.querySelectorAll(".board-cell")]
  .find((c) => (c.innerText || "").includes(String(target2.title).slice(0, 6)));
out["② 找到卡片"] = !!card;
if (card) {
  const btn = [...card.querySelectorAll("button")].find((b) => (b.textContent || "").includes("删除"));
  out["② 卡片上有删除键"] = !!btn;
  const visibleModals = () => [...document.querySelectorAll(".modal")]
    .filter((m) => getComputedStyle(m).display !== "none")
    .map((m) => m.id || m.className);

  // 重新查一次再点。
  // 抽屉打开时 loadBoard 是异步的，上一步拿到的节点可能已经被重渲染换掉了——
  // 在旧节点上 click 不会触发任何东西，看上去就像「按钮是死的」。
  const freshCard = () => [...document.querySelectorAll(".board-cell")]
    .find((c) => (c.innerText || "").includes(String(target2.title).slice(0, 6)));
  out["② 点前重新找到吗"] = !!freshCard();
  const btnFresh = freshCard()?.querySelector('[data-act="delete"]');
  out["② 拿到的是删除键吗"] = btnFresh ? btnFresh.textContent.trim() : null;
  btnFresh?.click();
  await sleep(600);
  // 确认框是**自定义遮罩**（core.js 的 confirmDialog：iframe 沙箱挡掉了 window.confirm）。
  // 注意选择器：内联样式会被序列化成 `position: fixed`（**冒号后有空格**），
  // 按 `position:fixed` 找永远找不到——我在这里错过两次。
  const overlays = [...document.querySelectorAll('div[style*="position:fixed"], div[style*="position: fixed"]')];
  out["② 点后遮罩数"] = overlays.length;
  out["② 点后遮罩文字"] = overlays.map((o) => (o.innerText || "").replace(/\s+/g, " ").trim().slice(0, 50));
  const overlayBtns = overlays.flatMap((o) => [...o.querySelectorAll("button")]);
  out["② 遮罩上的按钮"] = overlayBtns.map((b) => b.textContent.trim());
  out["② 点后 toast"] = [...document.querySelectorAll(".toast")].map((t) => t.textContent.trim().slice(0, 40)).slice(0, 3);

  // 只点遮罩里的按钮——上一次我按文字找，结果又点到了卡片上那个「删除」。
  const confirmBtn = overlayBtns.find((b) => /确定|确认|删除|是/.test((b.textContent || "").trim()));
  out["② 点了遮罩里的"] = confirmBtn ? confirmBtn.textContent.trim() : null;
  if (confirmBtn) {
    confirmBtn.click();
    await sleep(900);
  }
  out["② 界面删后格数"] = (await cellsOf()).length;

  // 直接调函数：把「函数本身」与「点击接线」分开。
  // 点不动可能是没绑上，也可能是函数自己早退——两件事的修法完全不同。
  const boardMod = await import(new URL("./assets/modules/board.js", location.href).href);
  try {
    // 它会等确认框被点。不点就永远挂着——所以这里不 await 到底，
    // 而是先等一拍看遮罩是否出现（这本身就是判据），再替它按确定。
    const pending = boardMod.deleteBoardCell(target2.id);
    await sleep(400);
    const ov2 = [...document.querySelectorAll('div[style*="position:fixed"], div[style*="position: fixed"]')];
    out["③ 直接调函数·遮罩数"] = ov2.length;
    out["③ 遮罩文字"] = ov2.map((o) => (o.innerText || "").replace(/\s+/g, " ").trim().slice(0, 40));
    const okBtn = ov2.flatMap((o) => [...o.querySelectorAll("button")])
      .find((b) => /确定|确认|删除/.test(b.textContent || ""));
    out["③ 遮罩上的确定键"] = okBtn ? okBtn.textContent.trim() : null;
    okBtn?.click();
    await Promise.race([pending, sleep(1500)]);
    out["③ 调完后格数"] = (await cellsOf()).length;
    out["③ 直接调函数·抛错"] = null;
  } catch (e) {
    out["③ 直接调函数·抛错"] = String(e.message).slice(0, 120);
  }
}

out["页面报错"] = (window.__errs || []).slice(0, 4);
return out;
