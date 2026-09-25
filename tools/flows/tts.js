// tools/flows/tts.js —— 语音朗读：入口在不在、没配时说不说得清、密钥会不会漏到界面上
//
// dev 宿主没有 sdk 也没有真 key，所以这里验的是**两件能验的事**：
//   ① 未配置时点朗读 → 给一句能指路的话，按钮复原，不卡住
//   ② 设置面板：填了 region/key 保存后立即变"已配好"，且**密钥不回显**
// 真出声那一步只能在宿主里验（要真 key），探针不假装验过。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];
window.addEventListener("error", (e) => errs.push(String(e.message)));

const out = {};
const CONV = "e952e1c7-f779-49f3-ae75-c84daf4269b3";
const chat = await import(new URL("./assets/modules/chat.js", location.href).href);

await chat.openConversation(CONV);
await sleep(1200);

// 这个测试对话本身是空的（探测时核实过）——先发一条，
// 否则后面“消息旁有没有朗读按钮”查的是空气。
const ta = [...document.querySelectorAll("textarea")].find((t) => (t.placeholder || "").includes("输入消息"));
const sendBtn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "发送");
out["找到输入框/发送键"] = !!ta && !!sendBtn;
if (ta && sendBtn) {
  ta.value = "你还在吗？";
  sendBtn.click();
  await sleep(5000);
}
out["发完之后消息条数"] = document.querySelectorAll(".message").length;

// ── 消息上的朗读按钮 ────────────────────────────────────

const speakBtns = [...document.querySelectorAll('[data-act="speak"]')];
out["消息上的朗读按钮数"] = speakBtns.length;
out["按钮文字"] = speakBtns[0]?.textContent?.trim() || "(没有)";

if (speakBtns[0]) {
  speakBtns[0].click();
  // toast 会自己消失，所以要早点看（上一版等了 2.5 秒，看见的是空盘子）
  await sleep(700);
  const errToasts = [...document.querySelectorAll(".toast.error")].map((t) => t.textContent.trim());
  out["未配置时的错误话"] = errToasts.slice(-2);
  out["那句话有没有指路"] = errToasts.some((t) => /朗读不了/.test(t))
    ? (errToasts.some((t) => /语音朗读/.test(t)) ? "有（提到 ⋯ 菜单）" : "说了原因，没指路")
    : "没看到";
  await sleep(1800);
  out["未配置时点朗读·按钮复原"] = speakBtns[0].textContent.trim();
}

// ── 诊断：监听器到底挂上了没有 ──
// 直接调模块（绕开按钮）跟走按钮两条路分开测，
// 才能分清“按钮没接线”和“模块自己报错”。
const ttsMod = await import(new URL("./assets/modules/tts.js", location.href).href);
out["tts 模块导出"] = Object.keys(ttsMod).join(",");
out["stripForSpeech 试一下"] = ttsMod.stripForSpeech("**她**笑了`这里`\n> 引用");
try {
  const r = await ttsMod.speakText("夜色落在城墙上。", { key: "probe-direct" });
  out["直接调 speakText"] = JSON.stringify(r).slice(0, 220);
} catch (e) {
  out["直接调 speakText 抛了"] = String(e?.message || e);
}
await sleep(300);
out["这时所有的 toast"] = [...document.querySelectorAll(".toast")].map((t) => `${t.className}: ${t.textContent.trim().slice(0, 90)}`);
out["网络里跟 tts 有关的请求"] = performance.getEntriesByType("resource")
  .filter((x) => x.name.includes("tts"))
  .map((x) => `${x.responseStatus} ${x.name.replace(location.origin, "")}`);

// ── 设置面板 ────────────────────────────────────────────

document.getElementById("chat-more-btn")?.click();
await sleep(200);
const ttsItem = document.querySelector('#more-menu button[data-act="tts"]');
out["⋯ 菜单里有语音朗读"] = ttsItem ? "有" : "没有";
ttsItem?.click();
await sleep(1200);

const modal = document.getElementById("tts-modal");
out["面板打开了"] = modal && !modal.classList.contains("hidden") ? "是" : "否";
out["两家水龙头都画出来"] = [...document.querySelectorAll("#tts-providers .tts-prov")].map((el) => el.dataset.id).join(",");
out["初始状态行"] = (document.getElementById("tts-status")?.textContent || "").trim();
out["微软的输入框可见"] = document.getElementById("tts-azure-box")?.classList.contains("hidden") ? "藏着的（错）" : "可见";
out["微软提示语"] = (document.getElementById("tts-hint")?.textContent || "").trim().slice(0, 40);
out["声音下拉里有几个"] = document.querySelectorAll("#tts-voice option").length;
out["清空密钥的勾选框（没存过时应藏起）"] = document.getElementById("tts-azure-clear")?.closest("label")?.classList.contains("hidden") ? "藏着（对）" : "露着（错）";

// 切到另一根水龙头：输入区要跟着换
document.querySelector('#tts-providers .tts-prov[data-id="openai"]')?.click();
await sleep(300);
out["切到 OpenAI 兼容后"] = {
  微软区: document.getElementById("tts-azure-box")?.classList.contains("hidden") ? "藏起（对）" : "还露着（错）",
  openai区: document.getElementById("tts-openai-box")?.classList.contains("hidden") ? "还藏着（错）" : "可见（对）",
  提示语: (document.getElementById("tts-hint")?.textContent || "").trim().slice(0, 30)
};
document.querySelector('#tts-providers .tts-prov[data-id="azure"]')?.click();
await sleep(300);

// 填 region + key，保存 → 状态要立刻变"已配好"
document.getElementById("tts-azure-region").value = "eastasia";
document.getElementById("tts-azure-key").value = "probe-fake-key-123";
document.getElementById("tts-save").click();
await sleep(1800);

out["保存后状态行"] = (document.getElementById("tts-status")?.textContent || "").trim();

// 关键：密钥不该回显在界面上
const azKeyEl = document.getElementById("tts-azure-key");
out["密钥输入框已清空"] = azKeyEl?.value === "" ? "是" : `否（值=${azKeyEl?.value}）`;
out["密钥输入框提示语"] = azKeyEl?.placeholder || "";
out["清空密钥的勾选框（存过之后）"] = document.getElementById("tts-azure-clear")?.closest("label")?.classList.contains("hidden") ? "还藏着（错）" : "露出来了（对）";
out["界面文本里有没有密钥原文"] = (document.body.innerText || "").includes("probe-fake-key-123") ? "漏了（错）" : "没有（对）";
out["页面 HTML 里有没有密钥原文"] = document.documentElement.outerHTML.includes("probe-fake-key-123") ? "漏了（错）" : "没有（对）";

// ── 按角色分配声音 ─────────────────────────────────
// 这场对话是单人（薇拉），名单应该就一行。
const vmRows = [...document.querySelectorAll("#tts-voice-map .tts-vm-row")];
out["声音分配名单行数"] = vmRows.length;
out["名单里是谁"] = vmRows.map((r) => r.querySelector(".tts-vm-name")?.textContent?.trim()).join(",");
out["默认选项"] = vmRows[0]?.querySelector("option")?.textContent?.trim() || "(没有)";
out["可选声音数（含默认）"] = vmRows[0]?.querySelectorAll("option").length || 0;

const sel0 = vmRows[0]?.querySelector(".tts-vm-sel");
const pick = [...(sel0?.options || [])].map((o) => o.value).find((v) => v && v !== "zh-CN-XiaoxiaoNeural");
out["挑了哪个声音"] = pick || "(没得挑)";
if (sel0 && pick) {
  sel0.value = pick;
  sel0.dispatchEvent(new Event("change"));
  await sleep(1200);
  const core = await import(new URL("./assets/modules/core.js", location.href).href);
  const cfgEnv = await core.apiFetch("tts/config");
  out["存下来的分配"] = JSON.stringify((cfgEnv?.data || cfgEnv)?.voices || {});
}

// 关掉面板
const closedOnce = document.getElementById("tts-cancel");
closedOnce?.click();
await sleep(250);
out["面板关掉了"] = document.getElementById("tts-modal")?.classList.contains("hidden") ? "是" : "否";

// 重新开一次：分配过的声音该带着选中状态回来——
// “存下来了但界面不记得”是这类面板最坑的一种假成功。
if (out["面板关掉了"] === "是") {
  document.getElementById("chat-more-btn")?.click();
  await sleep(150);
  document.querySelector('#more-menu button[data-act="tts"]')?.click();
  await sleep(1000);
  const after = document.querySelector("#tts-voice-map .tts-vm-sel");
  out["重开后的选中项"] = after?.value || "(没读到)";
  out["重开后是不是刚挑的那个"] = after?.value === pick ? "是（对）" : "不是（错）";
  document.getElementById("tts-cancel")?.click();
  await sleep(150);
}

out["有没有 4xx（除 favicon）"] = performance
  .getEntriesByType("resource")
  .filter((r) => r.responseStatus >= 400 && !r.name.includes("favicon") && !/tts\/speak/.test(r.name))
  .map((r) => `${r.responseStatus} ${r.name.replace(location.origin, "")}`);
// 未配置时那次朗读的 400 是**预期内**的（我们要的就是它说不配好），
// 不能跟真异常桂一起——探针自己也得分清“失败”和“设计如此”。
out["预期内的 400（未配置时那次朗读）"] = performance
  .getEntriesByType("resource")
  .filter((r) => r.responseStatus === 400 && /tts\/speak/.test(r.name)).length;
out["页面报错"] = errs.length ? errs : "无";

return out;
