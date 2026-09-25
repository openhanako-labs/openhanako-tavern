// regex.js — 正则规则界面
//
// 仓储注释里那句话是这一页存在的理由：
//   「一条写错的正则能让角色说出完全不属于自己的话，而且没人会立刻发现。」
// 所以这一页不是填表页——**当场能看效果**才是主体，表单底部的「试一下」
// 是主角，不是附件。
//
// 三个作用面必须分开讲清楚，用户最容易在这里误会：
//   prompt  发请求前：改的是给模型看的，改完就发
//   display 显示时：改的是你在气泡里看到的，不动发给模型的内容
//   stored  存储时：改的是写进对话文件的那份，落盘即改后
//
// 后端：lib/regex/routes.js（CRUD + 批量导入 + 试跑）。

import { apiFetch, toast, confirmDialog, escapeHtml, extractArray, friendlyError } from "./core.js";
import { dom, showEditForm } from "./dom.js";
import { state } from "./state.js";

const SCOPE_LABEL = { global: "所有角色", character: "某角色", preset: "某预设" };
const SURFACE_LABEL = { prompt: "发请求前", display: "显示时", stored: "存储时" };

/** 作用域下拉的候选（角色 / 预设）。私密格那套「显示成 id 等于没显示」同理。 */
let scopeNames = null;

export function invalidateRegexCache() {
  scopeNames = null;
}

async function ensureScopeNames() {
  if (scopeNames) return scopeNames;
  const characters = new Map();
  const presets = new Map();
  try {
    for (const c of extractArray(await apiFetch("characters"))) {
      if (c?.id) characters.set(c.id, c.name || "（无名）");
    }
  } catch { /* 拿不到就退回显示 id */ }
  try {
    for (const p of extractArray(await apiFetch("presets"))) {
      if (p?.id) presets.set(p.id, p.name || "（无名）");
    }
  } catch { /* 同上 */ }
  scopeNames = { characters, presets };
  return scopeNames;
}

export async function loadRegexRules() {
  const listEl = dom.regexListEl;
  if (!listEl) return;
  try {
    const list = extractArray(await apiFetch("regex-rules"));
    state.regexList = list;
    await ensureScopeNames();
    renderRegexRules();
  } catch (e) {
    console.error("[Regex] load failed:", e);
    listEl.innerHTML = `<div class="empty">加载失败<br><span class="hint">${escapeHtml(friendlyError(e))}</span></div>`;
    toast("加载规则失败: " + friendlyError(e), "error");
  }
}

export function renderRegexRules() {
  const listEl = dom.regexListEl;
  if (!listEl) return;

  const list = state.regexList || [];
  const on = list.filter(r => r.disabled !== true).length;

  if (dom.regexCountEl) dom.regexCountEl.textContent = list.length ? `${on}/${list.length} 启用` : "";

  if (dom.regexNoteEl) {
    dom.regexNoteEl.textContent = list.length
      ? "从上到下按「顺序」跑。改错一条能让角色说出不属于自己的话，先用「试一下」看一眼。"
      : "";
  }

  if (list.length === 0) {
    listEl.innerHTML = '<div class="empty">还没有规则<br><span class="hint">规则改的是文本：把旁白去掉、把某个词换掉、给台词加格式</span></div>';
    return;
  }

  listEl.innerHTML = list.map(rule => {
    const scope = SCOPE_LABEL[rule.scope] || "所有角色";
    const scopeName = rule.scopeId
      ? (rule.scope === "character" ? scopeNames?.characters.get(rule.scopeId) : scopeNames?.presets.get(rule.scopeId))
      : null;
    const surfaces = (Array.isArray(rule.surfaces) && rule.surfaces.length ? rule.surfaces : ["prompt"])
      .map(s => SURFACE_LABEL[s] || s);
    const off = rule.disabled === true;

    return `<div class="regex-card${off ? " off" : ""}" data-id="${escapeHtml(rule.id)}">
      <div class="rc-head">
        <span class="rc-name">${escapeHtml(rule.name || "（无名）")}</span>
        <span class="rc-order">#${Number(rule.order) || 0}</span>
      </div>
      <div class="rc-pattern"><code>/${escapeHtml(rule.pattern || "")}/${escapeHtml(rule.flags || "g")}</code>
        <span class="rc-arrow">→</span>
        <code>${rule.replacement ? escapeHtml(rule.replacement) : '<span class="rc-empty">（删掉）</span>'}</code>
      </div>
      <div class="chip-row">
        <span class="chip">${escapeHtml(scope)}${scopeName ? " · " + escapeHtml(scopeName) : ""}</span>
        ${surfaces.map(s => `<span class="chip">${escapeHtml(s)}</span>`).join("")}
        ${off ? '<span class="chip private">已关</span>' : ""}
      </div>
      <div class="row-acts">
        <button class="mini" data-act="toggle">${off ? "启用" : "关掉"}</button>
        <button class="mini" data-act="edit">编辑</button>
        <button class="mini danger" data-act="delete">删除</button>
      </div>
    </div>`;
  }).join("");

  listEl.querySelectorAll(".regex-card").forEach(node => {
    const id = node.dataset.id;
    node.querySelector('[data-act="toggle"]')?.addEventListener("click", () => toggleRegexRule(id));
    node.querySelector('[data-act="edit"]')?.addEventListener("click", () => openRegexEditor(id));
    node.querySelector('[data-act="delete"]')?.addEventListener("click", () => deleteRegexRule(id));
  });
}

function findRule(id) {
  return (state.regexList || []).find(r => r.id === id) || null;
}

/** 开关。PATCH 收的是 enabled（正的语义），仓储内部存 disabled。 */
export async function toggleRegexRule(id) {
  const rule = findRule(id);
  if (!rule) return;
  try {
    await apiFetch(`regex-rules/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: rule.disabled === true })
    });
    await loadRegexRules();
  } catch (e) {
    toast("切换失败: " + friendlyError(e), "error");
  }
}

export async function openRegexEditor(id) {
  try {
    const rule = id ? findRule(id) : null;
    state.currentRegexRule = rule || {
      id: null, name: "", pattern: "", replacement: "", flags: "g",
      scope: "global", scopeId: null, surfaces: ["prompt"],
      runOnEdit: false, order: 0, disabled: false
    };
    state.currentForm = "regex";
    await fillRegexForm(state.currentRegexRule);
    showEditForm("regex");   // 不显示自己那张表单，弹窗就是个空壳
    dom.modalEl?.classList.remove("hidden");
  } catch (e) {
    toast("打开失败: " + friendlyError(e), "error");
  }
}

async function fillRegexForm(rule) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ""; };

  set("rf-id", rule.id || "");
  set("rf-name", rule.name || "");
  set("rf-pattern", rule.pattern || "");
  set("rf-replacement", rule.replacement || "");
  set("rf-flags", rule.flags || "g");
  set("rf-order", Number.isFinite(Number(rule.order)) ? Number(rule.order) : 0);
  set("rf-scope", rule.scope || "global");

  const surfaces = Array.isArray(rule.surfaces) && rule.surfaces.length ? rule.surfaces : ["prompt"];
  for (const s of ["prompt", "display", "stored"]) {
    const el = document.getElementById(`rf-surface-${s}`);
    if (el) el.checked = surfaces.includes(s);
  }

  const en = document.getElementById("rf-enabled");
  if (en) en.checked = rule.disabled !== true;

  // 试跑结果是上一次的，换一条规则就清掉——留着会让人以为是这一条的
  const out = document.getElementById("rf-test-output");
  if (out) { out.classList.add("hidden"); out.innerHTML = ""; }

  await syncRegexFields(rule.scopeId || null);
}

/** 作用域两个下拉：选「只有某个角色/某套预设」时才填第二个。 */
export async function syncRegexFields(preselectId = null) {
  const scope = document.getElementById("rf-scope")?.value || "global";
  const needId = scope === "character" || scope === "preset";
  document.getElementById("rf-scope-id-field")?.classList.toggle("hidden", !needId);
  if (!needId) return;

  const sel = document.getElementById("rf-scope-id");
  if (!sel) return;

  await ensureScopeNames();
  const map = scope === "character" ? scopeNames.characters : scopeNames.presets;
  const none = scope === "character" ? "（还没有角色卡）" : "（还没有预设）";
  const opts = [...map.entries()].map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join("");
  sel.innerHTML = opts || `<option value="">${none}</option>`;
  if (preselectId) sel.value = preselectId;
}

export async function saveRegexRule() {
  const rule = state.currentRegexRule;
  if (!rule) return;
  const val = (id) => document.getElementById(id)?.value ?? "";

  const name = val("rf-name").trim();
  if (!name) { toast("名称不能为空", "error"); return; }

  const pattern = val("rf-pattern").trim();
  if (!pattern) { toast("查找正则为空——空正则会匹配任何位置，不能发出去", "error"); return; }

  const scope = val("rf-scope") || "global";
  const scopeId = scope === "global" ? null : (val("rf-scope-id") || null);
  if (scope !== "global" && !scopeId) {
    toast("选了限定范围却没指定对象——这条规则永远不会生效", "error");
    return;
  }

  const surfaces = ["prompt", "display", "stored"]
    .filter(s => document.getElementById(`rf-surface-${s}`)?.checked);
  if (surfaces.length === 0) {
    toast("至少要勾一个作用面，否则这条规则什么也不做", "error");
    return;
  }

  const payload = {
    name,
    pattern,
    replacement: val("rf-replacement"),
    flags: val("rf-flags") || "g",
    scope,
    scopeId,
    surfaces,
    disabled: document.getElementById("rf-enabled")?.checked !== true,
    order: Number(val("rf-order")) || 0
  };

  try {
    if (rule.id) {
      await apiFetch(`regex-rules/${encodeURIComponent(rule.id)}`, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      await apiFetch("regex-rules", { method: "POST", body: JSON.stringify(payload) });
    }
    state.currentRegexRule = null;
    state.currentForm = null;
    dom.modalEl?.classList.add("hidden");
    await loadRegexRules();
    toast("已保存", "success");
  } catch (e) {
    // 仓储在保存时就编译一次，坏正则会原样把引擎的报错抛回来
    toast("保存失败: " + friendlyError(e), "error");
  }
}

export async function deleteRegexRule(id) {
  const rule = findRule(id);
  const ok = await confirmDialog(`删掉规则「${rule?.name || "这一条"}」？`);
  if (!ok) return;
  try {
    await apiFetch(`regex-rules/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadRegexRules();
    toast("已删除", "success");
  } catch (e) {
    toast("删除失败: " + friendlyError(e), "error");
  }
}

/**
 * 试跑。
 *
 * 表单里填了一半也能跑——把当前表单值当**草稿**发过去，
 * 不落盘。想知道「这条会不会毁掉台词」，不该先保存再说。
 */
export async function testRegexRule() {
  const out = document.getElementById("rf-test-output");
  const val = (id) => document.getElementById(id)?.value ?? "";

  const text = val("rf-test-input");
  if (!text.trim()) { toast("先填一段要试的文本", "error"); return; }

  const draft = {
    name: val("rf-name").trim() || "（草稿）",
    pattern: val("rf-pattern").trim(),
    replacement: val("rf-replacement"),
    flags: val("rf-flags") || "g",
    scope: val("rf-scope") || "global",
    scopeId: val("rf-scope-id") || null,
    surfaces: ["prompt", "display", "stored"].filter(s => document.getElementById(`rf-surface-${s}`)?.checked),
    disabled: false,
    order: Number(val("rf-order")) || 0
  };

  if (!draft.pattern) { toast("查找正则为空", "error"); return; }

  if (out) {
    out.classList.remove("hidden");
    out.innerHTML = '<div class="t-hint">跑一遍…</div>';
  }

  try {
    const res = await apiFetch("regex-rules/test", {
      method: "POST",
      body: JSON.stringify({
        text,
        rule: draft,
        characterId: state.currentConv?.characterId || null
      })
    });
    const d = res?.data || res;
    if (!out) return;
    out.innerHTML = `
      <div class="t-line"><span class="t-k">命中</span><span class="t-v">${d.applied?.length ? escapeHtml(d.applied.join(" / ")) : "（无）"}</span></div>
      ${d.failed?.length ? `<div class="t-line"><span class="t-k">编译失败</span><span class="t-v">${escapeHtml(d.failed.join(" / "))}</span></div>` : ""}
      <div class="t-line"><span class="t-k">替换后</span><span class="t-v">${d.changed ? "有变化" : "没有变化"}</span></div>
      <div class="t-be">${escapeHtml(d.after) || '<span class="hint">（空了）</span>'}</div>
      ${d.hint ? `<div class="t-hint">${escapeHtml(d.hint)}</div>` : ""}
    `;
  } catch (e) {
    if (out) out.innerHTML = `<div class="t-hint">试跑失败：${escapeHtml(friendlyError(e))}</div>`;
  }
}

export function bindRegex() {
  document.getElementById("create-regex-btn")?.addEventListener("click", () => openRegexEditor(null));
  document.getElementById("refresh-regex-btn")?.addEventListener("click", loadRegexRules);
  document.getElementById("rf-scope")?.addEventListener("change", () => syncRegexFields(null));
  document.getElementById("rf-test-btn")?.addEventListener("click", testRegexRule);
}
