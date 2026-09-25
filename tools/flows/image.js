// tools/flows/image.js —— 出图设置：两条路各自体检，按钮跟着选中的那条走
//
// dev 宿主里两条路都不可用（没人给 sdk.media，也没有 environments），
// 所以这里验的正是**失败那条路**：缺什么要说清，而且
// **切了引擎之后，角色面板那个按钮说的话要跟着换**——
// 之前它只会说"宿主没提供 sdk.media"，哪怕你已经切到本机 ComfyUI 了。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];
window.addEventListener("error", (e) => errs.push(String(e.message)));

const out = {};
const CONV = "e952e1c7-f779-49f3-ae75-c84daf4269b3";
const chat = await import(new URL("./assets/modules/chat.js", location.href).href);
await chat.openConversation(CONV);
await sleep(1500);

// ── 打开设置 ────────────────────────────────────────────

document.getElementById("chat-more-btn")?.click();
await sleep(200);
// 二级项得先展开「更多」
document.getElementById("more-toggle")?.click();
await sleep(150);
const item = document.querySelector('#more-menu button[data-act="image"]');
out["⋯ 菜单里有出图设置"] = item ? "有" : "没有";
item?.click();
await sleep(1800);

const modal = document.getElementById("image-modal");
out["面板打开了"] = modal && !modal.classList.contains("hidden") ? "是" : "否";
out["两条路都画出来了"] = [...document.querySelectorAll("#image-backends .tts-prov")].map((el) => el.dataset.id).join(",");
out["体检行"] = (document.getElementById("image-engines")?.innerText || "").replace(/\n+/g, " / ");
out["初始状态行"] = (document.getElementById("image-status")?.textContent || "").trim();
out["本机那块（选宿主时该藏起）"] = document.getElementById("image-comfy-box")?.classList.contains("hidden") ? "藏着（对）" : "露着（错）";

// 切到本机 ComfyUI
document.querySelector('#image-backends .tts-prov[data-id="comfyui"]')?.click();
await sleep(300);
out["切到本机后"] = {
  本机块: document.getElementById("image-comfy-box")?.classList.contains("hidden") ? "还藏着（错）" : "可见（对）",
  提示语: (document.getElementById("image-hint")?.textContent || "").trim().slice(0, 40)
};

// 没填全就保存 → 要明说缺什么
document.getElementById("image-workflow").value = "";
document.getElementById("image-prompt-target").value = "";
document.getElementById("image-save").click();
await sleep(1500);
out["没填全时的状态行"] = (document.getElementById("image-status")?.textContent || "").trim();

// 填错格式也要认得出
document.getElementById("image-workflow").value = "我的立绘.json";
document.getElementById("image-prompt-target").value = "乱填的";
document.getElementById("image-save").click();
await sleep(1200);
out["节点名写错时的状态行"] = (document.getElementById("image-status")?.textContent || "").trim();

// 填对 → 该说"已配好"
document.getElementById("image-prompt-target").value = "6.text";
document.getElementById("image-save").click();
await sleep(1500);
out["填对后的状态行"] = (document.getElementById("image-status")?.textContent || "").trim();

// ── 关键：面板上的按钮说的话要跟着选中的路走 ──
document.getElementById("image-cancel")?.click();
await sleep(300);
const speak = document.querySelector('#ctx-portrait') || document.getElementById("ctx-portrait");
out["角色面板上有生成立绘"] = speak ? "有" : "没有";
speak?.click();
await sleep(2200);
out["切到本机后·按钮说的话"] = (document.getElementById("ctx-portrait-note")?.textContent || "").trim();

// 切回宿主，按钮说的话也该跟着换
document.getElementById("chat-more-btn")?.click();
await sleep(150);
document.getElementById("more-toggle")?.click();
await sleep(120);
document.querySelector('#more-menu button[data-act="image"]')?.click();
await sleep(1200);
document.querySelector('#image-backends .tts-prov[data-id="host"]')?.click();
await sleep(250);
document.getElementById("image-save").click();
await sleep(1200);
document.getElementById("image-cancel")?.click();
await sleep(250);
document.getElementById("ctx-portrait")?.click();
await sleep(2200);
out["切回宿主后·按钮说的话"] = (document.getElementById("ctx-portrait-note")?.textContent || "").trim();
out["两句话是否不同（体检没问错对象）"] =
  out["切到本机后·按钮说的话"] !== out["切回宿主后·按钮说的话"] ? "不同（对）" : "一样（可能问错了对象）";

out["有没有 4xx（除 favicon 与预期的那次）"] = performance
  .getEntriesByType("resource")
  .filter((r) => r.responseStatus >= 400 && !r.name.includes("favicon") && !/media\/portrait/.test(r.name))
  .map((r) => `${r.responseStatus} ${r.name.replace(location.origin, "")}`);
out["页面报错"] = errs.length ? errs : "无";

return out;
