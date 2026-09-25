// chat-more.js — 聊天头 ⋯ 菜单：用户人设 / 激活预览 / 组装预览
//
// 为什么单独一个模块：
//   这三个都是"看得见生成背后发生了什么"的入口，本质上同一类需求。
//   塞进 chat.js 会让那个文件再涨两百行，而它们之间又有共享状态
//   （当前在看哪种预览、刷新时用哪份参数）。
//
// 背景：这几个能力后端早就有了，但前端一个入口都没有——
// 诊断端点躺在那儿，用户根本不知道能看。

import { apiFetch, escapeHtml, friendlyError, toast, unwrap } from "./core.js";
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
      else if (act === "tts") import("./tts.js").then(m => m.openTts());
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
    // 扫描文本：优先用输入框里正在打的那句，否则用最后一条用户消息。
    //
    // 之前这里发的是空 body，于是扫描文本永远是空的：
    // 世界书关键词永远不命中、关键词格永远不激活。
    // 预览会稳定地告诉人「什么都没有」——而那不是真相，是**没给它输入**。
    const typed = String(dom.chatInput && dom.chatInput.value || "").trim();
    const lastUser = [...(conv.messages || [])].reverse().find(m => m.role === "user");
    const scanText = typed || String(lastUser && lastUser.content || "").trim();

    const res = await apiFetch(endpoint, {
      method: "POST",
      body: JSON.stringify({ text: scanText })
    });

    // 拆信封。apiFetch 返回的是 `{ok, data}` **完整信封**，它不替你拆。
    // 不拆的话 renderPrompt 读到的每个字段都是 undefined——屏幕上变成
    //「约 0 tokens / 消息 0 / 世界书 0 条」，看起来像「什么都没有」，
    // 而不像「代码看错了地方」。预设预览那两处已经踩过同一个坑了。
    const data = unwrap(res);

    if (previewKind === "activation") renderActivation(data, scanText);
    else renderPrompt(data, scanText);
  } catch (e) {
    if (body) {
      body.innerHTML = `<div class="empty">加载失败<br><span class="hint">${escapeHtml(friendlyError(e))}</span></div>`;
    }
  }
}

/** 激活预览：列出"谁进了 / 谁被裁了 / 为什么"。 */
function renderActivation(res, scanText = "") {
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
function renderPrompt(res, scanText = "") {
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

  // 把「扫的是哪句话」亮出来：关键词激活完全取决于它，
  // 看不见它就无法解释「为什么这条没进」。
  parts.push(`<div class="pv-entry">
    <span class="tag">扫描</span>
    <span class="content">${scanText
      ? escapeHtml(scanText.slice(0, 200))
      : `<span class="why">没有扫描文本（输入框空着、也没有用户消息）——关键词不会激活</span>`}</span>
  </div>`);

  // ── 账 ──
  //
  // 先给账再给正文。正文是给模型看的，账是给人看的：
  // 人看拼好的文本，对不出「该进没进」和「不该进进了」。
  const audit = res?.audit;
  if (audit && ((audit.included || []).length || (audit.omitted || []).length || (audit.warnings || []).length)) {
    const LABEL = {
      base: "底子（预设或角色卡）",
      "board-static": "世界 · 常驻",
      "board-dynamic": "世界 · 本轮",
      time: "当前时刻",
      "lore-dynamic": "世界设定（本轮）",
      history: "历史消息",
      summary: "前情提要",
      preset: "预设块"
    };
    const rows = (audit.included || []).map(x => `<div class="pv-entry">
      <span class="tag">${x.where === "messages" ? "消息" : "系统"}</span>
      <span class="content">${escapeHtml(LABEL[x.kind] || x.kind)}
        <span class="dim">${x.chars} 字符</span>
        ${x.note ? `<span class="dim">${escapeHtml(x.note)}</span>` : ""}</span>
    </div>`).join("");
    const outs = (audit.omitted || []).map(x => `<div class="pv-entry">
      <span class="tag">没进</span>
      <span class="content">${escapeHtml(LABEL[x.kind] || x.kind)}
        <span class="why">${escapeHtml(x.reason || "（没写理由）")}</span></span>
    </div>`).join("");
    const warns = (audit.warnings || []).map(w => `<div class="pv-entry">
      <span class="tag">⚠</span><span class="content">${escapeHtml(w)}</span>
    </div>`).join("");

    // 稳定前缀：这一场里逐字节不变的那一段。
    // 它是缓存命中与否的全部依据，所以单独一行：指纹 + 本轮变没变。
    const pfx = audit.prefix;
    const pfxRow = pfx ? `<div class="pv-entry">
      <span class="tag">前缀</span>
      <span class="content">
        <code class="mono">${escapeHtml(String(pfx.fingerprint || ""))}</code>
        ${pfx.changed
          ? `<span class="why">本轮变了：${escapeHtml((pfx.changed.parts || []).join(" + "))}——缓存从变化点往后全废</span>`
          : (pfx.baseline === "已知"
            ? `<span class="dim">本轮没变</span>`
            : `<span class="dim">没有可比的上一次（本进程第一次见这一场）</span>`)}
        <span class="dim">${(pfx.parts || []).map(p => `${escapeHtml(LABEL[p.kind] || p.kind)} ${p.chars}字符`).join(" · ")}</span>
      </span>
    </div>` : "";

    parts.push(`<div class="pv-section">
      <div class="pv-head">这一轮的账
        <span class="dim">共 ${audit.totalChars ?? 0} 字符${audit.regexChanged ? " · 正则改写后有变化" : ""}</span></div>
      ${pfxRow}${rows}${outs}${warns}
    </div>`);
  }

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
