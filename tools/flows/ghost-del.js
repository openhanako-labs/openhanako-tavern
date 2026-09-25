// tools/flows/ghost-del.js —— 删一个**不存在**的东西，应当早早说清，而不是先问一句
//
// 要验的是行为，不是文字：遮罩**不该出现**，而要有一句说明，
// 并且列表会跟后端对齐（loadBoard / loadRegexRules 被调到）。
//
// 这是上一轮那笔"没查清"的收尾。

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

// 遮罩：core.js 的 confirmDialog 是自定义遮罩。
// 注意冒号后的空格——内联样式序列化成 `position: fixed`。
const overlays = () => [...document.querySelectorAll('div[style*="position:fixed"], div[style*="position: fixed"]')];
const toasts = () => [...document.querySelectorAll(".toast")].map((t) => t.textContent.trim());

const out = {};
const GHOST = "00000000-0000-4000-8000-000000000000";

// ── 世界：删一个不存在的格子 ────────────────────────────
shell.openDrawer("board");
await sleep(700);
const boardMod = await import(new URL("./assets/modules/board.js", location.href).href);

const before = overlays().length;
const p1 = boardMod.deleteBoardCell(GHOST).catch((e) => out["世界·抛错"] = String(e.message));
await Promise.race([p1, sleep(1500)]);
out["世界·遮罩数（不该出现）"] = `${before} → ${overlays().length}`;
out["世界·toast"] = toasts().slice(-2);

// ── 正则：删一条不存在的规则 ────────────────────────────
shell.openDrawer("regex");
await sleep(700);
const regexMod = await import(new URL("./assets/modules/regex.js", location.href).href);

const before2 = overlays().length;
const p2 = regexMod.deleteRegexRule(GHOST).catch((e) => out["正则·抛错"] = String(e.message));
await Promise.race([p2, sleep(1500)]);
out["正则·遮罩数（不该出现）"] = `${before2} → ${overlays().length}`;
out["正则·toast"] = toasts().slice(-2);

// ── 反证：一个**真的存在**的格子，删除仍然要弹确认 ────────
const cells = await (async () => {
  const raw = await (await fetch(`/__api/board/cells?conversationId=${CONV}`)).json();
  return [...(raw?.data?.world || []), ...(raw?.data?.chat || [])];
})();
out["前置·现有格数"] = cells.length;
if (cells[0]) {
  const p3 = boardMod.deleteBoardCell(cells[0].id);
  await sleep(500);
  const ov = overlays();
  out["反证·真实格子弹了确认吗"] = ov.length > 0;
  out["反证·确认文字"] = ov.map((o) => (o.innerText || "").replace(/\s+/g, " ").trim().slice(0, 34));
  // 取消掉，别真删
  const cancel = ov.flatMap((o) => [...o.querySelectorAll("button")]).find((b) => /取消/.test(b.textContent || ""));
  cancel?.click();
  await Promise.race([p3, sleep(1000)]);
}

out["页面报错"] = (window.__errs || []).slice(0, 4);
return out;
