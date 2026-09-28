// scene.js — 场景插图设置
//
// 面板只有一个任务：让人知道「现在到底会不会自动出图」。
// 默认关是硬要求（计划 §5 判据 2），所以面板打开第一眼就要看到「关」——
// 而不是先看到一堆开关，看完才知道根本没开。
//
// 三个开关与两个字段的分工：
//   enabled     —— 总闸。关掉后什么都不出（含手动补一张）。
//   mode        —— 自动触发的具体策略：marker | off。
//                  enabled=true + mode=off 是一种「我要留入口但不要自动」的状态。
//   characterRef—— 提示词里要不要带角色的描述/性格。
//   style       —— 风格描述（不填用默认）。
//
// autoTriggerActive 是后端算出来的最终结论：enabled && mode!=off。
// 面板只负责印出来，不自己再算一遍。
//
// 2026-09-28 改造：
//   · 状态条提到最上（.modal-health）——让人一打开就知道「会不会自动出图」
//   · 模式从 <select> 换成两选一卡片（radio）——两个状态都可见
//     select 的问题：off 选项藏在下拉里，用户以为默认就是 marker
//   · 底部按钮改成 取消 / 保存 右对齐

import { apiFetch, toast, friendlyError } from "./core.js";

let current = null;

const $ = (id) => document.getElementById(id);

function readEnvelope(res, what) {
  const env = res && typeof res === "object" ? res : {};
  if (env.ok === false) throw new Error(env.error || `${what}被拒绝了`);
  return env.data !== undefined ? env.data : env;
}

/**
 * 体检条：● + 一句人话 + 一句细节。
 *
 * 场景插图没有「体检」这个动作——它就是读一份配置然后立刻能知道会不会出图，
 * 所以状态条**没有动作按钮**（不像语音的「试听」或出图的「重测」）。
 *
 * 三态：
 *   is-ok    —— 已启用（会自动出图）
 *   is-bad   —— 总闸开着但模式是 off（用户可能以为没生效）
 *   （默认灰） —— 总闸关（默认状态）
 */
function setHealth(opts) {
  const el = $("scene-health");
  if (!el) return;
  const { state = "", title = "", sub = "" } = opts || {};
  el.classList.remove("is-ok", "is-bad");
  if (state === "ok") el.classList.add("is-ok");
  if (state === "bad") el.classList.add("is-bad");
  el.querySelector(".mh-title")?.replaceChildren(title);
  el.querySelector(".mh-sub")?.replaceChildren(sub);
}

/** 当前 mode：从 radio 里读 */
function getMode() {
  return document.querySelector('input[name="scene-mode"]:checked')?.value || "marker";
}

/** 设 mode：把对应 radio 打勾 */
function setMode(mode) {
  const v = mode || "marker";
  document.querySelectorAll('input[name="scene-mode"]').forEach((r) => {
    r.checked = r.value === v;
  });
  syncModeCard(v);
}

/** 让 radio 的外层 label 有 .on 类，供 CSS 上色 */
function syncModeCard(mode) {
  document.querySelectorAll('.scene-mode').forEach((label) => {
    const r = label.querySelector('input[name="scene-mode"]');
    label.classList.toggle("on", r?.checked === true);
  });
}

function fillForm(cfg) {
  current = cfg;

  // 这里原本有一句 `$("scene-enabled")?.click()`：先把复选框翻转一次，
  // 紧接着又被下一行覆盖，等于白翻；副作用是派发一次假的 change，
  // 让「打开面板」这个纯读动作带上了写的行为。删掉。
  const enabled = $("scene-enabled");
  if (enabled) enabled.checked = cfg.enabled === true;

  setMode(cfg.mode || "marker");

  const cr = $("scene-character-ref");
  if (cr) cr.checked = cfg.characterRef !== false;

  const style = $("scene-style");
  if (style) style.value = cfg.style || "";

  refreshStatus();
}

/**
 * 印出「现在到底会不会自动出图」。
 *
 * 看的是**面板当前的样子**，不是保存过的配置——用户动了勾，这行字就该
 * 立刻跟着变。以前它只在 fillForm 里印一次，于是出现「框勾着、字说未启用」
 * 这种自相矛盾：用户点了勾还没保存，字还停在旧状态。
 */
function refreshStatus() {
  const on = $("scene-enabled")?.checked === true;
  const mode = getMode();

  if (on && mode !== "off") {
    const charNote = $("scene-character-ref")?.checked !== false ? " · 用了角色外貌与性格" : " · 只用场景";
    const styleNote = $("scene-style")?.value ? ` · 风格：${$("scene-style").value}` : " · 默认水彩风";
    setHealth({
      state: "ok",
      title: "会自动出图",
      sub: `模型写 <code>[场景]</code> 时自动画一张${charNote}${styleNote}`
    });
  } else if (!on) {
    setHealth({
      title: "未启用",
      sub: `总闸关着——不会自动出图，手动补一张也不行${current?.autoTriggerReason && current.autoTriggerReason !== "总闸关" ? `（${current.autoTriggerReason}）` : ""}`
    });
  } else {
    // 总闸开着，但模式是 off——这不是「关」，是「不出自动图但你想画还能画」
    setHealth({
      state: "bad",
      title: "总闸开着，但不出自动图",
      sub: "模式是 off——手动补一张仍可用；想让模型自动画就换 marker"
    });
  }
}

export async function openScene() {
  const modal = $("scene-modal");
  if (!modal) return;
  modal.classList.remove("hidden");
  try {
    const cfg = readEnvelope(await apiFetch("illustration/config"), "读场景插图配置");
    fillForm(cfg);
  } catch (e) {
    setHealth({ state: "bad", title: "读不到配置", sub: friendlyError(e) });
  }
}

export function closeScene() {
  $("scene-modal")?.classList.add("hidden");
}

async function save() {
  const res = await apiFetch("illustration/config", {
    method: "PUT",
    body: JSON.stringify({
      enabled: $("scene-enabled")?.checked === true,
      mode: getMode(),
      characterRef: $("scene-character-ref")?.checked !== false,
      style: $("scene-style")?.value || ""
    })
  });
  const cfg = readEnvelope(res, "保存场景插图设置");
  fillForm(cfg);
  toast(
    cfg.autoTriggerActive ? "场景插图已启用" : "场景插图未启用",
    "success"
  );
  return cfg;
}

export function bindScene() {
  const modal = $("scene-modal");
  if (!modal || modal.dataset.bound === "1") return;
  modal.dataset.bound = "1";

  $("scene-close")?.addEventListener("click", closeScene);
  $("scene-cancel")?.addEventListener("click", closeScene);

  // 改了就立刻反映到状态行——别等保存。
  $("scene-enabled")?.addEventListener("change", refreshStatus);

  // mode 是 radio：每个 radio 都要挂 change，同时同步卡片视觉态
  document.querySelectorAll('input[name="scene-mode"]').forEach((r) => {
    r.addEventListener("change", () => {
      syncModeCard(r.value);
      refreshStatus();
    });
  });

  // 风格变更也影响体检条的副标题
  $("scene-style")?.addEventListener("input", refreshStatus);
  $("scene-character-ref")?.addEventListener("change", refreshStatus);

  modal.addEventListener("click", (e) => { if (e.target === modal) closeScene(); });

  $("scene-save")?.addEventListener("click", async () => {
    try { await save(); }
    catch (e) { toast("保存失败：" + friendlyError(e), "error"); }
  });
}

/** 工具抽屉里的那颗入口按钮。 */
export function bindSceneEntry() {
  const btn = $("open-scene-settings");
  if (!btn || btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", () => openScene());
}
