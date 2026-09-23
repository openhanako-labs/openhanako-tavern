// variables.js — 变量界面逻辑
//
// 变量分两类：定义（叫什么、什么类型、默认值）与值（某对话/全局的实际内容）。
// 界面只编辑定义；值在对话里随对话走，这里提供「测试替换」预览当前生效值。
//
// 后端：lib/variables/routes.js。

import { apiFetch, toast, confirmDialog, escapeHtml, extractArray, friendlyError } from "./core.js";
import { dom } from "./dom.js";
import { state } from "./state.js";

const TYPES = ["string", "number", "boolean", "object", "array"];

/** 拉定义列表并渲染。 */
export async function loadVariables() {
  try {
    const res = await apiFetch("variables");
    const list = extractArray(res);
    state.variableList = list;
    renderVariables(list);
  } catch (e) {
    console.error("[Variables] load failed:", e);
    toast("加载失败: " + friendlyError(e), "error");
  }
}

/** 渲染定义列表。 */
export function renderVariables(list) {
  if (!dom.variablesListEl) return;
  const arr = Array.isArray(list) ? list : [];

  if (dom.variablesCountEl) {
    dom.variablesCountEl.textContent = arr.length > 0 ? `${arr.length} 个` : "";
  }
  if (arr.length === 0) {
    dom.variablesListEl.innerHTML =
      '<div class="empty">暂无变量<br><span class="hint">变量可在对话中被宏读写</span></div>';
    return;
  }

  dom.variablesListEl.innerHTML = arr.map(v => `<div class="var-card" data-id="${escapeHtml(v.id)}">
      <div class="var-head">
        <code class="vf-name">${escapeHtml(v.name)}</code>
        <span class="vf-type">${escapeHtml(v.type || "string")}</span>
      </div>
      <div class="vf-description">${escapeHtml(v.description || "")}</div>
      <div class="var-meta">
        <span class="scope">${escapeHtml(v.scope || "conversation")}</span>
        ${v.hidden ? '<span class="flag">对模型隐藏</span>' : ""}
      </div>
      <div class="var-actions">
        <button class="mini" data-act="edit">编辑</button>
        <button class="mini danger" data-act="delete">删除</button>
      </div>
    </div>`).join("");

  dom.variablesListEl.querySelectorAll(".var-card").forEach(card => {
    const id = card.dataset.id;
    card.querySelector('[data-act="edit"]')?.addEventListener("click", () => openVariableEditor(id));
    card.querySelector('[data-act="delete"]')?.addEventListener("click", () => deleteVariable(id));
  });
}

/** 打开编辑器；id 为空 → 新建。 */
export async function openVariableEditor(id) {
  try {
    if (id) {
      const res = await apiFetch(`variables/${encodeURIComponent(id)}`);
      state.currentVariable = res.data || res;
    } else {
      state.currentVariable = {
        id: null, name: "", type: "string", description: "",
        scope: "conversation", defaultValue: null, hidden: false
      };
    }
    state.currentForm = "variable";
    fillVariableForm(state.currentVariable);
    dom.modalEl?.classList.remove("hidden");
  } catch (e) {
    toast("打开失败: " + friendlyError(e), "error");
  }
}

function fillVariableForm(v) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ""; };
  set("vf-name", v.name || "");
  set("vf-type", v.type || "string");
  set("vf-description", v.description || "");
  set("vf-scope", v.scope || "conversation");
  set("vf-default", v.defaultValue == null ? "" : String(v.defaultValue));
  const hid = document.getElementById("vf-visible");
  if (hid) hid.checked = v.hidden === true;
}

/** 保存定义。 */
export async function saveVariable() {
  const v = state.currentVariable;
  if (!v) return;
  const val = (id) => document.getElementById(id)?.value ?? "";

  const name = val("vf-name").trim();
  if (!name) { toast("变量名不能为空", "error"); return; }
  if (!/^[A-Za-z_][\w]*$/.test(name)) {
    toast("变量名只能是字母/数字/下划线，且不以数字开头", "error");
    return;
  }

  const type = val("vf-type") || "string";
  let def = val("vf-default");
  if (def !== "") {
    // 按类型收窄，避免把 "3" 当数字还是字符串搞混
    if (type === "number") { const n = Number(def); if (!Number.isFinite(n)) { toast("默认值不是合法数字", "error"); return; } def = n; }
    else if (type === "boolean") def = (def === "true" || def === "1");
    else if (type === "object" || type === "array") {
      try { def = JSON.parse(def); } catch { toast("默认值不是合法 JSON", "error"); return; }
    }
  }

  const body = {
    name,
    type,
    description: val("vf-description"),
    scope: val("vf-scope") || "conversation",
    defaultValue: def,
    hidden: document.getElementById("vf-visible")?.checked === true
  };

  try {
    if (v.id) await apiFetch(`variables/${encodeURIComponent(v.id)}`, { method: "PUT", body: JSON.stringify(body) });
    else await apiFetch("variables", { method: "POST", body: JSON.stringify(body) });

    state.currentVariable = null;
    state.currentForm = null;
    dom.modalEl?.classList.add("hidden");
    await loadVariables();
    toast("已保存", "success");
  } catch (e) {
    toast("保存失败: " + friendlyError(e), "error");
  }
}

/** 删除定义。删了之后引用它的宏会原样保留（不吃内容）。 */
export async function deleteVariable(id) {
  const ok = await confirmDialog("删除这个变量定义？已写入的值不会被清除，但宏将读不到它。");
  if (!ok) return;
  try {
    await apiFetch(`variables/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadVariables();
    toast("已删除", "success");
  } catch (e) {
    toast("删除失败: " + friendlyError(e), "error");
  }
}

export function handleVariableAction(action, id) {
  if (action === "edit") openVariableEditor(id);
  else if (action === "delete") deleteVariable(id);
}

/**
 * 测试替换：拿一段文本跑一遍宏，看变量是否正确展开。
 * 对排查「宏没生效」很有用——一眼看出是名字写错还是值没存上。
 */
export async function testReplace() {
  const el = document.getElementById("vf-test-input");
  const out = document.getElementById("vf-test-output");
  const text = el?.value ?? "";
  if (!text.trim()) { toast("先输入要测试的文本", "error"); return; }
  if (!out) return;

  try {
    const res = await apiFetch("variables/test-replace", {
      method: "POST",
      body: JSON.stringify({ text })
    });
    const data = res.data || res;
    out.textContent = data.result ?? data.text ?? "";
  } catch (e) {
    out.textContent = "失败: " + friendlyError(e);
  }
}
