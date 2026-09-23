// chat-more.js — 聊天头 ⋯ 菜单：用户人设 / 激活预览 / 组装预览
//
// 为什么单独一个模块：
//   这三个都是"看得见生成背后发生了什么"的入口，本质上同一类需求。
//   塞进 chat.js 会让那个文件再涨两百行，而它们之间又有共享状态
//   （当前在看哪种预览、刷新时用哪份参数）。
//
// 背景：这几个能力后端早就有了，但前端一个入口都没有——
// 诊断端点躺在那儿，用户根本不知道能看。

import { apiFetch, escapeHtml, friendlyError, toast } from "./core.js";
import { dom } from "./dom.js";
import { state } from "./state.js";

/** 当前预览类型：null | "activation" | "prompt" */
let previewKind = null;

// ── 菜单开合 ──────────────────────────────────────────

/** 绑定 ⋯ 菜单。幂等，可重复调用。 */
export function bindChatMore() {
  const btn = document.getElementById("chat-more-btn");
  const menu = document.getElementById("more-menu");
  if (!btn || !menu || menu.dataset.bound === "1") return;
  menu.dataset.bound = "1";

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });

  // 点别处收起（捕获阶段，避免被内部按钮的 stopPropagation 抢先）
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) {
      menu.hidden = true;
    }
  });

  menu.querySelectorAll("button[data-act]").forEach(item => {
    item.addEventListener("click", () => {
      const act = item.dataset.act;
      menu.hidden = true;
      if (act === "persona") openPersona();
      else if (act === "activation") openPreview("activation");
      else if (act === "prompt") openPreview("prompt");
      else if (act === "export") exportChatFromMenu();
      else if (act === "delete") deleteChatFromMenu();
    });
  });

  const personaModal = document.getElementById("persona-modal");
  document.getElementById("persona-close")?.addEventListener("click", closePersona);
  document.getElementById("persona-cancel")?.addEventListener("click", closePersona);
  document.getElementById("persona-save")?.addEventListener("click", savePersona);
  personaModal?.addEventListener("click", (e) => {
    if (e.target === personaModal) closePersona();
  });

  const previewModal = document.getElementById("preview-modal");
  document.getElementById("preview-close")?.addEventListener("click", closePreview);
  document.getElementById("preview-ok")?.addEventListener("click", closePreview);
  document.getElementById("preview-refresh")?.addEventListener("click", refreshPreview);
  previewModal?.addEventListener("click", (e) => {
    if (e.target === previewModal) closePreview();
  });

  // Esc 关弹窗
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!personaModal?.classList.contains("hidden")) closePersona();
    else if (!previewModal?.classList.contains("hidden")) closePreview();
  });
}

/** 对话打开/关闭时同步 ⋯ 按钮可见性。 */
export function syncChatMore(visible) {
  const btn = document.getElementById("chat-more-btn");
  if (btn) btn.classList.toggle("hidden", !visible);
  const menu = document.getElementById("more-menu");
  if (menu && !visible) menu.hidden = true;
}

// ── 导出 / 删除（从菜单进来，复用 chat.js 的实现） ──

async function exportChatFromMenu() {
  const mod = await import("./chat.js");
  mod.exportChat();
}

async function deleteChatFromMenu() {
  const mod = await import("./chat.js");
  mod.deleteConversation();
}

// ── 用户人设 ──────────────────────────────────────────

export function openPersona() {
  const conv = state.currentConv;
  if (!conv) return;
  document.getElementById("pf-user-name").value = conv.userName || "";
  document.getElementById("pf-persona").value = conv.persona || "";
  document.getElementById("persona-modal").classList.remove("hidden");
  setTimeout(() => document.getElementById("pf-user-name")?.focus(), 30);
}

export function closePersona() {
  document.getElementById("persona-modal")?.classList.add("hidden");
}

export async function savePersona() {
  const conv = state.currentConv;
  if (!conv) return;

  const userName = document.getElementById("pf-user-name").value.trim();
  const persona = document.getElementById("pf-persona").value.trim();

  try {
    const res = await apiFetch(`conversations/${conv.id}/persona`, {
      method: "PUT",
      body: JSON.stringify({ userName, persona })
    });
    // 回写本地，避免整页重载丢滚动位置
    conv.userName = res.userName;
    conv.persona = res.persona;
    closePersona();
    toast("人设已保存", "success");
  } catch (e) {
    toast(`保存失败: ${friendlyError(e)}`, "error");
  }
}

// ── 预览 ──────────────────────────────────────────────

export function openPreview(kind) {
  const conv = state.currentConv;
  if (!conv) return;
  previewKind = kind;
  document.getElementById("preview-title").textContent =
    kind === "activation" ? "世界书激活预览" : "Prompt 组装预览";
  document.getElementById("preview-modal").classList.remove("hidden");
  renderPreviewLoading();
  loadPreview();
}

export function closePreview() {
  document.getElementById("preview-modal")?.classList.add("hidden");
  previewKind = null;
}

export async function refreshPreview() {
  if (!previewKind) return;
  renderPreviewLoading();
  await loadPreview();
}

function renderPreviewLoading() {
  const body = document.getElementById("preview-body");
  if (body) body.innerHTML = '<div class="empty">加载中…</div>';
}

async function loadPreview() {
  const conv = state.currentConv;
  if (!conv || !previewKind) return;

  const body = document.getElementById("preview-body");
  const endpoint = previewKind === "activation"
    ? `conversations/${conv.id}/activation-preview`
    : `conversations/${conv.id}/prompt-preview`;

  try {
    const res = await apiFetch(endpoint, {
      method: "POST",
      body: JSON.stringify({})
    });

    if (previewKind === "activation") renderActivation(res);
    else renderPrompt(res);
  } catch (e) {
    if (body) {
      body.innerHTML = `<div class="empty">加载失败<br><span class="hint">${escapeHtml(friendlyError(e))}</span></div>`;
    }
  }
}

/** 激活预览：列出"谁进了 / 谁被裁了 / 为什么"。 */
function renderActivation(res) {
  const body = document.getElementById("preview-body");
  if (!body) return;

  if (res?.available === false) {
    body.innerHTML = `<div class="empty">${escapeHtml(res.note || "设定库未就绪")}</div>`;
    return;
  }

  const activated = Array.isArray(res.activated) ? res.activated : [];
  const trace = res.trace || {};
  const parts = [];

  parts.push(`<div class="pv-stat">
    <span>可用条目 ${res.totalSettings ?? 0}</span>
    <span>激活 ${activated.length}</span>
    <span>扫描 ${res.scanTextLength ?? 0} 字</span>
  </div>`);

  if (activated.length === 0) {
    parts.push('<div class="empty">当前上下文没有条目被激活<br><span class="hint">对话里多聊聊相关话题再来看看</span></div>');
  } else {
    parts.push('<div class="pv-section"><div class="pv-head">激活条目</div>');
    for (const e of activated) {
      parts.push(`<div class="pv-entry">
        <span class="tag">${escapeHtml(e.anchor || "unspecified")}</span>
        <span class="content">${escapeHtml(e.name || e.id)}</span>
        ${e.depth ? `<span class="why">深度 ${e.depth}</span>` : ""}
      </div>`);
    }
    parts.push("</div>");
  }

  const omitted = Array.isArray(trace.omitted) ? trace.omitted : [];
  if (omitted.length > 0) {
    parts.push('<div class="pv-section"><div class="pv-head">被预算裁掉 <span class="dim">' + omitted.length + '</span></div>');
    for (const o of omitted) {
      parts.push(`<div class="pv-entry"><span class="content">${escapeHtml(o.name || o.id)}</span><span class="why">${escapeHtml(o.reason || "")}</span></div>`);
    }
    parts.push("</div>");
  }

  body.innerHTML = parts.join("");
}

/** 组装预览：systemPrompt + 逐条消息 + 用量估算。 */
function renderPrompt(res) {
  const body = document.getElementById("preview-body");
  if (!body) return;

  const meta = res?.meta || {};
  const msgs = Array.isArray(res.messages) ? res.messages : [];
  const parts = [];

  parts.push(`<div class="pv-stat">
    <span>约 ${res.estimatedTokens ?? 0} tokens</span>
    <span>消息 ${msgs.length}</span>
    <span>世界书 ${meta.loreCount ?? 0} 条</span>
    ${meta.droppedMessages ? `<span>折叠历史 ${meta.droppedMessages} 条</span>` : ""}
    ${meta.presetId ? `<span>预设 ${escapeHtml(String(meta.presetId))}</span>` : ""}
  </div>`);

  parts.push(`<div class="pv-section">
    <div class="pv-head">systemPrompt <span class="dim">${meta.summaryAttached ? "含前情提要" : ""}</span></div>
    <pre class="pv-pre">${escapeHtml(res?.systemPrompt || "")}</pre>
  </div>`);

  if (msgs.length > 0) {
    parts.push('<div class="pv-section"><div class="pv-head">messages</div>');
    for (const m of msgs) {
      const role = escapeHtml(String(m.role || ""));
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      const broken = m._prefixBroken ? ' <span class="why">签名已失效</span>' : "";
      parts.push(`<div class="pv-entry">
        <span class="tag">${role}</span>
        <span class="content">${escapeHtml(text.slice(0, 400))}${text.length > 400 ? "…" : ""}</span>${broken}
      </div>`);
    }
    parts.push("</div>");
  }

  body.innerHTML = parts.join("");
}
