// settings.js — 设定库（世界书）界面逻辑
//
// 职责：拉列表、渲染、开关、增删改、从 SillyTavern 导入世界书。
// 与角色卡一样是「列表 + 编辑器」两段式；编辑器字段较多
// （trigger / characterFilter / anchor），单独有 updateTriggerFields 联动。
//
// 后端：lib/settings/routes.js，端点见该文件。

import { apiFetch, toast, confirmDialog, escapeHtml, extractArray, friendlyError } from "./core.js";
import { dom, showEditForm } from "./dom.js";
import { state } from "./state.js";

/** 拉列表并渲染。 */
export async function loadSettings() {
  try {
    const res = await apiFetch("settings");
    const list = extractArray(res);
    state.settingList = list;
    renderSettings(list);
  } catch (e) {
    console.error("[Settings] load failed:", e);
    toast("加载失败: " + friendlyError(e), "error");
  }
}

/** 渲染列表。tier 决定底色分组，与后端 groupByAnchor 的顺序对齐。 */
export function renderSettings(list) {
  if (!dom.settingsListEl) return;
  const arr = Array.isArray(list) ? list : [];

  if (dom.settingsCountEl) {
    dom.settingsCountEl.textContent = arr.length > 0 ? `${arr.length} 条` : "";
  }

  if (arr.length === 0) {
    dom.settingsListEl.innerHTML =
      '<div class="empty">暂无设定<br><span class="hint">可新建，或从 ST 世界书导入</span></div>';
    return;
  }

  dom.settingsListEl.innerHTML = arr.map(s => {
    const tier = s.tier || "core";
    const on = s.enabled !== false;
    return `<div class="setting-card tier-${escapeHtml(tier)}${on ? "" : " off"}" data-id="${escapeHtml(s.id)}">
      <div class="setting-head">
        <h4>${escapeHtml(s.comment || s.name || "（无标题）")}</h4>
        <label class="switch" title="启用/停用">
          <input type="checkbox" data-act="toggle" ${on ? "checked" : ""}>
          <span></span>
        </label>
      </div>
      <div class="setting-body">${escapeHtml(String(s.content || "").slice(0, 160))}</div>
      <div class="setting-meta">
        <span class="tier">${escapeHtml(tier)}</span>
        <span class="kw">${(s.keywords || []).map(escapeHtml).join("、") || "常驻"}</span>
        ${s.anchor ? `<span class="anchor">@${escapeHtml(s.anchor)}</span>` : ""}
      </div>
      <div class="setting-actions">
        <button class="mini" data-act="edit">编辑</button>
        <button class="mini danger" data-act="delete">删除</button>
      </div>
    </div>`;
  }).join("");

  dom.settingsListEl.querySelectorAll(".setting-card").forEach(card => {
    const id = card.dataset.id;
    card.querySelector('[data-act="toggle"]')?.addEventListener("change", (e) => {
      toggleSetting(id, e.target.checked);
    });
    card.querySelector('[data-act="edit"]')?.addEventListener("click", () => openSettingEditor(id));
    card.querySelector('[data-act="delete"]')?.addEventListener("click", () => deleteSetting(id));
  });
}

/** 打开编辑器。id 为空 → 新建。 */
export async function openSettingEditor(id) {
  try {
    if (id) {
      const res = await apiFetch(`settings/${encodeURIComponent(id)}`);
      state.currentSetting = res.data || res;
    } else {
      state.currentSetting = {
        id: null,
        comment: "",
        content: "",
        keywords: [],
        secondaryKeys: [],
        selectiveLogic: "and_any",
        anchor: "",
        tier: "core",
        enabled: true,
        order: 100,
        priority: 100,
        probability: 100,
        characterFilter: []
      };
    }
    state.currentForm = "setting";
    fillSettingForm(state.currentSetting);
    showEditForm("setting");   // 不显示自己那张表单，弹窗就是个空壳
    dom.modalEl?.classList.remove("hidden");
  } catch (e) {
    toast("打开失败: " + friendlyError(e), "error");
  }
}

/** 把条目填进表单。 */
function fillSettingForm(s) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ""; };
  set("sf-name", s.comment || "");
  set("sf-content", s.content || "");
  set("sf-keywords", (s.keywords || []).join(", "));
  set("sf-secondary-keys", (s.secondaryKeys || []).join(", "));
  set("sf-trigger-type", s.anchor || "");
  set("sf-tier", s.tier || "core");
  set("sf-order", s.order ?? 100);
  set("sf-priority", s.priority ?? 100);
  set("sf-probability", s.probability ?? 100);
  const en = document.getElementById("sf-enabled");
  if (en) en.checked = s.enabled !== false;
  updateTriggerFields(String(s.tier || "core"));
}

/** 保存（新建或更新）。 */
export async function saveSetting() {
  const s = state.currentSetting;
  if (!s) return;
  const val = (id) => document.getElementById(id)?.value ?? "";

  const body = {
    selectiveLogic: state.currentSetting?.selectiveLogic || "and_any",
    comment: val("sf-name").trim(),
    content: val("sf-content"),
    keywords: val("sf-keywords").split(/[,，]/).map(x => x.trim()).filter(Boolean),
    secondaryKeys: val("sf-secondary-keys").split(/[,，]/).map(x => x.trim()).filter(Boolean),
    anchor: val("sf-trigger-type").trim(),
    tier: val("sf-tier") || "core",
    order: Number(val("sf-order")) || 100,
    priority: Number(val("sf-priority")) || 100,
    probability: Number(val("sf-probability")) || 100,
    enabled: document.getElementById("sf-enabled")?.checked !== false
  };
  if (!body.content.trim()) { toast("内容不能为空", "error"); return; }

  try {
    if (s.id) await apiFetch(`settings/${encodeURIComponent(s.id)}`, { method: "PUT", body: JSON.stringify(body) });
    else await apiFetch("settings", { method: "POST", body: JSON.stringify(body) });

    state.currentSetting = null;
    state.currentForm = null;
    dom.modalEl?.classList.add("hidden");
    await loadSettings();
    toast("已保存", "success");
  } catch (e) {
    toast("保存失败: " + friendlyError(e), "error");
  }
}

/** 删除（有确认，删了不可恢复）。 */
export async function deleteSetting(id) {
  const ok = await confirmDialog(`删除这条设定？此操作不可恢复。`);
  if (!ok) return;
  try {
    await apiFetch(`settings/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadSettings();
    toast("已删除", "success");
  } catch (e) {
    toast("删除失败: " + friendlyError(e), "error");
  }
}

/** 开关。 */
export async function toggleSetting(id, on) {
  try {
    await apiFetch(`settings/${encodeURIComponent(id)}/toggle`, {
      method: "PUT",
      body: JSON.stringify({ enabled: on === true })
    });
  } catch (e) {
    toast("切换失败: " + friendlyError(e), "error");
    await loadSettings(); // 回滚视图
  }
}

/** 列表项的动作分派（事件委托用）。 */
export function handleSettingAction(action, id) {
  if (action === "edit") openSettingEditor(id);
  else if (action === "delete") deleteSetting(id);
  else if (action === "toggle") toggleSetting(id, true);
}

/** 从文件选择器导入 ST 世界书。 */
export async function importSTWorldBook() {
  dom.stImportInput?.click();
}

/** 文件选中的处理。 */
export async function handleSTImport(e) {
  const files = e?.target?.files;
  if (!files || files.length === 0) return;

  const formData = new FormData();
  for (const f of files) formData.append("files", f);

  try {
    const res = await apiFetch("settings/import-st", { method: "POST", body: formData });
    const data = res.data || res;
    toast(`导入完成：新增 ${data.added ?? 0}、更新 ${data.updated ?? 0}`, "success");
    await loadSettings();
  } catch (err) {
    toast("导入失败: " + friendlyError(err), "error");
  } finally {
    e.target.value = ""; // 允许再次选同一个文件
  }
}

/**
 * tier 变了就联动 trigger 区域。
 *
 * archived / background 下 delay 与 sticky 才有意义，常驻 core 隐藏它们——
 * 不是所有字段对所有 tier 都适用，全摆出来会让人以为必须填。
 */
export function updateTriggerFields(tier) {
  const t = String(tier || "core");
  const show = (id, on) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.closest(".field")?.classList.toggle("hidden", !on);
  };
  show("sf-trigger-type", true);
  show("sf-order", t !== "core");
  show("sf-priority", true);
  show("sf-probability", true);
}
