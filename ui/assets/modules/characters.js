// characters.js — 由 characters.js 按功能拆分（B5）

import { apiFetch, confirmDialog, escapeHtml, extractArray, formatDate, friendlyError, toast } from "./core.js";
import { dom } from "./dom.js";
import { state } from "./state.js";


export function renderCharacters(characters) {
  dom.countEl.textContent = characters.length > 0 ? `${characters.length} 个` : "";
  if (characters.length === 0) {
    dom.listEl.innerHTML = '<div class="empty">暂无角色卡<span class="hint">点右上角「+ 新建」开始</span></div>';
    return;
  }
  dom.listEl.innerHTML = characters.map(c => {
    // 描述为空时退到开场白：列表是用来扫的，一排「（无描述）」等于没有信息。
    const desc = String(c.description || "").trim();
    const fallback = String(c.first_mes || "").trim();
    const shown = desc || fallback;
    const descHtml = shown
      ? `<div class="card-desc">${escapeHtml(shown.slice(0, 120))}</div>`
      : `<div class="card-desc is-empty">还没有描述</div>`;
    // 同名卡靠创建时间与 id 尾号区分，否则列表里几行一模一样
    const stamp = c.created_at ? formatDate(c.created_at) : "";
    return `
    <div class="card" data-id="${c.id}">
      <div class="card-header">
        <h3>${escapeHtml(c.name || "（未命名）")}</h3>
        <span class="card-date">${formatDate(c.updated_at || c.created_at)}</span>
      </div>
      ${descHtml}
      ${c.tags && c.tags.length > 0 ? `<div class="card-tags">${c.tags.slice(0, 3).map(t => `<span>${escapeHtml(t)}</span>`).join("")}</div>` : ""}
      <div class="card-foot">
        <span class="card-since">建于 ${stamp}</span>
        <span class="card-id">…${escapeHtml(String(c.id || "").slice(-4))}</span>
      </div>
      <div class="card-actions">
        <button class="btn-sm" data-action="edit">编辑</button>
        <button class="btn-sm" data-action="export">导出</button>
        <button class="btn-sm danger" data-action="delete">删除</button>
      </div>
    </div>`;
  }).join("");
  dom.listEl.querySelectorAll(".card").forEach(card => {
    card.addEventListener("click", (e) => {
      const action = e.target.dataset.action;
      if (action) { e.stopPropagation(); handleCharacterAction(action, card.dataset.id); }
      else openCharacterEditor(card.dataset.id);
    });
  });
}

export async function openCharacterEditor(id) {
  let card = null;
  if (id) {
    try {
      const res = await apiFetch(`characters/${id}`);
      card = res.data || res;
    } catch (e) { toast("加载失败", "error"); return; }
  }
  state.currentCharacter = card;
  state.currentForm = 'character';
  
  const form = document.getElementById("character-form");
  form.reset();
  
  document.querySelectorAll(".form").forEach(f => f.classList.add("hidden"));
  form.classList.remove("hidden");
  
  if (card) {
    document.getElementById("modal-title").textContent = "编辑角色";
    document.getElementById("f-id").value = card.id;
    document.getElementById("f-name").value = card.name || "";
    document.getElementById("f-description").value = card.description || "";
    document.getElementById("f-personality").value = card.personality || "";
    document.getElementById("f-scenario").value = card.scenario || "";
    document.getElementById("f-first-mes").value = card.first_mes || "";
    document.getElementById("f-mes-example").value = card.mes_example || "";
    document.getElementById("f-system-prompt").value = card.system_prompt || "";
    document.getElementById("f-post-history").value = card.post_history_instructions || "";
    document.getElementById("f-creator").value = card.creator || "";
    document.getElementById("f-version").value = card.character_version || "1.0";
    document.getElementById("f-tags").value = (card.tags || []).join(", ");
    document.getElementById("f-notes").value = card.creator_notes || "";
    document.getElementById("modal-delete").classList.remove("hidden");
    document.getElementById("modal-export-st").classList.remove("hidden");
  } else {
    document.getElementById("modal-title").textContent = "新建角色";
    document.getElementById("modal-delete").classList.add("hidden");
    document.getElementById("modal-export-st").classList.add("hidden");
  }
  
  dom.modalEl.classList.remove("hidden");
}

export async function saveCharacter() {
  const card = {
    name: document.getElementById("f-name").value.trim(),
    description: document.getElementById("f-description").value.trim(),
    personality: document.getElementById("f-personality").value.trim(),
    scenario: document.getElementById("f-scenario").value.trim(),
    first_mes: document.getElementById("f-first-mes").value.trim(),
    mes_example: document.getElementById("f-mes-example").value.trim(),
    system_prompt: document.getElementById("f-system-prompt").value.trim(),
    post_history_instructions: document.getElementById("f-post-history").value.trim(),
    creator: document.getElementById("f-creator").value.trim(),
    character_version: document.getElementById("f-version").value.trim() || "1.0",
    tags: document.getElementById("f-tags").value.split(",").map(s => s.trim()).filter(Boolean),
    creator_notes: document.getElementById("f-notes").value.trim()
  };

  if (!card.name || !card.description || !card.first_mes) {
    toast("请填写必填字段", "error");
    return;
  }

  try {
    if (state.currentCharacter) {
      await apiFetch(`characters/${state.currentCharacter.id}`, { method: "PUT", body: JSON.stringify(card) });
      toast("已保存", "success");
    } else {
      await apiFetch("characters", { method: "POST", body: JSON.stringify(card) });
      toast("已创建", "success");
    }
    closeEditModal();
    loadCharacters();
  } catch (e) {
    toast(`失败: ${e.message}`, "error");
  }
}

export async function deleteCharacter(id) {
  if (!(await confirmDialog("确定删除？"))) return;
  try {
    await apiFetch(`characters/${id}`, { method: "DELETE" });
    toast("已删除", "success");
    loadCharacters();
  } catch (e) {
    toast(`失败: ${e.message}`, "error");
  }
}

export async function exportCharacter(id, format = "json") {
  try {
    const res = await apiFetch(`characters/${id}/export/${format}`);
    const data = res.data || res;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${data.name || "character"}.${format === "st-v2" ? "st" : "json"}_card.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast("已导出", "success");
  } catch (e) {
    toast(`失败: ${e.message}`, "error");
  }
}

export function handleCharacterAction(action, id) {
  if (action === "edit") openCharacterEditor(id);
  else if (action === "export") exportCharacter(id, "json");
  else if (action === "delete") deleteCharacter(id);
}

// ── 导入角色卡 ──────────────────────────────────────────

export async function handleImport(files) {
  if (!files || files.length === 0) return;
  
  try {
    // 使用 FormData 上传文件（避免 base64 体积过大）
    const formData = new FormData();
    for (const file of files) {
      formData.append("files", file);
    }
    
    // 调用后端解析
    const res = await apiFetch("characters/import/parse", {
      method: "POST",
      body: formData
    });
    
    console.log("[Import] API response type:", typeof res, Array.isArray(res) ? "array" : Object.keys(res || {}));
    console.log("[Import] API response:", JSON.stringify(res).slice(0, 1000));
    
    // 检查错误响应
    if (!res || Object.keys(res).length === 0) {
      toast("解析失败：后端返回空响应", "error");
      return;
    }
    
    if (res.ok === false) {
      toast(`解析失败: ${res.error || "未知错误"}`, "error");
      return;
    }
    
    // 处理可能的响应格式
    let results = [];
    if (Array.isArray(res)) {
      results = res;
    } else if (Array.isArray(res?.data)) {
      results = res.data;
    } else if (Array.isArray(res?.results)) {
      results = res.results;
    }
    
    console.log("[Import] Extracted results:", results.length);
    
    if (results.length === 0) {
      console.error("[Import] No results extracted. Response:", res);
      toast("解析失败：没有可导入的文件", "error");
      return;
    }
    
    state.importData = results;
    renderImportPreview(results);
    dom.importModalEl.classList.remove("hidden");
  } catch (e) {
    console.error("[Import] Error:", e);
    toast(`导入失败: ${e.message}`, "error");
  }
}

export function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  // 使用 chunk 方式处理大文件，避免字符串过长
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

// ── 列表装载与标签云 ─────────────────────────────────

/**
 * 拉角色卡列表并渲染。
 *
 * 搜索词与标签从 state 取，不在签名上堆参数——
 * 输入框的回调只管写 state 再调这里。
 */
export async function loadCharacters() {
  try {
    const params = new URLSearchParams();
    if (state.searchQuery) params.set("q", state.searchQuery);
    if (state.tagFilter) params.set("tag", state.tagFilter);
    const qs = params.toString();
    const res = await apiFetch("characters" + (qs ? "?" + qs : ""));
    const list = extractArray(res);
    state.charList = list;
    renderCharacters(list);
  } catch (e) {
    console.error("[Characters] load failed:", e);
    toast("加载失败: " + friendlyError(e), "error");
  }
}

/**
 * 统计标签，渲染成可点的筛选条。
 *
 * 用 document.getElementById 而非 dom.* —— dom.js 里没有这一项，
 * 而 HTML 确有该容器。容器不存在就静默跳过：辅助筛选不该让
 * 缺一个元素炸掉整页。
 */
export async function loadTagCloud() {
  const el = document.getElementById("tag-cloud");
  if (!el) return;
  try {
    const res = await apiFetch("characters");
    const list = extractArray(res);
    const counts = new Map();
    for (const c of list) {
      for (const t of (c.tags || [])) counts.set(t, (counts.get(t) || 0) + 1);
    }
    if (counts.size === 0) { el.innerHTML = ""; return; }

    el.innerHTML = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([tag, n]) => {
        const active = state.tagFilter === tag ? " active" : "";
        return '<button type="button" class="tag-chip' + active + '" data-tag="' + escapeHtml(tag) + '">'
          + escapeHtml(tag) + '<span class="n">' + n + '</span></button>';
      })
      .join("");

    el.querySelectorAll(".tag-chip").forEach(btn => {
      btn.addEventListener("click", () => {
        state.tagFilter = state.tagFilter === btn.dataset.tag ? null : btn.dataset.tag;
        loadTagCloud();
        loadCharacters();
      });
    });
  } catch (e) {
    console.error("[TagCloud] failed:", e);
  }
}

// ── 导入预览与提交 ───────────────────────────────────

/**
 * 渲染导入预览列表。
 *
 * items 来自 handleImport 存入 state.importData 的结果，
 * 形状见 lib/characters/routes.js 的 import/parse 返回。
 */
export function renderImportPreview(items) {
  const box = document.getElementById("import-preview");
  if (!box) return;
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    box.innerHTML = '<div class="empty">没有可导入的卡片</div>';
    return;
  }

  box.innerHTML = list.map((it, i) => {
    const ok = it.importable !== false;
    const name = escapeHtml((it.preview && it.preview.name) || it.name || "（未命名）");
    const desc = escapeHtml(String((it.preview && it.preview.description) || "").slice(0, 120));
    const fmt = escapeHtml(it.format || "json");
    let flags = "";
    if (ok) flags += '<span class="fmt">' + fmt + "</span>";
    if (it.preview && it.preview.has_book) flags += '<span class="fmt book">世界书</span>';
    if (it.preview && it.preview.has_alternate_greetings) flags += '<span class="fmt">多开场</span>';
    if (!ok) flags += '<span class="err">' + escapeHtml(it.error || "不可导入") + "</span>";
    return '<div class="import-item' + (ok ? "" : " bad") + '" data-i="' + i + '">'
      + '<div class="nm">' + name + "</div>"
      + '<div class="ds">' + desc + "</div>"
      + '<div class="flags">' + flags + "</div></div>";
  }).join("");

  // 可导项默认全选，点一下取消
  state.importSelected = new Set(
    list.map((it, i) => (it.importable !== false ? i : -1)).filter(i => i >= 0)
  );
  box.querySelectorAll(".import-item").forEach(el => {
    el.addEventListener("click", () => {
      const i = Number(el.dataset.i);
      if (state.importSelected.has(i)) state.importSelected.delete(i);
      else state.importSelected.add(i);
      el.classList.toggle("off");
    });
  });
}

/** 关闭导入弹窗并清空暂存。 */
export function closeImportModal() {
  if (dom.importModalEl) dom.importModalEl.classList.add("hidden");
  state.importData = null;
  state.importSelected = new Set();
}

/**
 * 提交导入。
 *
 * 走「前端回传 items」这条路（lib/characters/routes.js 的 commit 分支），
 * 头像 base64 一并带回 —— 否则图片卡会丢头像。
 */
export async function commitImport() {
  const items = state.importData || [];
  if (items.length === 0) { toast("没有待导入的卡片", "error"); return; }

  const picked = items.filter((_, i) => !state.importSelected || state.importSelected.has(i));
  if (picked.length === 0) { toast("未选择任何卡片", "error"); return; }

  try {
    const res = await apiFetch("characters/import/commit", {
      method: "POST",
      body: JSON.stringify({ items: picked, importCharacterBook: true })
    });
    const list = extractArray(res);
    const ok = list.filter(r => r.success !== false);
    const bad = list.filter(r => r.success === false);

    if (ok.length > 0) toast("已导入 " + ok.length + " 张卡片", "success");
    if (bad.length > 0) toast(bad.length + " 张失败: " + friendlyError(bad[0]), "error");

    closeImportModal();
    await loadCharacters();
    await loadTagCloud();
  } catch (e) {
    console.error("[Import] commit failed:", e);
    toast("导入失败: " + friendlyError(e), "error");
  }
}
