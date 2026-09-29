// ops.js — 操作与结算（C2）UI
//
// 与「黑板」/「图鉴」的分工：
//   · 黑板 = 此刻的世界记录（激活条件、可见性）
//   · 图鉴 = 世界里存在的人 / 地点 / 势力（累计）
//   · 操作 = 能推哪些变量（清单 + 待执行项）
//
// 后端：lib/ops/routes.js。契约 { ok, data } / { ok:false, error }。

import { state } from "./state.js";
import { apiFetch, toast, confirmDialog, escapeHtml, unwrap, friendlyError } from "./core.js";

const $ = (id) => document.getElementById(id);

let all = [];        // 操作清单（世界级）
let pending = [];    // 待执行项（对话级）
let editingId = null;  // 正在编辑的 op.id；null = 新建

// ── 加载 ─────────────────────────────────────────────

export async function loadOps() {
  const [r1, r2] = await Promise.all([
    apiFetch("ops").catch(() => null),
    state.currentConv?.id
      ? apiFetch(`ops/pending?conversationId=${encodeURIComponent(state.currentConv.id)}`).catch(() => null)
      : Promise.resolve(null)
  ]);
  all = unwrap(r1) || [];
  pending = unwrap(r2) || [];
  renderOps();
  renderPending();
}

// ── 清单渲染 ─────────────────────────────────────────

export function renderOps() {
  const box = $("ops-list");
  const n = $("ops-count");
  if (!box) return;
  if (n) n.textContent = all.length ? `${all.length} 条` : "";

  if (!all.length) {
    box.innerHTML = `<div class="empty">还没有可执行操作。<br><span class="hint">「攻击」消耗「体力」、「施法」消耗「法力」——先把规则定下来，模型才知道怎么写 [结算]。</span></div>`;
    return;
  }

  box.innerHTML = all.slice().sort((a, b) =>
    String(a?.name || "").localeCompare(String(b?.name || ""))
  ).map(renderOpItem).join("");

  if (!box.dataset.bound) {
    box.dataset.bound = "1";
    box.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      e.stopPropagation();
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      if (act === "edit") openEditor(id);
      else if (act === "del") deleteOp(id);
      else if (act === "add") addPendingFor(id);
    });
  }
}

function renderOpItem(op) {
  const isEditing = editingId === op.id;
  const cost = op.costVar
    ? `<span class="ops-cost" title="结算时消耗这个变量">扣 ${escapeHtml(op.costVar)}</span>`
    : `<span class="ops-cost ops-cost-none">无消耗</span>`;
  const tagHtml = Array.isArray(op.tags) && op.tags.length
    ? `<span class="ops-tags">${op.tags.map(t => `<span class="ops-tag">${escapeHtml(t)}</span>`).join("")}</span>`
    : "";

  const body = isEditing
    ? `<form class="ops-edit-form" data-edit-id="${escapeHtml(op.id)}" onsubmit="return false">
         <input id="ops-edit-name" type="text" value="${escapeHtml(op.name || "")}" placeholder="名称" required>
         <input id="ops-edit-cost" type="text" value="${escapeHtml(op.costVar || "")}" placeholder="消耗变量（可空）">
         <textarea id="ops-edit-summary" rows="2" placeholder="简述">${escapeHtml(op.summary || "")}</textarea>
         <input id="ops-edit-tags" type="text" value="${escapeHtml((op.tags || []).join(", "))}" placeholder="标签（逗号分隔）">
         <div class="ops-edit-acts">
           <button type="button" class="btn btn-primary btn-sm" data-act="save-edit" data-id="${escapeHtml(op.id)}">保存</button>
           <button type="button" class="btn btn-ghost btn-sm" data-act="cancel-edit">取消</button>
         </div>
       </form>`
    : `<div class="ops-item-row">
         <div class="ops-item-main">
           <div class="ops-item-name">${escapeHtml(op.name || "（未命名）")}</div>
           ${op.summary ? `<div class="ops-item-summary">${escapeHtml(op.summary)}</div>` : ""}
           <div class="ops-item-meta">${cost} ${tagHtml}</div>
         </div>
         <div class="codex-acts">
           <button class="mini" data-act="add" data-id="${escapeHtml(op.id)}" title="加入待执行">+ 待执行</button>
           <button class="mini" data-act="edit" data-id="${escapeHtml(op.id)}">编辑</button>
           <button class="mini codex-del" data-act="del" data-id="${escapeHtml(op.id)}">删除</button>
         </div>
       </div>`;

  return `<div class="ops-item" data-id="${escapeHtml(op.id)}">${body}</div>`;
}

// ── 待执行项渲染 ─────────────────────────────────────

function renderPending() {
  const box = $("ops-pending-list");
  const n = $("ops-pending-count");
  if (!box) return;
  if (n) n.textContent = pending.length ? `${pending.length} 条` : "";

  if (!state.currentConv?.id) {
    box.innerHTML = `<div class="empty">先开一场对话，才能添加待执行项。</div>`;
    return;
  }

  if (!pending.length) {
    box.innerHTML = `<div class="empty">待执行项为空。<br><span class="hint">从上方清单点「+ 待执行」；写完后模型会在正文里结算。</span></div>`;
    return;
  }

  const opById = new Map(all.map(o => [o.id, o]));
  box.innerHTML = pending.map((p, i) => {
    const op = opById.get(p.opId);
    const name = op?.name || "（已删除）";
    return `<div class="ops-pending-item">
      <span class="ops-pending-idx">${i + 1}</span>
      <span class="ops-pending-name">${escapeHtml(name)}</span>
      ${p.note ? `<span class="ops-pending-note" title="备注">${escapeHtml(p.note)}</span>` : ""}
      <button class="mini codex-del" data-pending-act="del" data-id="${escapeHtml(p.id)}">移除</button>
    </div>`;
  }).join("");

  if (!box.dataset.bound) {
    box.dataset.bound = "1";
    box.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-pending-act]");
      if (!btn) return;
      if (btn.dataset.pendingAct === "del") removePendingOne(btn.dataset.id);
    });
  }
}

// ── 新建 / 编辑 / 删除 ──────────────────────────────

export function newOp() {
  editingId = "__new__";
  const box = $("ops-list");
  if (box) {
    const form = `<div class="ops-item">
      <form class="ops-edit-form" onsubmit="return false">
        <input id="ops-edit-name" type="text" placeholder="名称" required>
        <input id="ops-edit-cost" type="text" placeholder="消耗变量（如 体力）">
        <textarea id="ops-edit-summary" rows="2" placeholder="简述（一句话，给模型看）"></textarea>
        <input id="ops-edit-tags" type="text" placeholder="标签（逗号分隔）">
        <div class="ops-edit-acts">
          <button type="button" class="btn btn-primary btn-sm" data-act="save-edit" data-id="__new__">保存</button>
          <button type="button" class="btn btn-ghost btn-sm" data-act="cancel-edit">取消</button>
        </div>
      </form>
    </div>`;
    box.insertAdjacentHTML("afterbegin", form);
    bindEditForms();
  }
}

function openEditor(id) {
  editingId = id;
  renderOps();
  bindEditForms();
}

function closeEditor() {
  editingId = null;
  renderOps();
}

function bindEditForms() {
  document.querySelectorAll("#ops-list .ops-edit-form").forEach(form => {
    if (form.dataset.bound) return;
    form.dataset.bound = "1";
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const btn = form.querySelector('[data-act="save-edit"]');
      if (btn) saveEdit(btn.dataset.id);
    });
    form.querySelectorAll('[data-act]').forEach(b => {
      b.addEventListener("click", () => {
        const act = b.dataset.act;
        if (act === "save-edit") saveEdit(b.dataset.id);
        else if (act === "cancel-edit") closeEditor();
      });
    });
  });
}

async function saveEdit(id) {
  const form = document.querySelector(`#ops-list .ops-edit-form[data-edit-id="${CSS.escape(id)}"], #ops-list .ops-item > .ops-edit-form`);
  const name = $("ops-edit-name")?.value?.trim();
  const costVar = $("ops-edit-cost")?.value?.trim() || null;
  const summary = $("ops-edit-summary")?.value?.trim() || "";
  const tags = ($("ops-edit-tags")?.value || "").split(/[,，]/).map(s => s.trim()).filter(Boolean);
  if (!name) { toast("名字不能为空", "error"); return; }

  try {
    if (id === "__new__") {
      await apiFetch("ops", { method: "POST", body: JSON.stringify({ name, costVar, summary, tags }) });
    } else {
      await apiFetch(`ops/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify({ name, costVar, summary, tags })
      });
    }
    toast("已保存", "success");
    closeEditor();
    await loadOps();
  } catch (e) {
    toast("保存失败：" + friendlyError(e), "error");
  }
}

async function deleteOp(id) {
  const one = all.find(x => String(x.id) === String(id));
  const name = one?.name || "这条操作";
  const ok = await confirmDialog(`删掉「${name}」？同时会清空它挂在待执行里的条目。`);
  if (!ok) return;
  try {
    await apiFetch(`ops/${encodeURIComponent(id)}`, { method: "DELETE" });
    // 待执行里同 opId 的条目也一并清
    for (const p of pending.filter(p => p.opId === id)) {
      await removePendingSilently(p.id);
    }
    toast("已删除", "success");
    await loadOps();
  } catch (e) {
    toast("删除失败：" + friendlyError(e), "error");
  }
}

// ── 待执行操作 ─────────────────────────────────────

async function addPendingFor(opId) {
  if (!state.currentConv?.id) {
    toast("先开一场对话", "error");
    return;
  }
  try {
    await apiFetch("ops/pending", {
      method: "POST",
      body: JSON.stringify({ opId, conversationId: state.currentConv.id })
    });
    toast("已加入待执行", "success");
    await loadOps();
  } catch (e) {
    toast("加入失败：" + friendlyError(e), "error");
  }
}

async function removePendingOne(id) {
  if (!state.currentConv?.id) return;
  try {
    await removePendingSilently(id);
    toast("已移除", "success");
    await loadOps();
  } catch (e) {
    toast("移除失败：" + friendlyError(e), "error");
  }
}

async function removePendingSilently(id) {
  await apiFetch(`ops/pending/${encodeURIComponent(id)}?conversationId=${encodeURIComponent(state.currentConv.id)}`, {
    method: "DELETE"
  });
}

async function clearPending() {
  if (!state.currentConv?.id || !pending.length) return;
  const ok = await confirmDialog(`清空 ${pending.length} 条待执行项？`);
  if (!ok) return;
  try {
    await apiFetch("ops/pending/clear", {
      method: "POST",
      body: JSON.stringify({ conversationId: state.currentConv.id })
    });
    toast("已清空", "success");
    await loadOps();
  } catch (e) {
    toast("清空失败：" + friendlyError(e), "error");
  }
}

// ── 事件绑定 ────────────────────────────────────────

let bound = false;

export function bindOps() {
  if (bound) return;
  bound = true;
  $("ops-new-btn")?.addEventListener("click", newOp);
  $("ops-pending-clear")?.addEventListener("click", clearPending);
}
