// presets.js — 提示词预设抽屉（P2 的界面出口）
//
// 后端 lib/presets/* 早就有了（块组装 / CRUD / 幂等导入 / preview），
// 但一直没有界面——又一个"能力没有出口"。这个模块把它接出来。
//
// 这里只做**浏览与选择**，不做可视化拖拽编辑器：
// 块顺序是有语义的（改错位置 prompt 就散了），拖拽容易误操作。
// 改成"上下移动 + 开关 + 逐块预览"，每一步都可复核。

import { apiFetch, confirmDialog, escapeHtml, extractArray, friendlyError, toast } from "./core.js";
import { dom } from "./dom.js";
import { state } from "./state.js";

const SOURCE_LABEL = {
  literal: "固定文本",
  main: "主提示",
  description: "角色描述",
  personality: "性格",
  scenario: "场景",
  examples: "对话示例",
  system_prompt: "卡内系统提示",
  post_history_instructions: "后置指令",
  lore: "世界书",
  persona: "用户人设",
  author_note: "作者注释"
};

export async function loadPresets() {
  if (!dom.presetListEl) return;
  dom.presetListEl.innerHTML = '<div class="empty">加载中…</div>';
  try {
    const list = extractArray(await apiFetch("presets"));
    state.presetList = list;
    renderPresets(list);
  } catch (e) {
    dom.presetListEl.innerHTML = `<div class="empty">加载失败<br><span class="hint">${escapeHtml(friendlyError(e))}</span></div>`;
  }
}

export function renderPresets(list) {
  if (!dom.presetListEl) return;
  if (dom.presetCountEl) dom.presetCountEl.textContent = list.length > 0 ? `${list.length} 套` : "";

  if (list.length === 0) {
    dom.presetListEl.innerHTML = '<div class="empty">暂无预设<br><span class="hint">用「+ 新建」建一套</span></div>';
    return;
  }

  const enabledCount = (p) => (p.blocks || []).filter(b => b.enabled !== false).length;
  const totalCount = (p) => (p.blocks || []).length;

  dom.presetListEl.innerHTML = list.map(p => `
    <div class="card preset-card ${p.builtin ? "builtin" : ""}" data-id="${p.id}">
      <div class="card-header">
        <h3>${escapeHtml(p.name || "（无名称）")}</h3>
        ${p.builtin ? '<span class="card-date">内置</span>' : ""}
      </div>
      <div class="card-desc">${escapeHtml(p.description || "")}</div>
      <div class="card-tags">
        <span>${enabledCount(p)}/${totalCount(p)} 块启用</span>
        <span>温度 ${p.sampling?.temperature ?? "—"}</span>
        <span>${p.sampling?.maxTokens ?? "—"} tokens</span>
      </div>
      <div class="card-actions">
        <button class="btn-sm" data-act="edit">编辑</button>
        <button class="btn-sm" data-act="preview">预览</button>
        <button class="btn-sm" data-act="duplicate">复制</button>
        ${p.builtin ? "" : '<button class="btn-sm danger" data-act="delete">删除</button>'}
      </div>
    </div>
  `).join("");

  dom.presetListEl.querySelectorAll(".preset-card").forEach(card => {
    card.querySelectorAll("button[data-act]").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        const id = card.dataset.id;
        if (act === "edit") openPresetEditor(id);
        else if (act === "preview") previewPreset(id);
        else if (act === "duplicate") duplicatePreset(id);
        else if (act === "delete") deletePreset(id);
      });
    });
  });
}

/** 当前对话（预览预设时用它当上下文，看不到真卡就用手填的样例）。 */
async function previewContext() {
  try {
    const { state: st } = await import("./state.js");
    const conv = st.currentConv;
    if (!conv) return {};
    const card = await apiFetch(`characters/${conv.characterId}`);
    return {
      character: card,
      persona: conv.persona || "",
      mainPrompt: ""
    };
  } catch {
    return {};
  }
}

export async function previewPreset(id) {
  try {
    const ctx = await previewContext();
    const res = await apiFetch(`presets/${id}/preview`, {
      method: "POST",
      body: JSON.stringify(ctx)
    });

    const detail = (res.detail || []).map(d => {
      const tag = d.skipped ? "跳过" : (d.position === "in_chat" ? "插话" : "系统");
      const why = d.enabled === false ? "已关闭" : (d.chars === 0 ? "取不到内容" : "");
      return `<div class="pv-entry">
        <span class="tag">${escapeHtml(tag)}</span>
        <span class="content">${escapeHtml(SOURCE_LABEL[d.source] || d.source)}</span>
        <span class="why">${escapeHtml(why)}</span>
        <span class="why">${d.chars} 字</span>
      </div>`;
    }).join("");

    document.getElementById("preview-title").textContent = "预设逐块预览";
    document.getElementById("preview-body").innerHTML = `
      <div class="pv-section">
        <div class="pv-head">块明细 <span class="dim">${(res.detail || []).length} 块</span></div>
        ${detail || '<div class="empty">没有块</div>'}
      </div>
      <div class="pv-section">
        <div class="pv-head">拼出来的 systemPrompt</div>
        <pre class="pv-pre">${escapeHtml(res.systemPrompt || "")}</pre>
      </div>`;
    document.getElementById("preview-modal").classList.remove("hidden");
  } catch (e) {
    toast(`预览失败: ${friendlyError(e)}`, "error");
  }
}

export async function duplicatePreset(id) {
  try {
    await apiFetch(`presets/${id}/duplicate`, { method: "POST", body: JSON.stringify({}) });
    toast("已复制", "success");
    await loadPresets();
  } catch (e) {
    toast(`复制失败: ${friendlyError(e)}`, "error");
  }
}

export async function deletePreset(id) {
  if (!(await confirmDialog("删除这套预设？"))) return;
  try {
    await apiFetch(`presets/${id}`, { method: "DELETE" });
    toast("已删除", "success");
    await loadPresets();
  } catch (e) {
    toast(`删除失败: ${friendlyError(e)}`, "error");
  }
}

/**
 * 预设编辑器。
 *
 * 不做拖拽——块的顺序是有语义的，误拖一下 prompt 就散了。
 * 改成显式的上下移动，每步都可预期、可撤销。
 */
export async function openPresetEditor(id) {
  let preset = null;
  if (id) {
    try {
      preset = await apiFetch(`presets/${id}`);
    } catch (e) { toast("加载失败", "error"); return; }
  }
  state.currentPreset = preset;

  const isNew = !preset;
  const p = preset || {
    name: "",
    description: "",
    blocks: [
      { id: "main", source: "main", position: "system", enabled: true, order: 0 },
      { id: "description", source: "description", position: "system", enabled: true, order: 10 },
      { id: "personality", source: "personality", position: "system", enabled: true, order: 20 },
      { id: "scenario", source: "scenario", position: "system", enabled: true, order: 30 },
      { id: "persona", source: "persona", position: "system", enabled: true, order: 40 },
      { id: "lore", source: "lore", position: "system", enabled: true, order: 50 },
      { id: "postHistory", source: "post_history_instructions", position: "system", enabled: true, order: 60 }
    ],
    sampling: { temperature: 0.8, maxTokens: 1000 }
  };

  document.getElementById("preset-editor-title").textContent = isNew ? "新建预设" : "编辑预设";
  document.getElementById("pe-id").value = p.id || "";
  document.getElementById("pe-name").value = p.name || "";
  document.getElementById("pe-description").value = p.description || "";
  document.getElementById("pe-temperature").value = p.sampling?.temperature ?? 0.8;
  document.getElementById("pe-max-tokens").value = p.sampling?.maxTokens ?? 1000;

  renderPresetBlocks(p);

  document.getElementById("preset-editor-modal").classList.remove("hidden");
}

/** 渲染块列表（含顺序操作）。 */
function renderPresetBlocks(preset) {
  const wrap = document.getElementById("pe-blocks");
  if (!wrap) return;

  const blocks = [...(preset.blocks || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  wrap.innerHTML = blocks.map((b, i) => `
    <div class="pe-block" data-idx="${i}">
      <div class="pe-order">
        <button class="btn-sm" data-move="up" data-i="${i}" ${i === 0 ? "disabled" : ""} title="上移">↑</button>
        <button class="btn-sm" data-move="down" data-i="${i}" ${i === blocks.length - 1 ? "disabled" : ""} title="下移">↓</button>
      </div>
      <label class="pe-toggle"><input type="checkbox" data-i="${i}" ${b.enabled !== false ? "checked" : ""}></label>
      <span class="pe-name">${escapeHtml(SOURCE_LABEL[b.source] || b.source)}</span>
      <span class="pe-meta">${b.position === "in_chat" ? "插话 depth " + (b.depth ?? 4) : "系统"}</span>
    </div>
  `).join("");

  wrap.querySelectorAll("button[data-move]").forEach(btn => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.i);
      const dir = btn.dataset.move === "up" ? -1 : 1;
      const j = i + dir;
      if (j < 0 || j >= blocks.length) return;
      const tmp = blocks[i].order;
      blocks[i].order = blocks[j].order;
      blocks[j].order = tmp;
      renderPresetBlocks({ ...preset, blocks });
    });
  });

  wrap.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener("change", () => {
      const i = Number(cb.dataset.i);
      blocks[i].enabled = cb.checked;
      renderPresetBlocks({ ...preset, blocks });
    });
  });

  wrap.dataset.blocks = JSON.stringify(blocks);
}

export async function savePreset() {
  const id = document.getElementById("pe-id").value;
  const blocks = JSON.parse(document.getElementById("pe-blocks").dataset.blocks || "[]");

  const payload = {
    name: document.getElementById("pe-name").value.trim(),
    description: document.getElementById("pe-description").value.trim(),
    blocks,
    sampling: {
      temperature: Number(document.getElementById("pe-temperature").value) || 0.8,
      maxTokens: Number(document.getElementById("pe-max-tokens").value) || 1000
    }
  };

  if (!payload.name) { toast("请填名称", "error"); return; }

  try {
    if (id) {
      await apiFetch(`presets/${id}`, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      await apiFetch("presets", { method: "POST", body: JSON.stringify(payload) });
    }
    toast("已保存", "success");
    document.getElementById("preset-editor-modal").classList.add("hidden");
    await loadPresets();
  } catch (e) {
    toast(`保存失败: ${friendlyError(e)}`, "error");
  }
}

export function closePresetEditor() {
  document.getElementById("preset-editor-modal")?.classList.add("hidden");
  state.currentPreset = null;
}

// ── 装配 ──────────────────────────────────────────────

export function bindPresets() {
  document.getElementById("preset-new-btn")?.addEventListener("click", () => openPresetEditor(null));
  document.getElementById("preset-duplicate-btn")?.addEventListener("click", async () => {
    const list = state.presetList || [];
    const first = list.find(p => !p.builtin) || list[0];
    if (!first) { toast("没有可复制的预设", "error"); return; }
    await duplicatePreset(first.id);
  });
  document.getElementById("preset-refresh-btn")?.addEventListener("click", loadPresets);

  document.getElementById("pe-cancel")?.addEventListener("click", closePresetEditor);
  document.getElementById("pe-save")?.addEventListener("click", savePreset);
  document.getElementById("preset-editor-close")?.addEventListener("click", closePresetEditor);
}
