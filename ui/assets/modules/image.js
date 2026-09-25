// image.js — 出图设置：宿主供应商 / 本机 ComfyUI，两条路一个开关
//
// 用户点名要的："生成图片你也可以使用别的 APP 进行（比如 comfyuiAPP），
// 当然需要用户开关。"
//
// 面板的三个决定：
//   ① 两条路**各自体检**，不合成一个笼统的"不可用"——宿主那条坏了不该连累本机那条，
//      反过来也一样。
//   ② 本机那条必填的三项写成明面上的字段，不做"高级选项"藏起来：
//      工作流、提示词节点、以及 ComfyUI 本身。缺哪一项就卡在哪一项，说清楚。
//   ③ 「列出有哪些」把 ComfyUI 回的原始清单直接摊给用户看——
//      工作流名字是**他的**东西，我不猜、也不替他挑。

import { apiFetch, toast, escapeHtml, friendlyError } from "./core.js";

let current = null;
let busy = false;

const $ = (id) => document.getElementById(id);

function readEnvelope(res, what) {
  const env = res && typeof res === "object" ? res : {};
  if (env.ok === false) throw new Error(env.error || `${what}被拒绝了`);
  return env.data !== undefined ? env.data : env;
}

function setStatus(text, bad = false) {
  const el = $("image-status");
  if (!el) return;
  el.classList.toggle("bad", !!bad);
  el.textContent = text || "";
}

function fillForm(cfg) {
  current = cfg;
  document.querySelectorAll("#image-backends .tts-prov").forEach((el) => {
    el.classList.toggle("on", el.dataset.id === cfg.backend);
  });
  const box = $("image-comfy-box");
  if (box) box.classList.toggle("hidden", cfg.backend !== "comfyui");
  const hint = $("image-hint");
  const meta = (cfg.backends || []).find((b) => b.id === cfg.backend);
  if (hint) hint.textContent = meta?.hint || "";

  const wf = $("image-workflow");
  if (wf) wf.value = cfg.workflow || "";
  const pt = $("image-prompt-target");
  if (pt) pt.value = cfg.promptTarget || "";

  setStatus(cfg.ready
    ? `当前用：${meta?.label || cfg.backend} · 已配好，去角色面板点「生成立绘」`
    : `当前用：${meta?.label || cfg.backend} · ${cfg.reason || "还没配好"}`, !cfg.ready);
}

function renderEngines(e) {
  const box = $("image-engines");
  if (!box) return;
  const line = (label, ok, reason) =>
    `<div>${ok ? "✓" : "·"} ${escapeHtml(label)}：${ok ? "可用" : escapeHtml(reason || "不可用")}</div>`;
  box.innerHTML =
    line("宿主媒体供应商", !!e?.host?.available, e?.host?.reason) +
    line("本机 ComfyUI", !!e?.comfyui?.available, e?.comfyui?.reason);
  box.classList.toggle("bad", !e?.host?.available && !e?.comfyui?.available);
}

async function loadEngines() {
  try {
    const e = readEnvelope(await apiFetch("media/engines"), "读引擎状态");
    renderEngines(e);
    return e;
  } catch (err) {
    const box = $("image-engines");
    if (box) { box.classList.add("bad"); box.textContent = "体检失败：" + friendlyError(err); }
    return null;
  }
}

export async function openImage() {
  const modal = $("image-modal");
  if (!modal) return;
  modal.classList.remove("hidden");
  try {
    const cfg = readEnvelope(await apiFetch("media/config"), "读出图配置");
    const box = $("image-backends");
    if (box) {
      box.innerHTML = (cfg.backends || []).map((b) => `
        <button type="button" class="tts-prov${b.id === cfg.backend ? " on" : ""}" data-id="${escapeHtml(b.id)}">
          <span class="tts-prov-name">${escapeHtml(b.label)}</span>
          <span class="tts-prov-sub">${escapeHtml(b.id === "host" ? "装上就能用" : "要工作流与节点")}</span>
        </button>`).join("");
      box.querySelectorAll(".tts-prov").forEach((el) => {
        el.addEventListener("click", () => fillForm({ ...current, backend: el.dataset.id, ready: el.dataset.id === "host", reason: null }));
      });
    }
    fillForm(cfg);
    await loadEngines();
  } catch (e) {
    setStatus("读出图配置失败：" + friendlyError(e), true);
  }
}

export function closeImage() {
  $("image-modal")?.classList.add("hidden");
}

async function save() {
  const res = await apiFetch("media/config", {
    method: "PUT",
    body: JSON.stringify({
      backend: current?.backend,
      workflow: $("image-workflow")?.value ?? "",
      promptTarget: $("image-prompt-target")?.value ?? ""
    })
  });
  const cfg = readEnvelope(res, "保存出图设置");
  fillForm(cfg);
  toast(cfg.ready ? "出图设置已保存" : "已保存——" + cfg.reason, cfg.ready ? "success" : "error");
  return cfg;
}

export function bindImage() {
  const modal = $("image-modal");
  if (!modal || modal.dataset.bound === "1") return;
  modal.dataset.bound = "1";

  $("image-close")?.addEventListener("click", closeImage);
  $("image-cancel")?.addEventListener("click", closeImage);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeImage(); });

  $("image-save")?.addEventListener("click", async () => {
    try { await save(); }
    catch (e) { toast("保存失败：" + friendlyError(e), "error"); }
  });

  $("image-list-workflows")?.addEventListener("click", async () => {
    const btn = $("image-list-workflows");
    const out = $("image-workflow-out");
    if (busy) return;
    busy = true;
    if (btn) btn.disabled = true;
    if (out) out.textContent = "在问 ComfyUI…";
    try {
      const r = readEnvelope(await apiFetch("media/workflows"), "列工作流");
      // 原始清单直接摊开：我认不全它的结构，但用户认得自己的工作流名字。
      const text = JSON.stringify(r?.raw ?? r);
      if (out) out.textContent = text.slice(0, 600);
    } catch (e) {
      if (out) out.textContent = "列不出来：" + friendlyError(e);
    } finally {
      busy = false;
      if (btn) btn.disabled = false;
    }
  });
}
