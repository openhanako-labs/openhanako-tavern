// characters.js — ElecKoi Tavern UI 逻辑（M5 完整版）

import { hana } from "./sdk.js";

const FETCH_TIMEOUT_MS = 5000;

// ── DOM 引用 ──────────────────────────────────────────
const listEl = document.getElementById("characters-list");
const countEl = document.getElementById("count");
const modalEl = document.getElementById("modal");
const importModalEl = document.getElementById("import-modal");
const newConvModalEl = document.getElementById("new-conv-modal");
const fileInput = document.getElementById("file-input");
const stImportInput = document.getElementById("st-import-input");

// Chat
const conversationsListEl = document.getElementById("conversations-list");
const messagesContainer = document.getElementById("messages-container");
const chatTitle = document.getElementById("chat-title");
const chatInputArea = document.getElementById("chat-input-area");
const chatInput = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const chatActions = document.getElementById("chat-actions");

// Settings
const settingsListEl = document.getElementById("settings-list");
const settingsCountEl = document.getElementById("settings-count");

// Variables
const variablesListEl = document.getElementById("variables-list");
const variablesCountEl = document.getElementById("variables-count");

// Tools
const toolsListEl = document.getElementById("tools-list");
const toolsCountEl = document.getElementById("tools-count");
const toolGroupsEl = document.getElementById("tool-groups-list");

// Migration
const exportsListEl = document.getElementById("exports-list");
const exportInfoEl = document.getElementById("export-info");
const importResultEl = document.getElementById("import-result");
const migrationFileInput = document.getElementById("file-input");

// State
let currentCharacter = null;
let importData = null;
let currentConv = null;
let convList = [];
let isGenerating = false;
let currentSetting = null;
let currentVariable = null;
let currentForm = null; // 'character' | 'setting' | 'variable'
let lastExportData = null;

// ── 工具函数 ──────────────────────────────────────────

function toast(message, type = "info") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// 自定义确认弹窗（iframe 沙箱阻止了 window.confirm）
function confirmDialog(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:99999;";
    const box = document.createElement("div");
    box.style.cssText = "background:var(--hana-bg,#1e1e1e);border:1px solid var(--hana-border,#333);border-radius:8px;padding:20px;min-width:300px;max-width:90vw;";
    const msg = document.createElement("p");
    msg.textContent = message;
    msg.style.cssText = "margin:0 0 16px;font-size:14px;color:var(--hana-fg,#e0e0e0);";
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:8px;justify-content:flex-end;";
    const okBtn = document.createElement("button");
    okBtn.textContent = "确认";
    okBtn.style.cssText = "padding:6px 16px;background:#e74c3c;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;";
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "取消";
    cancelBtn.style.cssText = "padding:6px 16px;background:var(--hana-border,#333);color:var(--hana-fg,#e0e0e0);border:none;border-radius:4px;cursor:pointer;font-size:13px;";
    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    box.appendChild(msg);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    okBtn.onclick = () => { overlay.remove(); resolve(true); };
    cancelBtn.onclick = () => { overlay.remove(); resolve(false); };
    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } };
  });
}

async function apiFetch(path, options = {}) {
  const attempts = [
    () => hana?.api?.fetch?.(path, options),
    () => hana?.api?.fetch?.("/" + path, options),
  ];

  for (const attempt of attempts) {
    if (typeof attempt !== "function") continue;
    try {
      const r = await Promise.race([
        attempt(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("fetch timeout")), FETCH_TIMEOUT_MS)),
      ]);
      if (r) {
        // Response 对象 — 需要解析 body
        if (typeof r.json === "function") {
          return await r.json();
        }
        if (typeof r === "string") return JSON.parse(r);
        if (typeof r === "object") return r;
      }
    } catch (e) {
      console.error("apiFetch error:", e);
    }
  }
  throw new Error("All fetch attempts failed");
}

// 从 API 响应中提取数据数组
function extractArray(res) {
  if (!res) return [];
  // 直接是数组
  if (Array.isArray(res)) return res;
  // { data: [] }
  if (Array.isArray(res.data)) return res.data;
  // { exports: [] }
  if (Array.isArray(res.exports)) return res.exports;
  // { items: [] }
  if (Array.isArray(res.items)) return res.items;
  // { results: [] }
  if (Array.isArray(res.results)) return res.results;
  return [];
}

function formatDate(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

function formatTime(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── Tab 切换 ──────────────────────────────────────────

document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    const tabName = tab.dataset.tab;
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
    document.getElementById(`view-${tabName}`).classList.remove("hidden");
    
    if (tabName === "chat") loadConversations();
    if (tabName === "settings") loadSettings();
    if (tabName === "variables") loadVariables();
    if (tabName === "tools") loadTools();
    if (tabName === "migration") loadExports();
  });
});

// ── 角色卡 ──────────────────────────────────────────

async function loadCharacters() {
  listEl.innerHTML = '<div class="empty">加载中...</div>';
  try {

  try {
    const res = await apiFetch("characters");
    const characters = extractArray(res);
    renderCharacters(characters);
  } catch (e) {
    listEl.innerHTML = `<div class="empty">加载失败: ${e.message}</div>`;
    toast("加载失败", "error");
  }
}

function renderCharacters(characters) {
  countEl.textContent = characters.length > 0 ? `${characters.length} 个` : "";
  if (characters.length === 0) {
    listEl.innerHTML = '<div class="empty">暂无角色卡<br><span class="hint">点击"+ 新建"开始</span></div>';
    return;
  }
  listEl.innerHTML = characters.map(c => `
    <div class="card" data-id="${c.id}">
      <div class="card-header">
        <h3>${escapeHtml(c.name || "（无名称）")}</h3>
        <span class="card-date">${formatDate(c.updated_at)}</span>
      </div>
      <div class="card-desc">${escapeHtml(c.description || "（无描述）")}</div>
      ${c.tags && c.tags.length > 0 ? `<div class="card-tags">${c.tags.slice(0, 3).map(t => `<span>${escapeHtml(t)}</span>`).join("")}</div>` : ""}
      <div class="card-actions">
        <button class="btn-sm" data-action="edit">编辑</button>
        <button class="btn-sm" data-action="export">导出</button>
        <button class="btn-sm danger" data-action="delete">删除</button>
      </div>
    </div>
  `).join("");
  listEl.querySelectorAll(".card").forEach(card => {
    card.addEventListener("click", (e) => {
      const action = e.target.dataset.action;
      if (action) { e.stopPropagation(); handleCharacterAction(action, card.dataset.id); }
      else openCharacterEditor(card.dataset.id);
    });
  });
}

async function openCharacterEditor(id) {
  let card = null;
  if (id) {
    try {
      const res = await apiFetch(`characters/${id}`);
      card = res.data || res;
    } catch (e) { toast("加载失败", "error"); return; }
  }
  currentCharacter = card;
  currentForm = 'character';
  
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
  
  modalEl.classList.remove("hidden");
}

async function saveCharacter() {
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
    if (currentCharacter) {
      await apiFetch(`characters/${currentCharacter.id}`, { method: "PUT", body: JSON.stringify(card) });
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

async function deleteCharacter(id) {
  if (!(await confirmDialog("确定删除？"))) return;
  try {
    await apiFetch(`characters/${id}`, { method: "DELETE" });
    toast("已删除", "success");
    loadCharacters();
  } catch (e) {
    toast(`失败: ${e.message}`, "error");
  }
}

async function exportCharacter(id, format = "json") {
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

function handleCharacterAction(action, id) {
  if (action === "edit") openCharacterEditor(id);
  else if (action === "export") exportCharacter(id, "json");
  else if (action === "delete") deleteCharacter(id);
}

// ── 导入角色卡 ──────────────────────────────────────────

async function handleImport(files) {
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
    
    importData = results;
    renderImportPreview(results);
    importModalEl.classList.remove("hidden");
  } catch (e) {
    console.error("[Import] Error:", e);
    toast(`导入失败: ${e.message}`, "error");
  }
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  // 使用 chunk 方式处理大文件，避免字符串过长
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }

// ── 对话 ──────────────────────────────────────────

async function loadConversations() {
  try {
    const res = await apiFetch("conversations");
    convList = extractArray(res);
    renderConversations();
  } catch (e) {
    conversationsListEl.innerHTML = '<div class="empty" style="padding:20px">加载失败</div>';
  }
}

function renderConversations() {
  if (convList.length === 0) {
    conversationsListEl.innerHTML = '<div class="empty" style="padding:20px">暂无对话</div>';
    return;
  }
  conversationsListEl.innerHTML = convList.map(c => `
    <div class="conv-item ${currentConv?.id === c.id ? "active" : ""}" data-id="${c.id}">
      <div class="title">${escapeHtml(c.title || "（无标题）")}</div>
      <div class="meta">${c.messageCount || 0} 条 · ${formatDate(c.updatedAt)}</div>
    </div>
  `).join("");
  conversationsListEl.querySelectorAll(".conv-item").forEach(item => {
    item.addEventListener("click", () => openConversation(item.dataset.id));
  });
}

async function openConversation(id) {
  try {
    const res = await apiFetch(`conversations/${id}`);
    currentConv = res.data || res;
    renderConversations();
    renderMessages();
    chatTitle.textContent = currentConv.title || "（无标题）";
    chatInputArea.classList.remove("hidden");
    chatActions.querySelector("#export-chat-btn")?.classList.remove("hidden");
    chatActions.querySelector("#delete-conv-btn")?.classList.remove("hidden");
  } catch (e) {
    toast("加载失败", "error");
  }
}

function renderMessages() {
  if (!currentConv || !currentConv.messages?.length) {
    messagesContainer.innerHTML = '<div class="empty">暂无消息</div>';
    return;
  }
  messagesContainer.innerHTML = currentConv.messages.map(m => `
    <div class="message ${m.role}">
      ${escapeHtml(m.content)}
      <div class="time">${formatTime(m.timestamp)}</div>
    </div>
  `).join("");
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

async function sendMessage() {
  const content = chatInput.value.trim();
  if (!content || !currentConv || isGenerating) return;
  chatInput.value = "";
  isGenerating = true;
  sendBtn.disabled = true;
  
  const userMsg = { id: Date.now(), role: "user", content, timestamp: new Date().toISOString() };
  currentConv.messages.push(userMsg);
  renderMessages();
  
  const loadingEl = document.createElement("div");
  loadingEl.className = "message assistant loading";
  loadingEl.textContent = "生成中";
  messagesContainer.appendChild(loadingEl);
  
  try {
    // 尝试流式生成
    const streamRes = await sendMessageStream(content);
    if (streamRes && streamRes.content) {
      // 流式成功，移除 loading 并添加完整消息
      loadingEl.remove();
      const assistantMsg = {
        id: Date.now(),
        role: "assistant",
        content: streamRes.content,
        timestamp: new Date().toISOString()
      };
      currentConv.messages.push(assistantMsg);
      renderMessages();
    } else {
      // 降级为同步
      const res = await apiFetch(`conversations/${currentConv.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content })
      });
      if (res.data?.assistantMessage) {
        loadingEl.remove();
        currentConv.messages.push(res.data.assistantMessage);
        renderMessages();
      } else {
        loadingEl.remove();
        toast("生成失败", "error");
      }
    }
    await loadConversations();
  } catch (e) {
    loadingEl.remove();
    toast(`发送失败: ${e.message}`, "error");
  }
  isGenerating = false;
  sendBtn.disabled = false;
  chatInput.focus();
}

async function sendMessageStream(content) {
  // 使用原生 fetch 实现流式接收
  const url = `${hana?.api?.baseUrl || '/api/apps/eleckoi-tavern/routes'}/conversations/${currentConv.id}/messages/stream`;
  
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });
    
    if (!response.ok) {
      return null;
    }
    
    const reader = response.body?.getReader();
    if (!reader) return null;
    
    const decoder = new TextDecoder();
    let fullContent = "";
    let assistantMsgEl = null;
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const text = decoder.decode(value, { stream: true });
      const lines = text.split("\n");
      
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            
            if (data.type === "chunk") {
              // 创建或更新消息元素
              if (!assistantMsgEl) {
                assistantMsgEl = document.createElement("div");
                assistantMsgEl.className = "message assistant";
                assistantMsgEl.innerHTML = '<div class="content"></div>';
                messagesContainer.appendChild(assistantMsgEl);
                loadingEl.remove();
              }
              fullContent += data.content;
              assistantMsgEl.querySelector(".content").innerHTML = escapeHtml(fullContent);
              messagesContainer.scrollTop = messagesContainer.scrollHeight;
            } else if (data.type === "done") {
              fullContent = data.content;
              if (assistantMsgEl) {
                assistantMsgEl.querySelector(".content").innerHTML = escapeHtml(fullContent);
              }
            } else if (data.type === "error") {
              console.error("Stream error:", data.error);
              return null;
            }
          } catch (e) {
            console.error("Failed to parse stream data:", e);
          }
        }
      }
    }
    
    return { content: fullContent };
  } catch (e) {
    console.error("Streaming failed:", e);
    return null;
  }
}

async function createConversation() {
  try {
    const res = await apiFetch("characters-for-conv");
    const characters = extractArray(res);
    const select = document.getElementById("conv-character-select");
    select.innerHTML = '<option value="">选择角色...</option>' + 
      characters.map(c => `<option value="${c.id}">${escapeHtml(c.name || "（无名称）")}</option>`).join("");
    if (characters.length === 0) { toast("请先创建角色卡", "error"); return; }
    newConvModalEl.classList.remove("hidden");
  } catch (e) {
    toast("加载角色失败", "error");
  }
}

async function confirmNewConversation() {
  const characterId = document.getElementById("conv-character-select").value;
  if (!characterId) { toast("请选择角色", "error"); return; }
  try {
    const res = await apiFetch("conversations", { method: "POST", body: JSON.stringify({ characterId }) });
    const conv = res.data || res;
    await loadConversations();
    await openConversation(conv.id);
    closeNewConvModal();
    toast("对话已创建", "success");
  } catch (e) {
    toast(`创建失败: ${e.message}`, "error");
  }
}

function closeNewConvModal() { newConvModalEl.classList.add("hidden"); }

async function deleteConversation() {
  if (!currentConv) return;
  if (!(await confirmDialog("确定删除此对话？"))) return;
  try {
    await apiFetch(`conversations/${currentConv.id}`, { method: "DELETE" });
    toast("已删除", "success");
    currentConv = null;
    await loadConversations();
    messagesContainer.innerHTML = '<div class="empty">选择或创建对话开始聊天</div>';
    chatInputArea.classList.add("hidden");
    chatActions.querySelector("#export-chat-btn")?.classList.add("hidden");
    chatActions.querySelector("#delete-conv-btn")?.classList.add("hidden");
    chatTitle.textContent = "选择对话";
  } catch (e) {
    toast(`删除失败: ${e.message}`, "error");
  }
}

function exportChat() {
  if (!currentConv) return;
  const blob = new Blob([JSON.stringify(currentConv, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${currentConv.title || "conversation"}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast("已导出", "success");

}

async function sendMessage() {
  const content = chatInput.value.trim();
  if (!content || !currentConv || isGenerating) return;
  chatInput.value = "";
  isGenerating = true;
  sendBtn.disabled = true;
  
  const userMsg = { id: Date.now(), role: "user", content, timestamp: new Date().toISOString() };
  currentConv.messages.push(userMsg);
  renderMessages();
  
  const loadingEl = document.createElement("div");
  loadingEl.className = "message assistant loading";
  loadingEl.textContent = "生成中";
  messagesContainer.appendChild(loadingEl);
  
  try {
    // 尝试流式生成
    const streamRes = await sendMessageStream(content);
    if (streamRes && streamRes.content) {
      // 流式成功，移除 loading 并添加完整消息
      loadingEl.remove();
      const assistantMsg = {
        id: Date.now(),
        role: "assistant",
        content: streamRes.content,
        timestamp: new Date().toISOString()
      };
      currentConv.messages.push(assistantMsg);
      renderMessages();
    } else {
      // 降级为同步
      const res = await apiFetch(`conversations/${currentConv.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content })
      });
      if (res.data?.assistantMessage) {
        loadingEl.remove();
        currentConv.messages.push(res.data.assistantMessage);
        renderMessages();
      } else {
        loadingEl.remove();
        toast("生成失败", "error");
      }
    }
    await loadConversations();
  } catch (e) {
    loadingEl.remove();
    toast(`发送失败: ${e.message}`, "error");
  }
  isGenerating = false;
  sendBtn.disabled = false;
  chatInput.focus();
}

async function sendMessageStream(content) {
  // 使用原生 fetch 实现流式接收
  const url = `${hana?.api?.baseUrl || '/api/apps/eleckoi-tavern/routes'}/conversations/${currentConv.id}/messages/stream`;
  
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });
    
    if (!response.ok) {
      return null;
    }
    
    const reader = response.body?.getReader();
    if (!reader) return null;
    
    const decoder = new TextDecoder();
    let fullContent = "";
    let assistantMsgEl = null;
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const text = decoder.decode(value, { stream: true });
      const lines = text.split("\n");
      
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            
            if (data.type === "chunk") {
              // 创建或更新消息元素
              if (!assistantMsgEl) {
                assistantMsgEl = document.createElement("div");
                assistantMsgEl.className = "message assistant";
                assistantMsgEl.innerHTML = '<div class="content"></div>';
                messagesContainer.appendChild(assistantMsgEl);
                loadingEl.remove();
              }
              fullContent += data.content;
              assistantMsgEl.querySelector(".content").innerHTML = escapeHtml(fullContent);
              messagesContainer.scrollTop = messagesContainer.scrollHeight;
            } else if (data.type === "done") {
              fullContent = data.content;
              if (assistantMsgEl) {
                assistantMsgEl.querySelector(".content").innerHTML = escapeHtml(fullContent);
              }
            } else if (data.type === "error") {
              console.error("Stream error:", data.error);
              return null;
            }
          } catch (e) {
            console.error("Failed to parse stream data:", e);
          }

        role: "assistant",
        content: streamRes.content,
        timestamp: new Date().toISOString()
      };
      currentConv.messages.push(assistantMsg);
    } else {
      // 降级为一次性生成
      streamEl.remove();
      const res = await apiFetch(`conversations/${currentConv.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content })
      });
      if (res.data?.assistantMessage) {
        currentConv.messages.push(res.data.assistantMessage);
      } else {
        toast("生成失败", "error");
      }
    }
    await loadConversations();
  } catch (e) {
    streamEl.remove();
    toast(`发送失败: ${e.message}`, "error");
  }
  renderMessages();
  isGenerating = false;
  sendBtn.disabled = false;
  chatInput.focus();
}

// 流式接收：接收器 / 事件解析器都做成纯函数，便于单独验证

