// tools/flows/portrait.js —— 生成立绘：按钮在不在、不可用时说不说得清
//
// dev 宿主没有 sdk.media（那是宿主才有的门），所以这里验的是**失败那条路**：
// 不可用时要给出「缺什么」，而不是让人等半分钟才失败。
// 真出图那一步只能在宿主里验——探针不假装验过。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];
window.addEventListener("error", (e) => errs.push(String(e.message)));

const out = {};
const CONV = "e952e1c7-f779-49f3-ae75-c84daf4269b3";
const CONV_CHAR = "2d4512f6-e7c5-46b2-aab0-805149802cc1"; // 薇拉·霜语：面板与编辑器都拿它验
const chat = await import(new URL("./assets/modules/chat.js", location.href).href);

await chat.openConversation(CONV);
await sleep(1200);

const pane = document.getElementById("char-ctx-body");
out["角色面板有内容"] = (pane?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 60) || "(空)";

const btn = document.getElementById("ctx-portrait");
out["生成立绘按钮"] = btn ? btn.textContent.trim() : "(不存在)";
out["按钮可用"] = btn ? !btn.disabled : null;
out["头像处画的是什么"] = (() => {
  const ava = document.querySelector(".char-ctx-ava");
  if (!ava) return "(没有头像框)";
  const img = ava.querySelector("img");
  return img ? `图片 ${img.getAttribute("src")?.slice(0, 60)}` : `首字母「${ava.textContent.trim()}」`;
})();
out["状态行初始"] = (document.getElementById("ctx-portrait-note")?.textContent || "").trim() || "(空)";

// 点一次：dev 宿主没有媒体面，应当停在"不可用 + 原因"上
btn?.click();
await sleep(2500);

out["点击后状态行"] = (document.getElementById("ctx-portrait-note")?.textContent || "").trim();
out["点击后按钮恢复可用"] = btn ? !btn.disabled : null;
out["有没有卡在出图中"] = /正在出图/.test(out["点击后状态行"]) ? "卡住了（错）" : "没有（对）";

out["gen/sources 之类有没有 4xx"] = performance
  .getEntriesByType("resource")
  .filter((r) => r.responseStatus >= 400 && !r.name.includes("favicon"))
  .map((r) => `${r.responseStatus} ${r.name.replace(location.origin, "")}`);

// ── 编辑器里那个入口（复核指出的缺口：不开对话也得能出图）──
const { openCharacterEditor } = await import(new URL("./assets/modules/characters.js", location.href).href);

await openCharacterEditor(CONV_CHAR);
await sleep(600);
const mBtn = document.getElementById("modal-portrait");
out["编辑器·编辑既有卡：按钮在不在"] = mBtn
  ? (mBtn.classList.contains("hidden") ? "藏着的（错）" : `显示「${mBtn.textContent.trim()}」`)
  : "(不存在)";
out["编辑器·状态行为空"] = (document.getElementById("modal-portrait-note")?.textContent || "").trim() || "(空)";
mBtn?.click();
await sleep(2000);
out["编辑器·点击后状态行"] = (document.getElementById("modal-portrait-note")?.textContent || "").trim();
out["编辑器·点击后按钮恢复"] = mBtn ? !mBtn.disabled : null;

await openCharacterEditor(); // 不传 id = 新建
await sleep(600);
out["编辑器·新建卡时按钮藏起"] = document.getElementById("modal-portrait")?.classList.contains("hidden") ? "藏着（对）" : "露着（错）";
out["编辑器·新建卡时状态行清空"] = (document.getElementById("modal-portrait-note")?.textContent || "").trim() || "(空)";

out["页面报错"] = errs.length ? errs : "无";

return out;
