// chat.js — 由 characters.js 按功能拆分（B5）

import { hana } from "../sdk.js";
import { apiFetch, apiUrl, confirmDialog, escapeHtml, extractArray, formatTime, friendlyError, toast, unwrap } from "./core.js";
import { renderMarkdown } from "./markdown.js";
// 宏引擎用 ui/assets/lib/macros.js（/ui/ 可达域内的镜像）。
// 早期写成 ../../../lib/... —— URL 层级多 _surface/<token> 两级，且 lib/
// 不在 /ui/ 暴露域：整张模块图 404，页面停在"加载中"的静态初始态。
import { createMacroProcessor, contextFromCharacter } from "../lib/macros.js";
import { openDrawer } from "./shell.js";
import { dom } from "./dom.js";
import { state } from "./state.js";


export function renderMessages() {
  if (!state.currentConv || !state.currentConv.messages?.length) {
    dom.messagesContainer.innerHTML = '<div class="empty">暂无消息</div>';
    return;
  }

  // 消息文本先过宏，再进渲染。不跑的后果是 {{char}} 原样出现在气泡里——
  // 玩家看到的是模板而不是角色在说话。
  const macro = state.macro || null;
  const expand = (text) => {
    const raw = String(text ?? "");
    return macro ? macro.process(raw) : raw;
  };

  dom.messagesContainer.innerHTML = state.currentConv.messages.map(m => {
    const body = m.role === "assistant"
      ? renderMarkdown(expand(m.content))
      : escapeHtml(expand(m.content));
    const acts = `<div class="msg-acts">
        <button class="mini" data-act="copy" data-id="${m.id}" title="复制">复制</button>
        <button class="mini" data-act="edit" data-id="${m.id}">编辑</button>
        <button class="mini" data-act="del" data-id="${m.id}">删除</button>
        ${m.role === "assistant" ? `<button class="mini" data-act="swipe" data-id="${m.id}">换一版</button>
        <button class="mini" data-act="regen" data-id="${m.id}">重生</button>` : ""}
      </div>`;
    return `<div class="message ${m.role}" data-id="${m.id}">
      <div class="bubble">${body}</div>
      ${acts}
      <div class="time">${formatTime(m.timestamp)}</div>
    </div>`;
  }).join("");

  // 事件委托：消息多了逐个绑会很慢，而且重渲染后要重绑一遍
  dom.messagesContainer.querySelectorAll(".message").forEach(el => {
    const id = el.dataset.id;
    el.querySelector('[data-act="copy"]')?.addEventListener("click", () => copyMessage(id));
    el.querySelector('[data-act="edit"]')?.addEventListener("click", () => startEditMessage(id));
    el.querySelector('[data-act="del"]')?.addEventListener("click", () => deleteMessage(id));
    el.querySelector('[data-act="swipe"]')?.addEventListener("click", () => swipeVariant(id));
    el.querySelector('[data-act="regen"]')?.addEventListener("click", () => regenerateFrom(id));
  });

  dom.messagesContainer.scrollTop = dom.messagesContainer.scrollHeight;

  // 候选项跟着消息走：最后一条 assistant 换了（发新消息、重生、删），
  // 这里就自动跟着换或消失。
  renderSuggestions();
}


export async function sendMessage() {
  const content = dom.chatInput.value.trim();
  if (!content || !state.currentConv || state.isGenerating) return;
  dom.chatInput.value = "";
  state.isGenerating = true;
  dom.sendBtn.disabled = true;

  const userMsg = { id: Date.now(), role: "user", content, timestamp: new Date().toISOString() };
  state.currentConv.messages.push(userMsg);
  renderMessages();

  const loadingEl = document.createElement("div");
  loadingEl.className = "message assistant loading";
  loadingEl.textContent = "生成中";
  dom.messagesContainer.appendChild(loadingEl);

  const streamEl = loadingEl;
  try {
    // 优先走流式；失败或不可用时降级为一次性生成
    const streamRes = await sendMessageStream(content);

    if (streamRes && streamRes.content) {
      // 流式成功，移除 loading 并添加完整消息
      loadingEl.remove();
      const assistantMsg = {
        id: Date.now(),
        role: "assistant",
        content: fullContent,
        timestamp: new Date().toISOString()
      };
      state.currentConv.messages.push(assistantMsg);
      renderMessages();
    } else {
      // 降级为同步
      const res = await apiFetch(`conversations/${state.currentConv.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content })
      });
      if (res.data?.assistantMessage) {
        loadingEl.remove();
        state.currentConv.messages.push(res.data.assistantMessage);
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
  state.isGenerating = false;
  dom.sendBtn.disabled = false;
  dom.chatInput.focus();
}

export async function sendMessageStream(content) {
  // 使用原生 fetch 实现流式接收
  // URL 由 hana.api.url() 拼：它带上 appSurfaceSession，
  // 而裸 fetch 到 /api/apps/... 拿不到 session，会被宿主当未授权。
  // 早期这里写的是 hana?.api?.baseUrl || 硬编码路径，既没 import hana
  // （ReferenceError），baseUrl 在 SDK 里也不存在。
  const url = hana.api.url(`conversations/${state.currentConv.id}/messages/stream`);
  
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

    // 气泡的建立与重绘各自抽成一件小事。
    // 为什么必须有：事件名一旦对不上，气泡就永远不会被建，
    // 而最后那条 done 又只在「气泡已存在」时才更新它——
    // 两处合起来就是「数据全到了，屏幕上什么都没有」。
    const ensureBubble = () => {
      if (assistantMsgEl) return;
      assistantMsgEl = document.createElement("div");
      assistantMsgEl.className = "message assistant";
      assistantMsgEl.innerHTML = '<div class="content"></div>';
      dom.messagesContainer.appendChild(assistantMsgEl);
      try { loadingEl?.remove(); } catch { /* 已经拿掉 */ }
    };
    const paint = () => {
      if (!assistantMsgEl) return;
      assistantMsgEl.querySelector(".content").innerHTML = escapeHtml(fullContent);
      dom.messagesContainer.scrollTop = dom.messagesContainer.scrollHeight;
    };
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const text = decoder.decode(value, { stream: true });
      const lines = text.split("\n");
      
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            
            // 后端推的是 `delta`（见 lib/conversations/routes.js 那套：
            // delta / reasoning / usage / cancelled / error / done）。
            // 这里曾经只认 `chunk`——**一个词之差，回复就永远渲染不出来**。
            // `chunk` 留作别名，不碍事。
            if (data.type === "delta" || data.type === "chunk") {
              ensureBubble();
              fullContent += data.content ?? "";
              paint();
            } else if (data.type === "done") {
              fullContent = data.content ?? fullContent;
              ensureBubble();   // 一帧增量都没收到，结果也得站出来
              paint();
            } else if (data.type === "cancelled") {
              // 用户点了停止：把已经到的半截留在屏上，不当作失败
              fullContent = data.content ?? fullContent;
              ensureBubble();
              paint();
            } else if (data.type === "usage") {
              // 观测链：缓存命中率的数字从这里来。两系字段都认——
              // Anthropic: cache_read_input_tokens；OpenAI 兼容: prompt_tokens_details.cached_tokens
              state.lastUsage = data.usage || null;
              renderUsageBar();
            } else if (data.type === "error") {
              console.error("Stream error:", data.error);
              return null;
            }
          } catch (e) {
            console.error("Failed to parse stream data:", e);
          }
      }
    }
    // while (true) 的闭合
    }

    return { role: "assistant", content: fullContent };
  } catch (e) {
    console.error("Stream failed:", e);
    return null;
  }
}

export async function createConversation() {
  try {
    const res = await apiFetch("characters-for-conv");
    const characters = extractArray(res);
    const select = document.getElementById("conv-character-select");
    select.innerHTML = '<option value="">选择角色...</option>' + 
      characters.map(c => `<option value="${c.id}">${escapeHtml(c.name || "（无名称）")}</option>`).join("");
    if (characters.length === 0) { toast("请先创建角色卡", "error"); return; }
    dom.newConvModalEl.classList.remove("hidden");
  } catch (e) {
    toast("加载角色失败", "error");
  }
}

export async function confirmNewConversation() {
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

export function closeNewConvModal() { dom.newConvModalEl.classList.add("hidden"); }

export async function deleteConversation() {
  if (!state.currentConv) return;
  if (!(await confirmDialog("确定删除此对话？"))) return;
  try {
    await apiFetch(`conversations/${state.currentConv.id}`, { method: "DELETE" });
    toast("已删除", "success");
    state.currentConv = null;
    await loadConversations();
    dom.messagesContainer.innerHTML = '<div class="empty">选择或创建对话开始聊天</div>';
    dom.chatInputArea.classList.add("hidden");
    dom.chatActions.querySelector("#export-chat-btn")?.classList.add("hidden");
    dom.chatActions.querySelector("#delete-conv-btn")?.classList.add("hidden");
    dom.chatTitle.textContent = "选择对话";
  } catch (e) {
    toast(`删除失败: ${e.message}`, "error");
  }
}

export function exportChat() {
  if (!state.currentConv) return;
  const blob = new Blob([JSON.stringify(state.currentConv, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${state.currentConv.title || "conversation"}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast("已导出", "success");

}


// ── 消息级操作 ───────────────────────────────────────

/** 按 id 找消息（找不到返回 null）。 */
export function findMessage(id) {
  const msgs = state.currentConv?.messages || [];
  return msgs.find(m => String(m.id) === String(id)) || null;
}

/** 删一条消息。 */
export async function deleteMessage(id) {
  const msg = findMessage(id);
  if (!msg) return;
  const ok = await confirmDialog("删除这条消息？");
  if (!ok) return;
  try {
    state.currentConv.messages = state.currentConv.messages.filter(m => m !== msg);
    renderMessages();
    // 单条消息有自己的端点——之前这里写的是「整会话 PUT」，
    // 而那条路由后端从来没有过，所以删一条消息只会弹「删除失败」然后回滚。
    await apiFetch(
      `conversations/${state.currentConv.id}/messages/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
  } catch (e) {
    toast("删除失败: " + friendlyError(e), "error");
    await reloadCurrentConv();
  }
}

/** 进入编辑：把消息内容搬进输入框，记下正在编辑的 id。 */
export function startEditMessage(id) {
  const msg = findMessage(id);
  if (!msg) return;
  dom.chatInput.value = msg.content || "";
  state.editingMessageId = id;
  dom.chatInput.focus();
  const btn = document.getElementById("send-btn");
  if (btn) btn.textContent = "保存修改";
}

/** 复制消息文本。 */
export async function copyMessage(id) {
  const msg = findMessage(id);
  if (!msg) return;
  try {
    await navigator.clipboard.writeText(String(msg.content || ""));
    toast("已复制", "success");
  } catch (e) {
    toast("复制失败: " + friendlyError(e), "error");
  }
}

/** 换一版：在同一条目下生成新回复（不动原回复）。 */
export async function swipeVariant(id) {
  const msg = findMessage(id);
  if (!msg || state.isGenerating) return;
  const idx = state.currentConv.messages.indexOf(msg);
  const prevUser = [...state.currentConv.messages.slice(0, idx)].reverse().find(m => m.role === "user");
  state.isGenerating = true;
  try {
    const res = await apiFetch(`conversations/${state.currentConv.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        role: "assistant",
        content: "",
        variantOf: id,
        basedOn: prevUser ? prevUser.content : ""
      })
    });
    const data = res.data || res;
    const created = data.assistantMessage || data;
    if (created && created.id) {
      // 插在原消息之后，作为新的一版
      state.currentConv.messages.splice(idx + 1, 0, created);
      renderMessages();
    }
  } catch (e) {
    toast("换版失败: " + friendlyError(e), "error");
  } finally {
    state.isGenerating = false;
  }
}

/** 从这条 assistant 消息处重生（丢掉它自己，重新生成）。 */
export async function regenerateFrom(id) {
  const msg = findMessage(id);
  if (!msg || state.isGenerating) return;
  const idx = state.currentConv.messages.indexOf(msg);
  const prevUser = [...state.currentConv.messages.slice(0, idx)].reverse().find(m => m.role === "user");
  if (!prevUser) { toast("找不到对应的用户消息", "error"); return; }

  state.isGenerating = true;
  try {
    // 先删掉旧的，再让它重新生成
    state.currentConv.messages.splice(idx, 1);
    renderMessages();
    const res = await apiFetch(`conversations/${state.currentConv.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ role: "assistant", content: "", regenerateFrom: prevUser.id })
    });
    const data = res.data || res;
    const created = data.assistantMessage || data;
    if (created && created.id) {
      state.currentConv.messages.push(created);
      renderMessages();
    }
  } catch (e) {
    toast("重生失败: " + friendlyError(e), "error");
  } finally {
    state.isGenerating = false;
  }
}

/** 停止当前生成。 */
export function stopGeneration() {
  if (!state.isGenerating) return;
  state.abortGeneration = true;
  state.isGenerating = false;
  dom.sendBtn && (dom.sendBtn.disabled = false);
  toast("已停止", "info");
}

/**
 * 让消息列表跟着最新消息滚动（仅在用户本就贴近底部时）。
 *
 * 用户往上翻看历史时不应该被强行拉回底部——那很恼人。
 */
export function bindScrollFollow() {
  const el = dom.messagesContainer;
  if (!el) return;
  el.addEventListener("scroll", () => {
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    state.followTail = nearBottom;
  });
}

/** 重新拉当前对话（用于操作失败后回滚视图）。 */
async function reloadCurrentConv() {
  try {
    const res = await apiFetch(`conversations/${state.currentConv.id}`);
    state.currentConv = res.data || res;
    renderMessages();
  } catch { /* 回滚失败就不再补刀 */ }
}

// ── 对话列表与打开 ───────────────────────────────────

/** 拉对话列表并渲染。 */
export async function loadConversations() {
  try {
    const res = await apiFetch("conversations");
    state.convList = extractArray(res);
    renderConversations();
  } catch (e) {
    console.error("[Conversations] load failed:", e);
  }
}

/** 渲染对话列表。 */
export function renderConversations() {
  const el = dom.conversationsListEl;
  if (!el) return;
  const list = state.convList || [];

  el.innerHTML = list.length === 0
    ? '<div class="empty" style="padding:20px">暂无对话</div>'
    : list.map(c => `<div class="conv-item ${state.currentConv?.id === c.id ? "active" : ""}" data-id="${c.id}">
        <div class="title">${escapeHtml(c.title || "（无标题）")}</div>
        <div class="meta">${c.messageCount || (c.messages?.length ?? 0)} 条 · ${formatTime(c.updatedAt || c.updated_at)}</div>
      </div>`).join("");

  el.querySelectorAll(".conv-item").forEach(item => {
    item.addEventListener("click", () => openConversation(item.dataset.id));
  });
}

// 读数条「关掉」是记忆，不是这一次的临时状态——刷新后不该自己冒回来。
const GEN_META_OFF_KEY = "eleckoi:gen-meta-off";

function genMetaOff() {
  try { return localStorage.getItem(GEN_META_OFF_KEY) === "1"; } catch { return false; }
}

/**
 * 关掉读数条。只藏，不改任何采集——下次生成照样记 usage，只是不摆出来。
 */
// ── 行动候选项（正文之后的岔路）────────────────────

/** 正在向模型要方向——防连点。 */
let suggesting = false;

/**
 * 画候选项。
 *
 * 只取**最后一条 assistant 消息**上的那一组：候选项属于「这一轮之后能做什么」，
 * 附在消息上就不会出现「三轮前的选项还挂在输入框上方」。
 */
export function renderSuggestions() {
  const el = dom.suggestRowEl || document.getElementById("suggest-row");
  if (!el) return;

  const msgs = state.currentConv?.messages || [];
  const lastAssistant = [...msgs].reverse().find(m => m.role === "assistant");
  const items = Array.isArray(lastAssistant?.suggestions) ? lastAssistant.suggestions : [];

  if (items.length === 0) {
    el.innerHTML = "";
    el.classList.add("hidden");
    return;
  }

  el.classList.remove("hidden");
  el.innerHTML = items
    .map((s, i) => `<button type="button" class="suggest-chip" data-i="${i}">${escapeHtml(s.text || "")}</button>`)
    .join("");

  el.querySelectorAll(".suggest-chip").forEach((btn, i) => {
    btn.addEventListener("click", () => {
      // 点一下**填进输入框**，不直接发。
      // 候选项是起点不是命令——人常常想改两个字再发。
      dom.chatInput.value = items[i].text || "";
      dom.chatInput.focus();
    });
  });
}

/** 向模型要几个方向。独立一次调用，结果挂在消息上、不进正文 prompt。 */
export async function requestSuggestions() {
  const conv = state.currentConv;
  const btn = dom.suggestBtn || document.getElementById("suggest-btn");
  if (!conv || suggesting) return;

  suggesting = true;
  if (btn) { btn.disabled = true; btn.textContent = "在想…"; }
  try {
    const res = await apiFetch(`conversations/${conv.id}/suggestions`, {
      method: "POST",
      body: JSON.stringify({})
    });
    const data = unwrap(res);
    const items = Array.isArray(data?.items) ? data.items : [];

    // 服务端已经落盘，这里只补内存里那一条，不整场重拉
    const lastAssistant = [...(conv.messages || [])].reverse().find(m => m.role === "assistant");
    if (lastAssistant && items.length > 0) lastAssistant.suggestions = items;
    renderSuggestions();

    if (items.length === 0) {
      toast(data?.note ? `没给出可用的方向：${data.note}` : "没给出可用的方向", "error");
    } else if (data?.note) {
      toast(data.note, "info");
    }
  } catch (e) {
    toast("拿方向失败: " + friendlyError(e), "error");
  } finally {
    suggesting = false;
    if (btn) { btn.disabled = false; btn.textContent = "给点方向"; }
  }
}

/** 输入区上的绑定。main.js 的 init 里调一次。 */
export function bindComposer() {
  const btn = dom.suggestBtn || document.getElementById("suggest-btn");
  if (btn && btn.dataset.bound !== "1") {
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => requestSuggestions());
  }
}

export function hideUsageBar() {
  try { localStorage.setItem(GEN_META_OFF_KEY, "1"); } catch { /* 隐身模式 */ }
  document.getElementById("gen-meta")?.classList.add("hidden");
}

/**
 * 输入区上方的生成状态条：本轮 token 与缓存命中率。
 *
 * 缓存命中是钱和延迟的直读数——本地 vLLM 的 prefix cache、
 * API 侧的 prompt cache 都反映在两系字段里，这里统一收口显示。
 * 没有缓存字段的后端显示 “—”，不装作有。
 */
export function renderUsageBar() {
  const bar = document.getElementById("gen-meta");
  if (!bar) return;

  // 关掉了（用户按过 ×），或者还没有对话 → 不占位。
  // 有对话但还没生成过 → 显示「—」：说不知道，比不显示诚实。
  if (genMetaOff() || !state.currentConv) { bar.classList.add("hidden"); return; }

  const u = state.lastUsage;
  const prompt = u?.prompt_tokens ?? u?.input_tokens ?? null;
  const cached = u?.cache_read_input_tokens ?? u?.prompt_tokens_details?.cached_tokens ?? 0;

  const tEl = document.getElementById("gen-tokens");
  const cEl = document.getElementById("gen-cache");

  bar.classList.remove("hidden");
  if (tEl) tEl.textContent = prompt == null
    ? "上下文 —"
    : `上下文 ${prompt >= 1000 ? (prompt / 1000).toFixed(1) + "k" : prompt}`;
  if (cEl) {
    if (cached > 0 && prompt > 0) {
      const pct = Math.round((cached / prompt) * 100);
      cEl.textContent = `缓存 ${pct}%`;
      cEl.classList.toggle("hit", pct >= 60);   // 60% 是行业基准线：低于它=结构病
    } else {
      cEl.textContent = "缓存 —";
      cEl.classList.remove("hit");
    }
  }
}

/** 打开一个对话：拉全文、渲染、显示输入区。 */
export async function openConversation(id) {
  try {
    const res = await apiFetch(`conversations/${encodeURIComponent(id)}`);
    state.currentConv = res.data || res;

    // 建宏上下文。消息渲染与发送都要用它，缺了它 {{char}} 会原样出现在气泡里。
    // 变量从对话记录取——那是唯一真源。
    const char = await apiFetch(`characters/${encodeURIComponent(state.currentConv.characterId)}`)
      .then(r => r.data || r)
      .catch(() => null);
    state.currentCharacter = char;
    state.macro = buildMacroContext(char, state.currentConv);

    renderConversations();
    renderMessages();
    if (dom.chatTitle) {
      /*
       * 写「你在跟谁说话」，不写自动生成的对话名。
       *
       * 后端会把首条消息截成对话标题（repo.js:158，那是给列表用的），
       * 直接摆到顶栏当大标题，读起来就是「用户那句话成了这一场的题目」。
       */
      dom.chatTitle.textContent =
        state.currentCharacter?.name || state.currentConv.characterName || state.currentConv.title || "（无标题）";
    }
    if (dom.chatMeta) {
      const n = state.currentConv.messages?.length || 0;
      dom.chatMeta.textContent = n > 0 ? `第 ${Math.ceil(n / 2)} 轮` : "还没开始";
      dom.chatMeta.classList.remove("hidden");
    }
    dom.chatInputArea?.classList.remove("hidden");
    dom.chatActions?.querySelector("#export-chat-btn")?.classList.remove("hidden");
    dom.chatActions?.querySelector("#delete-conv-btn")?.classList.remove("hidden");
    dom.chatInput?.focus();

    // 上一条对话的 usage 摆在新的对话头上是假读数——清掉，等这一场生成时再出数
    state.lastUsage = null;
    renderUsageBar();

    // 换了对话，本场的黑板格也换了。面板开着就重拉，
    // 否则显示的是上一场的格子——私密格尤其不能快照错对象。
    if (!document.getElementById("drawer-board")?.classList.contains("hidden")) {
      const { loadBoard } = await import("./board.js");
      await loadBoard();
    }

    // 预设也是跟对话走的：换一场就得重画「这一场在用」那个标。
    if (!document.getElementById("drawer-presets")?.classList.contains("hidden")) {
      const { renderPresets } = await import("./presets.js");
      renderPresets(state.presetList || []);
    }

    // 角色上下文态：开对话 = 右栏自动站出角色卡。
    // reload:true 绕开 openDrawer 的同名 toggle——连续开会话不该被误关。
    openDrawer("character", { reload: true });
  } catch (e) {
    console.error("[Conversations] open failed:", e);
    toast("打开对话失败: " + friendlyError(e), "error");
  }
}

/**
 * 建宏处理器与上下文。
 *
 * 复用同一个处理器实例（无状态，可复用），上下文随角色/对话重建。
 */
function buildMacroContext(character, conv) {
  const mp = createMacroProcessor();
  const ctx = contextFromCharacter(character || {}, {
    userName: conv?.userName || "User",
    persona: conv?.persona || "",
    variables: conv?.variables && typeof conv.variables === "object" ? conv.variables : {},
    globalVariables: {}
  });
  return { mp, ctx, process: (t) => mp.process(t, ctx) };
}
