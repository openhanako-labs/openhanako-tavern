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
//
// 2026-09-28 改造：状态条提到最上（.modal-health）——体检结果是主角；
// 底部按钮改成 取消 / 保存 右对齐；单选卡只展开当前这一家。

import { apiFetch, toast, escapeHtml, friendlyError } from "./core.js";

let current = null;
let busy = false;
let engines = null;   // 最近一次体检结果

const $ = (id) => document.getElementById(id);

function readEnvelope(res, what) {
  const env = res && typeof res === "object" ? res : {};
  if (env.ok === false) throw new Error(env.error || `${what}被拒绝了`);
  return env.data !== undefined ? env.data : env;
}

/**
 * 体检条：● + 一句人话 + 一句细节 + 一个直接动作。
 *
 * 三态：
 *   is-ok    —— 已配好，可以去用
 *   is-bad   —— 已配置但缺东西
 *   （默认灰） —— 还没体检或未配置
 *
 * 与旧的 .tts-status 不一样：状态在这里是**主角**，不再是底部一行小字。
 */
function setHealth(opts) {
  const el = $("image-health");
  if (!el) return;
  const { state = "", title = "", sub = "", hasAction = false } = opts || {};
  el.classList.remove("is-ok", "is-bad");
  if (state === "ok") el.classList.add("is-ok");
  if (state === "bad") el.classList.add("is-bad");
  el.querySelector(".mh-title")?.replaceChildren(title);
  el.querySelector(".mh-sub")?.replaceChildren(sub);
  el.querySelector(".mh-act")?.classList.toggle("hidden", !hasAction);
}

function describeEngine() {
  const host = engines?.host;
  const comfy = engines?.comfyui;
  const b = current?.backend || "host";
  if (b === "host") {
    return host?.available ? `宿主媒体供应商可用 · ${host.reason || ""}`.trim() : `宿主媒体供应商：${host?.reason || "还没体检"}`;
  }
  return comfy?.available
    ? `本机 ComfyUI · ${comfy.tool || "工具就绪"}`
    : `本机 ComfyUI：${comfy?.reason || "还没体检"}`;
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

  // 体检条：先看配置齐不齐，再看引擎通不通
  refreshHealth();
}

function refreshHealth() {
  const b = current?.backend || "host";
  const meta = (current?.backends || []).find((x) => x.id === b);
  const label = meta?.label || b;

  // 引擎没体检过
  if (!engines) {
    setHealth({ title: "还没体检", sub: `当前选：${label} · 打开面板会自动探测一次`, hasAction: true });
    return;
  }

  // 引擎体检过但配置没齐（comfyui 缺 workflow / promptTarget）
  if (!current?.ready) {
    setHealth({ state: "bad", title: "还缺配置", sub: `${label} · ${current.reason || "还没配好"}`, hasAction: true });
    return;
  }

  // 配置齐了但引擎不可用
  const engineOk = b === "host" ? !!engines.host?.available : !!engines.comfyui?.available;
  if (!engineOk) {
    const reason = b === "host" ? engines.host?.reason : engines.comfyui?.reason;
    setHealth({ state: "bad", title: "引擎不可用", sub: `${label} · ${reason || "探测失败"}`, hasAction: true });
    return;
  }

  // 全部通过
  setHealth({ state: "ok", title: "可用", sub: describeEngine(), hasAction: true });
}

async function loadEngines() {
  try {
    engines = readEnvelope(await apiFetch("media/engines"), "读引擎状态");
    refreshHealth();
    return engines;
  } catch (err) {
    setHealth({ state: "bad", title: "体检失败", sub: friendlyError(err), hasAction: true });
    return null;
  }
}

export async function openImage() {
  const modal = $("image-modal");
  if (!modal) return;
  modal.classList.remove("hidden");
  engines = null;   // 每次打开重新体检
  setHealth({ title: "正在体检…", sub: "读配置与探测引擎", hasAction: false });
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
        el.addEventListener("click", () => fillForm({ ...current, backend: el.dataset.id }));
      });
    }
    fillForm(cfg);
    await loadEngines();
  } catch (e) {
    setHealth({ state: "bad", title: "读不到配置", sub: friendlyError(e), hasAction: true });
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
  // 保存后不用重新体检引擎——配置变更不影响引擎的可用性
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

  // 「重测」按钮：重新跑一次引擎体检
  $("image-retest")?.addEventListener("click", async () => {
    const btn = $("image-retest");
    if (busy) return;
    busy = true;
    if (btn) btn.disabled = true;
    setHealth({ title: "正在体检…", sub: "重新探测引擎", hasAction: false });
    try { await loadEngines(); }
    finally { busy = false; if (btn) btn.disabled = false; }
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
