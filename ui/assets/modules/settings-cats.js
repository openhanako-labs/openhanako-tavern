// settings-cats.js — 设定库的类目管理弹层 + 分类浮层选择器
//
// 两个浮层：
//   · 类目管理弹层（openCatsModal）：列所有类目、计数、改名/并到/删除、添加新类目
//     用真正的 <input>，不用 prompt()——那样会闪系统对话框、脱离样式，
//     而且用户点取消时前端拿不到值，得再问一遍。
//   · 分类浮层选择器（openCategoryPicker）：点小徽章时弹一个 dropdown，选一个类目
//     定位到卡片右上角，与「常用度浮层」并排（后者在 settings.js 里）。
//
// 后端：lib/settings/routes.js 的 /settings/categories/* 与 /settings/:id PUT

import { apiFetch, toast, escapeHtml } from "./core.js";
import { dom } from "./dom.js";
import { state } from "./state.js";
// 通过 CustomEvent "settings:changed" 通知 settings.js 重新拉列表

// ─── 类目管理弹层 ─────────────────────────────────────

let catsModalEl = null;
let catsBackdropEl = null;

/** 打开类目管理弹层。已打开时不重复创建。 */
export async function openCatsModal() {
  if (catsModalEl) {
    catsModalEl.classList.remove("hidden");
    await refreshCatsModal();
    return;
  }
  catsBackdropEl = document.createElement("div");
  catsBackdropEl.className = "modal-backdrop";
  catsModalEl = document.createElement("div");
  catsModalEl.className = "modal cats-modal";
  document.body.appendChild(catsBackdropEl);
  document.body.appendChild(catsModalEl);
  catsBackdropEl.addEventListener("click", closeCatsModal);
  catsModalEl.addEventListener("click", (e) => {
    if (e.target === catsModalEl) closeCatsModal();
  });
  await refreshCatsModal();
}

/** 关掉弹层。 */
export function closeCatsModal() {
  catsModalEl?.remove();
  catsBackdropEl?.remove();
  catsModalEl = null;
  catsBackdropEl = null;
}

/** 刷新弹层内容：拉后端类目表 + 每条计数。 */
async function refreshCatsModal() {
  if (!catsModalEl) return;
  try {
    const res = await apiFetch("settings/categories");
    const data = res.data || res;
    const items = data.items || [];
    const uncategorized = Number(data.uncategorized) || 0;
    renderCatsModal(items, uncategorized);
  } catch (e) {
    catsModalEl.innerHTML = `<div class="cats-empty">加载类目失败：${escapeHtml(String(e?.message || e))}</div>`;
  }
}

function renderCatsModal(items, uncategorized) {
  const uncategorizedRow = `
    <div class="cats-row uncategorized">
      <span class="cats-name">未分类</span>
      <span class="cats-count">${uncategorized} 条</span>
      <div class="cats-actions">
        <button class="mini" data-act="autocat" title="跑一次启发式，把「企业-」「[tag]」这类高置信条目自动填上">自动分类</button>
      </div>
    </div>`;

  const rows = items.map(it => `
    <div class="cats-row" data-name="${escapeHtml(it.name)}">
      <span class="cats-name">${escapeHtml(it.name)}</span>
      <span class="cats-count">${it.count} 条</span>
      <div class="cats-actions">
        <button class="mini" data-act="rename">改名</button>
        <button class="mini" data-act="merge">并到…</button>
        <button class="mini danger" data-act="delete">删除</button>
      </div>
    </div>`).join("");

  catsModalEl.innerHTML = `
    <div class="modal-head">
      <h3>类目管理</h3>
      <button class="btn btn-ghost btn-sm modal-close" data-act="close">✕</button>
    </div>
    <div class="cats-body">
      <div class="cats-list">${uncategorizedRow}${rows}</div>
      <div class="cats-add">
        <input type="text" id="cats-add-input" placeholder="新类目名（回车添加）" maxlength="20">
        <button class="btn btn-sm btn-primary" data-act="add">＋ 添加</button>
      </div>
    </div>
    <div class="cats-tip">
      <small>「并到」比「删除」诚实——条目会跳到目标类目；「删除」后条目掉进未分类，需要重新分。</small>
    </div>
  `;

  // 绑定事件
  catsModalEl.querySelector('[data-act="close"]')?.addEventListener("click", closeCatsModal);

  catsModalEl.querySelectorAll(".cats-row[data-name]").forEach(row => {
    const name = row.dataset.name;
    row.querySelector('[data-act="rename"]')?.addEventListener("click", () => doRename(name));
    row.querySelector('[data-act="merge"]')?.addEventListener("click", () => doMerge(name));
    row.querySelector('[data-act="delete"]')?.addEventListener("click", () => doDelete(name));
  });

  catsModalEl.querySelector('[data-act="autocat"]')?.addEventListener("click", async () => {
    try {
      const res = await apiFetch("settings/autocategorize", {
        method: "POST",
        body: JSON.stringify({ onlyEmpty: true })
      });
      const data = res.data || res;
      const filled = Number(data?.filled) || 0;
      toast(filled === 0 ? "启发式没匹上任何条目" : `自动分类：新标 ${filled} 条`, filled ? "success" : "info");
      window.dispatchEvent(new CustomEvent("settings:changed"));
      await refreshCatsModal();
    } catch (e) {
      toast("自动分类失败: " + String(e?.message || e), "error");
    }
  });

  catsModalEl.querySelector('[data-act="add"]')?.addEventListener("click", doAdd);
  document.getElementById("cats-add-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); doAdd(); }
  });
}

/** 添加新类目。 */
async function doAdd() {
  const input = document.getElementById("cats-add-input");
  const name = input?.value?.trim() || "";
  if (!name) { toast("类目名不能为空", "error"); input?.focus(); return; }
  try {
    await apiFetch("settings/categories/add", { method: "POST", body: JSON.stringify({ name }) });
    window.dispatchEvent(new CustomEvent("settings:changed"));
    await refreshCatsModal();
    input.value = "";
    input.focus();
  } catch (e) {
    toast("添加失败: " + String(e?.message || e), "error");
  }
}

/** 改名：就地替换类目名。用 input 行内编辑，不用 prompt。 */
function doRename(name) {
  const row = catsModalEl.querySelector(`.cats-row[data-name="${CSS.escape(name)}"]`);
  if (!row) return;
  const nameEl = row.querySelector(".cats-name");
  const oldText = name;
  nameEl.remove(); // 先移除原 span（replaceWith 不收函数，旧写法是空操作——旧名字和新输入框会同时挂在行里）
  const input = document.createElement("input");
  input.type = "text";
  input.value = oldText;
  input.maxLength = 20;
  input.className = "cats-inline-input";
  const wrap = document.createElement("span");
  wrap.appendChild(input);
  row.insertBefore(wrap, row.querySelector(".cats-count"));
  input.focus();
  input.select();

  const commit = async (save) => {
    const v = input.value.trim();
    if (!save || v === oldText) { await refreshCatsModal(); return; }
    if (!v) { toast("类目名不能为空", "error"); await refreshCatsModal(); return; }
    try {
      await apiFetch("settings/categories/rename", { method: "POST", body: JSON.stringify({ from: oldText, to: v }) });
      window.dispatchEvent(new CustomEvent("settings:changed"));
      await refreshCatsModal();
    } catch (e) {
      toast("改名失败: " + String(e?.message || e), "error");
      await refreshCatsModal();
    }
  };

  input.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") { e.preventDefault(); await commit(true); }
    else if (e.key === "Escape") { e.preventDefault(); await commit(false); }
  });
  input.addEventListener("blur", () => commit(true));
}

/** 并到：弹一个小 dropdown 选目标类目。 */
function doMerge(fromName) {
  const items = catsModalEl.querySelectorAll(".cats-row[data-name]");
  // 用浮层，避免嵌套弹层
  closeCatsModal();
  // 直接复用 confirmDialog 太重；用一段小 popup
  const pop = document.createElement("div");
  pop.className = "modal-backdrop";
  const box = document.createElement("div");
  box.className = "modal merge-box";
  const other = items
    .filter(r => r.dataset.name !== fromName)
    .map(r => `<button class="btn btn-sm merge-target" data-to="${escapeHtml(r.dataset.name)}">${escapeHtml(r.dataset.name)}</button>`)
    .join("");
  box.innerHTML = `
    <div class="modal-head"><h3>把「${escapeHtml(fromName)}」并到哪里？</h3></div>
    <div class="merge-body">${other || '<div class="cats-empty">没有其他类目可以并到——先添加一个</div>'}</div>
    <button class="btn btn-ghost btn-sm modal-close" data-act="cancel">取消</button>
  `;
  pop.appendChild(box);
  document.body.appendChild(pop);

  const cancel = () => pop.remove();
  box.querySelector('[data-act="cancel"]')?.addEventListener("click", cancel);
  pop.addEventListener("click", (e) => { if (e.target === pop) cancel(); });
  box.querySelectorAll(".merge-target").forEach(btn => {
    btn.addEventListener("click", async () => {
      const to = btn.dataset.to;
      cancel();
      try {
        await apiFetch("settings/categories/merge", { method: "POST", body: JSON.stringify({ from: fromName, to }) });
        toast(`已把「${fromName}」并入「${to}」`, "success");
        window.dispatchEvent(new CustomEvent("settings:changed"));
        openCatsModal(); // 弹层关掉后又打开，保持上下文
      } catch (e) {
        toast("合并失败: " + String(e?.message || e), "error");
      }
    });
  });
}

/** 删除：二次确认。 */
async function doDelete(name) {
  const ok = await new Promise(resolve => {
    // 用 confirmDialog（core.js 里那个）
    import("./core.js").then(({ confirmDialog }) => confirmDialog(`删除类目「${name}」？条目不会删，只会掉进未分类。`).then(resolve));
  });
  if (!ok) return;
  try {
    await apiFetch("settings/categories/remove", { method: "POST", body: JSON.stringify({ name }) });
    toast(`已删除类目「${name}」`, "success");
    window.dispatchEvent(new CustomEvent("settings:changed"));
    await refreshCatsModal();
  } catch (e) {
    toast("删除失败: " + String(e?.message || e), "error");
  }
}

// ─── 分类浮层选择器（点小徽章时）───────────────────────

let pickerPopEl = null;
let pickerOutsideEl = null; // 浮层的 document 级 mousedown 监听——closePickerPop 摘 DOM 时连它一起摘

/**
 * 在给定卡片右上角弹一个 dropdown，选一个类目。
 *
 * @param {HTMLElement} anchorEl 卡片元素或徽章元素
 * @param {string} id 卡片 id
 */
export function openCategoryPicker(anchorEl, id) {
  closePickerPop();
  const cats = state.categoryList || [];
  const pop = document.createElement("div");
  pop.className = "picker-pop cat-picker";
  const cur = (state.settingList || []).find(s => String(s.id) === String(id))?.category || "";
  const opts = [
    '<option value="">— 清空分类 —</option>',
    ...cats.map(c => `<option value="${escapeHtml(c)}" ${cur === c ? "selected" : ""}>${escapeHtml(c)}</option>`)
  ].join("");
  pop.innerHTML = `
    <div class="picker-title">分类</div>
    <select class="picker-select">${opts}</select>
    <div class="picker-actions">
      <button class="mini" data-act="cancel">取消</button>
      <button class="mini primary" data-act="save">应用</button>
    </div>
  `;
  document.body.appendChild(pop);
  pickerPopEl = pop;

  const rect = anchorEl.getBoundingClientRect();
  pop.style.position = "fixed";
  // 徽章宽度约 60px，往左对齐 anchor 的右边缘
  pop.style.left = Math.max(8, rect.right - 160) + "px";
  pop.style.top = rect.top + "px";

  const close = () => {
    pop.remove(); pickerPopEl = null;
    document.removeEventListener("mousedown", outside);
    if (pickerOutsideEl === outside) pickerOutsideEl = null;
  };
  const outside = (e) => { if (!pop.contains(e.target)) close(); };
  pickerOutsideEl = outside;
  setTimeout(() => document.addEventListener("mousedown", outside), 0);

  pop.querySelector('[data-act="cancel"]')?.addEventListener("click", close);
  pop.querySelector('[data-act="save"]')?.addEventListener("click", async () => {
    const v = pop.querySelector(".picker-select").value;
    close();
    await applySingleCategory(id, v);
  });
  pop.querySelector(".picker-select")?.focus();
}

function closePickerPop() {
  if (pickerPopEl) { pickerPopEl.remove(); pickerPopEl = null; }
  // 只摘 DOM 不摘监听：document 上的 mousedown 会一路涨（旧闭包持有已移除的 pop），
  // 每开关一次浮层就漏一个孤儿出去。
  if (pickerOutsideEl) {
    document.removeEventListener("mousedown", pickerOutsideEl);
    pickerOutsideEl = null;
  }
}

async function applySingleCategory(id, cat) {
  try {
    await apiFetch(`settings/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ category: cat }) });
    const s = (state.settingList || []).find(x => String(x.id) === String(id));
    if (s) s.category = cat;
    // 通知 settings.js 重渲（数据已经写库并更新了 state.settingList）
    window.dispatchEvent(new CustomEvent("settings:changed"));
  } catch (e) {
    toast("修改分类失败: " + String(e?.message || e), "error");
  }
}

// ── 跨模块事件监听：由 settings.js 派发 "settings:open-category-picker" ──
// 这样分类选择器不依赖 settings.js 的模块加载顺序。
window.addEventListener("settings:open-category-picker", (ev) => {
  const { anchorEl, id } = ev.detail || {};
  if (anchorEl && id) openCategoryPicker(anchorEl, id);
});
