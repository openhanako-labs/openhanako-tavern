// models.js — 模型按用途分选的设置面板
//
// 两个职责，一个模块：
//   · 体检条：目录拉得到 / 拉不到；有多少个候选
//   · 编辑：全局默认 + 每用途二态（跟随 / 指定）
//
// 与 TTS 面板同一个模态语言：顶部体检、下面分区。
// 但**这个面板没有"试听"**——模型不会说话；体检的意义就是「我选的这格真的
// 存在于目录里吗」，下拉里的每一条就是从目录里来的，天然不假。
//
// 向量那格只读。lib/embed 自管自己的模型（bus + 凭据），这里不接管；
// 但**用户在填了 chat 模型之后**会想知道向量现在用的是哪家，所以我们
// 从 /embed/status 拉一次显示出来。改它回向量自己的面板。

import { apiFetch, toast, escapeHtml, friendlyError } from "./core.js";

const $ = (id) => document.getElementById(id);

let targets = [];        // GET /models 拿到的 chat 候选
let config = null;      // GET /models/config 拿到的当前配置
let embedding = null;   // /embed/status 结果（只读展示用）

/** 拆信封。服务端 ok:false 时抛错，不吞。 */
function readEnvelope(res, what) {
  const env = res && typeof res === "object" ? res : {};
  if (env.ok === false) throw new Error(env.error || `${what}被拒绝了`);
  return env.data !== undefined ? env.data : env;
}

/**
 * 拉目录 + 配置 + 向量状态，把面板铺出来。
 *
 * 三条请求并行——面板打开时能一次看到全部真相，而不是分三次转圈。
 */
export async function loadModels() {
  const [modelsRes, cfgRes, embedRes] = await Promise.all([
    apiFetch("models").catch(() => ({ ok: false, error: "models 目录未就绪" })),
    apiFetch("models/config").catch(() => ({ ok: false, error: "模型配置未就绪" })),
    apiFetch("embed/status").catch(() => ({ ok: false, error: "embed 未就绪" }))
  ]);

  try {
    const models = readEnvelope(modelsRes, "模型列表");
    targets = Array.isArray(models?.targets) ? models.targets : [];
  } catch (e) {
    toast(`模型列表：${friendlyError(e)}`, "error");
    targets = [];
  }

  try {
    config = readEnvelope(cfgRes, "模型配置");
  } catch (e) {
    toast(`模型配置：${friendlyError(e)}`, "error");
    config = null;
  }

  try {
    embedding = readEnvelope(embedRes, "向量状态") || null;
  } catch {
    embedding = null;
  }

  renderHealth();
  renderDefault();
  renderPurposes();
  renderEmbedding();
}

/** 顶部体检条：目录拉得到吗？有多少候选？ */
function renderHealth() {
  const el = $("models-health");
  if (!el) return;
  const ok = targets.length > 0;
  el.querySelector(".mh-dot").style.background = ok ? "#5ac877" : "#e56a6a";
  el.querySelector(".mh-title").textContent = ok ? `目录里有 ${targets.length} 个模型` : "拉不到宿主模型目录";
  el.querySelector(".mh-sub").textContent = ok
    ? "下拉里的每一条都是从目录里来的，选了就生效"
    : "配置能保存，但保存后不生效——重启宿主或检查模型授权";
}

/** 把模型列表铺成 <option>。留一条空值 = 跟随宿主目录默认。 */
function optionHtml(target, selected) {
  const key = `${target.provider} :: ${target.model}`;
  const sel = selected ? " selected" : "";
  return `<option value="${escapeHtml(key)}"${sel}>${escapeHtml(target.provider)} / ${escapeHtml(target.model)}</option>`;
}

function selectedKey(select) {
  return select?.value && select.value !== "" ? select.value : null;
}

function keyOfTarget(t) {
  return t ? `${t.provider} :: ${t.model}` : null;
}

/** 全局默认下拉：空 = 完全走宿主目录默认。 */
function renderDefault() {
  const sel = $("models-default");
  if (!sel) return;
  const cur = keyOfTarget(config?.default);
  sel.innerHTML = `<option value="">跟随宿主目录默认</option>`
    + targets.map(t => optionHtml(t, keyOfTarget(t) === cur)).join("");
  if (cur) sel.value = cur;
}

/** 按用途渲染：每行一个「跟随 / 指定」二态下拉。 */
function renderPurposes() {
  const host = $("models-purposes");
  if (!host) return;
  const purposes = Array.isArray(config?.purposes) ? config.purposes : [];
  if (purposes.length === 0) {
    host.innerHTML = `<div class="hint">拉不到用途配置——保存后不生效</div>`;
    return;
  }

  host.innerHTML = purposes.map(p => {
    const eff = keyOfTarget(p.effectiveTarget);
    const isTarget = p.mode === "target" && p.target;
    const isDefault = p.mode === "default";
    const stateNote = isTarget
      ? `本项指定：${escapeHtml(p.target.provider)} / ${escapeHtml(p.target.model)}`
      : (eff
          ? `跟随默认 → ${escapeHtml(keyOfTarget(config?.default)?.split(" :: ")[1] || "目录默认")}`
          : "跟随默认 → 目录默认");

    // 向量那格不铺下拉：lib/embed 自管，改了也没用
    const disabled = p.id === "embed";

    const optDefault = `<option value="default"${isDefault ? " selected" : ""}>跟随默认</option>`;
    const optTargets = targets.map(t => {
      const k = `${t.provider} :: ${t.model}`;
      const sel = isTarget && keyOfTarget(p.target) === k;
      return `<option value="${escapeHtml(k)}"${sel ? " selected" : ""}>${escapeHtml(t.provider)} / ${escapeHtml(t.model)}</option>`;
    }).join("");

    return `<div class="model-purpose">
      <div class="mp-head">
        <div class="mp-title">${escapeHtml(p.label || p.id)}<span class="mp-id">${escapeHtml(p.id)}</span></div>
        <div class="mp-note">${escapeHtml(p.note || "")}</div>
      </div>
      <div class="field" style="margin-bottom:0">
        <select data-purpose="${escapeHtml(p.id)}"${disabled ? " disabled" : ""}>
          ${optDefault}
          ${optTargets}
        </select>
      </div>
      <div class="mp-state${disabled ? ' is-readonly' : ''}">${escapeHtml(stateNote)}</div>
    </div>`;
  }).join("");
}

/** 向量：从 /embed/status 拿当前 provider/model。 */
function renderEmbedding() {
  const el = $("models-embed-status");
  if (!el) return;
  if (!embedding) {
    el.innerHTML = `<span class="hint">拉不到向量状态——lib/embed 未就绪</span>`;
    return;
  }
  if (embedding.ok && embedding.model) {
    el.innerHTML = `
      <div class="mh-text" style="margin:0">
        <div class="mh-title">现在用的是 <code>${escapeHtml(embedding.model || "?")}</code></div>
        <div class="mh-sub">provider：<code>${escapeHtml(embedding.providerId || "?")}</code> · 候选 ${embedding.candidates || 0} 个 · ${escapeHtml(embedding.foundBy || "")}</div>
      </div>`;
  } else {
    el.innerHTML = `<div class="mh-text" style="margin:0">
      <div class="mh-title">向量当前不可用</div>
      <div class="mh-sub">${escapeHtml(embedding.note || "没有 embedding 模型")}</div>
    </div>`;
  }
}

/** 把面板里所有下拉收回来，拼一份 patch 交给后端。 */
function collectPatch() {
  const patch = {};
  const d = selectedKey($("models-default"));
  patch.default = d ? parseKey(d) : null;

  for (const sel of document.querySelectorAll("#models-purposes select[data-purpose]")) {
    const p = sel.dataset.purpose;
    const v = sel.value;
    if (!v || v === "default") {
      patch[p] = "default";
    } else {
      patch[p] = parseKey(v);
    }
  }
  return patch;
}

function parseKey(key) {
  // 值格式：`provider :: model`。provider/model 各自只允许 ASCII 标识符，
  // 分隔符"::"不会在真实字段里出现，所以 split 一次就够了。
  const sep = " :: ";
  const i = key.indexOf(sep);
  if (i < 0) return null;
  return {
    provider: key.slice(0, i),
    model: key.slice(i + sep.length)
  };
}

/** 保存。空 patch 也提交——用户点保存就该得到确认，不静默。 */
export async function saveModels() {
  const patch = collectPatch();
  const res = await apiFetch("models/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch)
  });
  try {
    config = readEnvelope(res, "保存模型配置");
    toast("已保存 · 下一次生成即刻生效", "success");
    renderDefault();
    renderPurposes();
  } catch (e) {
    toast(`保存失败：${friendlyError(e)}`, "error");
  }
}

/** 打开面板。幂等：已开就只做一次拉数据。 */
export async function openModels() {
  const modal = $("models-modal");
  if (!modal) return;
  modal.classList.remove("hidden");
  try { await loadModels(); } catch (e) {
    console.error("[Models] load failed:", e);
  }
}

export function closeModels() {
  $("models-modal")?.classList.add("hidden");
}

/**
 * 绑定按钮 + 遮罩点击关闭。
 * 幂等——同一颗按钮只绑一次；数据集标记避免第二次打开时重复。
 */
export function bindModels() {
  const modal = $("models-modal");
  if (!modal || modal.dataset.bound === "1") return;
  modal.dataset.bound = "1";

  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModels();
  });
  $("models-close")?.addEventListener("click", closeModels);
  $("models-cancel")?.addEventListener("click", closeModels);
  $("models-save")?.addEventListener("click", saveModels);
  $("models-relist")?.addEventListener("click", () => {
    // 强制重拉目录：先清掉缓存，再拉一次
    apiFetch("models?force=1").then(() => loadModels());
  });

  // 下拉变动的即时反馈：把「现在用的是谁」写回那行状态条。
  // 不重绘整块（重绘会丢用户刚改过的其他下拉）。
  document.addEventListener("change", (e) => {
    const sel = e.target;
    if (!sel || !sel.matches("#models-purposes select[data-purpose]")) return;
    const wrap = sel.closest(".model-purpose");
    const state = wrap?.querySelector(".mp-state");
    if (!state) return;
    const v = sel.value;
    if (!v || v === "default") {
      const eff = keyOfTarget(config?.default);
      state.textContent = eff
        ? `跟随默认 → ${eff.split(" :: ")[1]}`
        : "跟随默认 → 目录默认";
    } else {
      state.textContent = `本项指定：${v.replace(" :: ", " / ")}`;
    }
  });
}
