// appearance.js — 自定义背景（2026-09-27 重设计 · 方向 A）
//
// 为什么带一个"遮罩"而不是直接铺图：
//   自定义背景一进来，所有颜色的对比度就不再有任何保证。暖纸底上那些
//   浅得刚好的字，压在照片上会直接消失。所以铺图的同时把几层底色换成
//   半透的一层（--bg / --surface / ... 改 rgba），强度与模糊交给用户调。
//   见 characters.css 末尾「自定义背景」那一段——那是唯一的样式来源。
//
// 图怎么拿到：走 JSON + base64（/appearance/image.json），和头像同一条路。
//   不能把路由 URL 直接写进 background-image：那条请求不带鉴权，真机回 403。
//   也不能假设 hana.api.fetch 给 Response —— 见 core.js 里 apiAvatarBlobUrl
//   的注释，第一次就是栽在这上面。
//
// 上传前在浏览器里先缩到最长边 1920 再编码：这样传上去通常只有几百 KB，
// 而不是原图的十几 MB。后端那边超限守卫只是兜底。

import { apiFetch, toast, friendlyError, unwrap } from "./core.js";
import { state } from "./state.js";

// 默认 0.78：0.86 时纸面只透 14%，选了背景几乎看不出变化；
// 0.78 透 22%，正文对纯黑照片的 WCAG 对比度 7.09:1（AA 门槛 4.5），仍安全。
const DEFAULTS = { image: null, veil: 0.78, blur: 0 };

/** 配置（内存里那份，界面一律以它为准）。 */
let cfg = { ...DEFAULTS };
/** 当前背景图的 blob URL；换图/去图时必须 revoke，否则一路漏内存。 */
let bgUrl = null;
/** 面板是否已经绑过事件。 */
let bound = false;

const $ = (id) => document.getElementById(id);

function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** 把内存里的 cfg 落到 DOM 上。幂等。 */
function applyCfg() {
  const root = document.documentElement;
  root.style.setProperty("--app-bg-veil", String(cfg.veil));
  root.style.setProperty("--app-bg-blur", cfg.blur > 0 ? `${cfg.blur}px` : "0px");

  const layer = $("app-bg");
  if (!layer) return;
  if (bgUrl) {
    layer.style.backgroundImage = `url("${bgUrl}")`;
    root.classList.add("has-app-bg");
  } else {
    layer.style.backgroundImage = "";
    root.classList.remove("has-app-bg");
  }
}

/** 拉图片字节，转成 blob URL。失败只记不抛——背景是装饰，不该拦住整屏。 */
async function refreshImage() {
  if (bgUrl) { URL.revokeObjectURL(bgUrl); bgUrl = null; }
  if (!cfg.image) return;
  try {
    const env = await apiFetch("appearance/image.json");
    const d = unwrap(env) || {};
    if (typeof d.base64 !== "string" || !d.base64) return;
    const bin = atob(d.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    bgUrl = URL.createObjectURL(new Blob([bytes], { type: d.mime || "image/png" }));
  } catch (e) {
    console.error("[bg] 图没取到:", e);
    toast(`背景图没取到：${friendlyError(e)}`, "error");
  }
}

/** 拉配置 + 图，落到界面。开局调一次。 */
export async function loadAppearance() {
  try {
    const env = await apiFetch("appearance");
    const d = unwrap(env) || {};
    cfg = {
      image: typeof d.image === "string" && d.image ? d.image : null,
      veil: clampNum(d.veil, 0.75, 0.99, DEFAULTS.veil),
      blur: clampNum(d.blur, 0, 24, DEFAULTS.blur)
    };
  } catch (e) {
    // 拉不到配置不该拦住整屏——按"没有背景"跑
    console.error("[bg] 配置没取到:", e);
    cfg = { ...DEFAULTS };
  }
  await refreshImage();
  applyCfg();
  renderModal();
}

/** 重画设置面板里的预览与两个滑块。 */
function renderModal() {
  const prev = $("bg-preview");
  if (prev) {
    if (bgUrl) {
      prev.innerHTML = `<img src="${bgUrl}" alt="当前背景预览">`;
    } else {
      prev.innerHTML = '<div class="bg-none"><b>还没有背景</b><br>点一下这里选一张图，或把图拖进来</div>';
    }
  }
  const veil = $("bg-veil"), blur = $("bg-blur");
  if (veil) veil.value = String(cfg.veil);
  if (blur) blur.value = String(cfg.blur);
  const vv = $("bg-veil-val"), bv = $("bg-blur-val");
  if (vv) vv.textContent = cfg.veil.toFixed(2);
  if (bv) bv.textContent = `${Math.round(cfg.blur)} px`;
  const clear = $("bg-clear");
  if (clear) clear.disabled = !cfg.image;
}

export function openBgModal() {
  const m = $("bg-modal");
  if (!m) return;
  renderModal();
  m.classList.remove("hidden");
}
export function closeBgModal() {
  $("bg-modal")?.classList.add("hidden");
}

/**
 * 在浏览器里把图缩到最长边 1920 再编码。
 *
 * 为什么在这里做而不是等后端：原图动辄 4000px 宽、8 MB，
 * 而它只是当背景铺一层——传原图是白花一次桥接流量。
 * webp 不被支持时退回 jpeg（老 webview 上 toBlob 会回 null）。
 */
async function shrink(file, maxEdge = 1920, quality = 0.86) {
  const bitmap = await loadBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  cv.getContext("2d").drawImage(bitmap.source, 0, 0, w, h);
  bitmap.close?.();
  const toBlob = (type) => new Promise((res) => cv.toBlob(res, type, quality));
  return (await toBlob("image/webp")) || (await toBlob("image/jpeg"));
}

/** 取一个可画的源。优先 createImageBitmap；老的 webview 退回 <img>。 */
async function loadBitmap(file) {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file);
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close?.() };
    } catch { /* 落到下面那条 */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const el = new Image();
      el.onload = () => res(el);
      el.onerror = () => rej(new Error("这张图读不出来"));
      el.src = url;
    });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/** 选图 → 缩放 → 上传 → 重新拉配置。 */
async function pickAndUpload(file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) { toast("这看着不是图片文件", "error"); return; }
  const drop = $("bg-drop");
  const old = drop?.innerHTML;
  if (drop) drop.innerHTML = '<div class="bg-none">处理中…</div>';
  try {
    const blob = await shrink(file);
    if (!blob) throw new Error("这张图编码失败（可能格式不被支持）");
    const form = new FormData();
    form.append("file", blob, "bg.webp");
    const env = await apiFetch("appearance/image", { method: "POST", body: form });
    const d = unwrap(env) || {};
    cfg = {
      image: typeof d.image === "string" && d.image ? d.image : null,
      veil: clampNum(d.veil, 0.75, 0.99, cfg.veil),
      blur: clampNum(d.blur, 0, 24, cfg.blur)
    };
    await refreshImage();
    applyCfg();
    renderModal();
    toast("背景换好了");
  } catch (e) {
    if (drop && old !== undefined) drop.innerHTML = old;
    toast(`没能换背景：${friendlyError(e)}`, "error");
  }
}

/** 两个滑块：先本地生效（拖的时候就能看见），松手才落盘。 */
async function saveNumbers() {
  try {
    const env = await apiFetch("appearance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ veil: cfg.veil, blur: cfg.blur })
    });
    const d = unwrap(env) || {};
    cfg.veil = clampNum(d.veil, 0.75, 0.99, cfg.veil);
    cfg.blur = clampNum(d.blur, 0, 24, cfg.blur);
  } catch (e) {
    toast(`设置没存下：${friendlyError(e)}`, "error");
  }
}

async function clearImage() {
  try {
    await apiFetch("appearance/image/clear", { method: "POST" });
    cfg.image = null;
    if (bgUrl) { URL.revokeObjectURL(bgUrl); bgUrl = null; }
    applyCfg();
    renderModal();
    toast("背景去掉了");
  } catch (e) {
    toast(`没去掉：${friendlyError(e)}`, "error");
  }
}

// ── AI 生成背景（第 4 期）──────────────────────────
// 场景文本 → 后端 /background/generate（LLM 写提示词禁人物 → 出图 →
// AppearanceRepo.saveImage）→ 本地重拉配置刷新 #app-bg 层。
function bindBackgroundAI() {
  const enabled = $("bg-ai-enabled");
  const statusEl = $("bg-ai-status");
  const genBtn = $("bg-ai-generate");
  const sceneEl = $("bg-ai-scene");
  const promptEl = $("bg-ai-prompt");
  if (!enabled || !genBtn) return;

  // 打开抽屉时拉一次配置，回填总闸状态
  $("bg-open")?.addEventListener("click", async () => {
    try {
      const env = await apiFetch("background/config");
      enabled.checked = unwrap(env)?.enabled === true;
    } catch { /* 拉不到就保持默认不勾 */ }
  });

  enabled?.addEventListener("change", async () => {
    try {
      await apiFetch("background/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: enabled.checked })
      });
      toast(enabled.checked ? "AI 生成背景已开启" : "AI 生成背景已关闭", "success");
    } catch (e) {
      toast(`没存下：${friendlyError(e)}`, "error");
    }
  });

  genBtn.addEventListener("click", async () => {
    if (genBtn.disabled) return;
    genBtn.disabled = true;
    if (statusEl) statusEl.textContent = "正在生成（写提示词 → 出图，约半分钟）…";
    try {
      const sceneText = String(sceneEl?.value || "").trim();
      const env = await apiFetch("background/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sceneText: sceneText || undefined,
          conversationId: sceneText ? undefined : (state.currentConv?.id || undefined)
        })
      });
      const d = unwrap(env) || {};
      // 应用到本层：重拉配置 + 图
      await loadAppearance();
      if (promptEl) promptEl.textContent = `提示词（${d.via ?? "?"}）：${d.prompt ?? ""}`;
      if (statusEl) statusEl.textContent = "已应用";
      toast("背景图已生成并应用", "success");
    } catch (e) {
      if (statusEl) statusEl.textContent = "";
      toast(`生成失败：${friendlyError(e)}`, "error");
    } finally {
      genBtn.disabled = false;
    }
  });
}

/** 绑定。幂等。 */
export function bindAppearance() {
  if (bound) return;
  bound = true;

  $("bg-open")?.addEventListener("click", openBgModal);
  $("bg-close")?.addEventListener("click", closeBgModal);
  // 「关闭」按钮已删：标题栏的 ✕ 就能关，页脚不再放一个重复的。
  $("bg-modal")?.addEventListener("click", (e) => { if (e.target.id === "bg-modal") closeBgModal(); });

  bindBackgroundAI();

  const file = $("bg-file");
  const drop = $("bg-drop");
  const ask = () => file?.click();
  $("bg-pick")?.addEventListener("click", ask);
  drop?.addEventListener("click", ask);
  drop?.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); ask(); } });
  file?.addEventListener("change", () => {
    const f = file.files?.[0];
    file.value = "";
    pickAndUpload(f).catch(() => {});
  });

  // 拖进来也行——选图这件事，两个手势都比只有一个好
  drop?.addEventListener("dragover", (e) => { e.preventDefault(); drop.style.borderColor = "var(--accent)"; });
  drop?.addEventListener("dragleave", () => { drop.style.borderColor = ""; });
  drop?.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.style.borderColor = "";
    pickAndUpload(e.dataTransfer?.files?.[0]).catch(() => {});
  });

  const veil = $("bg-veil"), blur = $("bg-blur");
  veil?.addEventListener("input", () => {
    cfg.veil = clampNum(veil.value, 0.75, 0.99, cfg.veil);
    const vv = $("bg-veil-val"); if (vv) vv.textContent = cfg.veil.toFixed(2);
    applyCfg();
  });
  blur?.addEventListener("input", () => {
    cfg.blur = clampNum(blur.value, 0, 24, cfg.blur);
    const bv = $("bg-blur-val"); if (bv) bv.textContent = `${Math.round(cfg.blur)} px`;
    applyCfg();
  });
  veil?.addEventListener("change", () => { saveNumbers().catch(() => {}); });
  blur?.addEventListener("change", () => { saveNumbers().catch(() => {}); });

  $("bg-clear")?.addEventListener("click", () => { clearImage().catch(() => {}); });
}
