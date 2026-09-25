// characters.js — 由 characters.js 按功能拆分（B5）

import { apiBlobUrl, apiFetch, apiUrl, confirmDialog, escapeHtml, extractArray, formatDate, friendlyError, toast } from "./core.js";
import { dom, showEditForm } from "./dom.js";
import { state } from "./state.js";


export function renderCharacters(characters) {
  // 页内侧栏已按产品决定删除（列表由宿主 rail 独家承担）——
  // 元素不在就整段空转，保留函数是为存住 main.js 的 import 与
  // saveCharacter 后的刷新调用链，不为真渲染。
  if (!dom.listEl || !dom.countEl) return;
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
    } catch (e) { toast("加载角色失败：" + friendlyError(e), "error"); return; }
  }
  state.currentCharacter = card;
  state.currentForm = 'character';
  
  const form = document.getElementById("character-form");
  form.reset();
  
  // 隐藏所有表单、只显示角色那张（这一步以前只写在这里，
  // 其余四个编辑器都缺——见 dom.js 的 showEditForm）
  showEditForm("character");
  
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
    // 出图入口：只有编辑**已有**的卡时才出现（新卡还没有 id，出完图没地方放）
    document.getElementById("modal-portrait").classList.remove("hidden");
    const pnote = document.getElementById("modal-portrait-note");
    if (pnote) pnote.textContent = "";
    const { bindModalPortrait } = await import("./media.js");
    bindModalPortrait();
  } else {
    document.getElementById("modal-title").textContent = "新建角色";
    document.getElementById("modal-delete").classList.add("hidden");
    document.getElementById("modal-export-st").classList.add("hidden");
    // 新卡还没 id：出完图没地方放，所以这个入口不显示。
    // 但**得说出来**——不写一个字的话，用户写完一张卡找不到“生成立绘”，
    // 会以为是自己漏了步骤。（复核点出来的：这里原本只是把 note 清空。）
    document.getElementById("modal-portrait").classList.add("hidden");
    const pnote = document.getElementById("modal-portrait-note");
    if (pnote) pnote.textContent = "保存之后就能生成立绘了（先有卡，才有地方放图）";
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
    // 说缺哪一项。只说“请填写必填字段”，用户得自己去猜是三个里的哪一个。
    const miss = [];
    if (!card.name) miss.push("名称");
    if (!card.description) miss.push("描述");
    if (!card.first_mes) miss.push("开场白");
    toast(`还缺：${miss.join("、")}`, "error");
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
  // 全 App 里**最贵**的一次删除：后端把整个角色目录递归删掉（连头像）。
  // 所以确认话必须写清“删的是谁”与“会少什么”——四个字的“确定删除？”配不上这个代价。
  const card = (state.charList || []).find((c) => String(c.id) === String(id));
  const name = card?.name || "这张卡";
  const convs = (state.convList || []).filter((c) => String(c.characterId) === String(id)).length;
  if (!(await confirmDialog({
    title: `删掉「${name}」？`,
    body: `头像${convs ? `、${convs} 场对话` : ""}、前情提要、给她的声音分配都会一起删掉。`
  }))) return;
  try {
    await apiFetch(`characters/${id}`, { method: "DELETE" });
    toast("已删除", "success");
    loadCharacters();
  } catch (e) {
    toast("删除失败：" + friendlyError(e), "error");
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
      toast("这个文件里没读到内容——是不是选错文件了？", "error");
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
      toast("这个文件里没有识别到角色卡（要 .json）", "error");
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
    if (bad.length > 0) {
      // 带上第一张的名字：只说“N 张失败”，用户连是哪张都不知道。
      const first = bad[0]?.name || bad[0]?.file || "第一张";
      toast(`${bad.length} 张没导进来（先从「${first}」看起）：${friendlyError(bad[0]?.error || bad[0])}`, "error");
    }

    closeImportModal();
    await loadCharacters();
  } catch (e) {
    console.error("[Import] commit failed:", e);
    toast("导入失败: " + friendlyError(e), "error");
  }
}

// ── 右栏 · 当前角色上下文 ────────────────────────────

/**
 * 渲染右栏的"当前角色"面板。
 *
 * v3 的灵魂：开对话时右栏自动站出角色卡——身份、设定、开场白
 * 随时可瞥，不再埋进二级抽屉。数据来自 openConversation 已拉好的
 * state.currentCharacter，这里只做渲染。
 *
 * @param {number} [greetIdx] - 开场白轮换的当前下标（默认 0）
 */
export async function renderCharContext(greetIdx = 0) {
  const box = document.getElementById("char-ctx-body");
  if (!box) return;

  const c = state.currentCharacter;
  if (!c) {
    box.innerHTML = '<div class="empty">尚未打开对话</div>';
    return;
  }

  // 开场白集：主 + 备选，与 seedGreeting 的取材一致
  const greets = [String(c.first_mes || "").trim(),
    ...(Array.isArray(c.alternate_greetings) ? c.alternate_greetings : [])]
    .map(x => String(x || "").trim())
    .filter(Boolean);
  const gi = greets.length === 0 ? 0 : ((greetIdx % greets.length) + greets.length) % greets.length;

  const initial = String(c.name || "?").trim().slice(0, 1) || "?";
  const tags = (Array.isArray(c.tags) ? c.tags : []).slice(0, 8);
  const descRaw = String(c.description || "").trim();
  /*
   * 预览文本也过一遍宏。
   *
   * 卡里的字段本身存的就是 `{{char}}没有回头`这种写法，
   * 宏在发送前才展开。面板上原样摆着，读起来像坏掉了——
   * 而聊天区那个「开场」块是展开过的，两个地方一个口径才对。
   */
  const preview = (t) => {
    const raw = String(t ?? "");
    return state.macro ? state.macro.process(raw) : raw;
  };
  const desc = descRaw ? preview(descRaw) : "";
  const ver = String(c.character_version || "1.0");
  const creator = String(c.creator || "ophelia");

  const greetHtml = greets.length > 0
    ? `
      <div class="greet-box">
        <div class="greet-head">
          <span>开场白 <b id="greet-idx">${gi + 1}/${greets.length}</b> · 新建对话时随机取一条</span>
          <span class="greet-nav">
            <button id="greet-prev" title="上一条">‹</button>
            <button id="greet-next" title="下一条">›</button>
          </span>
        </div>
        <div class="greet-text" id="greet-text">${escapeHtml(preview(greets[gi]))}</div>
      </div>`
    : "";

  /*
   * 前情提要：被折叠掉的旧历史压出来的骨架。
   *
   * 它是**有损**的——所以必须看得见、改得了。
   * 用户看不见的压缩，等于背着他丢东西。
   * 「清掉」是安全操作：折叠每轮按预算重算，消息一条不少。
   */
  const sum = state.currentConv?.summary || null;
  const summaryHtml = `
    <div class="ctx-summary">
      <div class="ctx-summary-head">
        <span>前情提要</span>
        ${sum?.byModel ? `<span class="dim">模型写的</span>` : sum?.text ? `<span class="dim">机械骨架</span>` : ""}
        ${sum?.coveredCount ? `<span class="dim">盖住 ${sum.coveredCount} 条</span>` : ""}
      </div>
      ${sum?.text
        ? `<textarea id="ctx-summary-text" rows="4" spellcheck="false">${escapeHtml(sum.text)}</textarea>
           <div class="ctx-summary-acts">
             <button type="button" class="mini" id="ctx-summary-save">保存</button>
             <button type="button" class="mini" id="ctx-summary-llm" title="再调用一次模型，把旧历史重写一遍">让模型重写</button>
             <button type="button" class="mini" id="ctx-summary-clear">清掉</button>
           </div>`
        : `<div class="ctx-summary-empty">还没折叠过——历史超出预算时，最早的那几条会压成一段骨架放在这里。</div>
           <div class="ctx-summary-acts">
             <button type="button" class="mini" id="ctx-summary-llm" title="调用一次模型，现在就把旧历史压成一段前情提要">让模型写一份</button>
           </div>`}
    </div>`;

  /*
   * 同场角色：谁在这一场里。
   *
   * 过去这事只能在**建对话**时定，之后加不了也减不了——想加第三个人
   * 只能重开一场，等于把上下文全丢了。
   * 服务端那条路是严格的（主角不在名单里就报错，不安静换）；
   * 界面的活是**替他把话说完**：自动把第一位当新主角带上，并说明白。
   */
  const castIds = Array.isArray(state.currentConv?.characterIds) && state.currentConv.characterIds.length > 0
    ? state.currentConv.characterIds
    : (state.currentConv?.characterId ? [state.currentConv.characterId] : []);
  const nameOf = (id) =>
    (state.charList || []).find((x) => String(x.id) === String(id))?.name || "（已删除）";
  const castHtml = state.currentConv ? `
    <div class="ctx-cast">
      <div class="ctx-cast-head">
        <span>同场角色</span>
        <span class="dim">${castIds.length} 位</span>
      </div>
      <div class="ctx-cast-now">${castIds.map((id) => escapeHtml(nameOf(id))).join(" · ")}</div>
      <select id="ctx-cast-select" multiple size="5">
        ${(state.charList || []).map((ch) => `<option value="${escapeHtml(ch.id)}"${castIds.includes(ch.id) ? " selected" : ""}>${escapeHtml(ch.name)}</option>`).join("")}
      </select>
      <div class="ctx-cast-acts">
        <button type="button" class="mini" id="ctx-cast-save">保存名单</button>
      </div>
      <div class="dim ctx-cast-note" id="ctx-cast-note">选一个=单人；多个=群聊。第一位是主角。新加进来的人没有开场白。</div>
    </div>` : "";

  // 有头像就画头像，没有才退回首字母。
  // 之前这里只会画首字母，于是「生成立绘」成功后界面上什么都没变——
  // 用户唯一的反馈是一行 toast，看上去就像没成。
  let avaPending = false;
  if (c.has_avatar) {
    try { apiUrl(`characters/${c.id}/avatar`); avaPending = true; } catch { avaPending = false; }
  }

  box.innerHTML = `
    <div class="char-ctx-head">
      <div class="char-ctx-ava">${avaPending
        ? `<img data-ava="${escapeHtml(String(c.id))}" alt="">`
        : escapeHtml(initial)}</div>
      <div>
        <div class="char-ctx-name">${escapeHtml(c.name || "（未命名）")}</div>
        <div class="char-ctx-sub">${escapeHtml(creator)} · v${escapeHtml(ver)}</div>
      </div>
    </div>
    <div class="char-ctx-desc${desc ? "" : " is-empty"}">${desc ? escapeHtml(desc) : "还没有描述"}</div>
    ${tags.length > 0 ? `<div class="char-ctx-tags">${tags.map(t => `<span>${escapeHtml(t)}</span>`).join("")}</div>` : ""}
    ${greetHtml}
    ${summaryHtml}
    ${castHtml}
    <div class="char-ctx-actions">
      <button class="btn btn-sm" data-ctx="edit">编辑</button>
      <button class="btn btn-sm" id="ctx-portrait">生成立绘</button>
      <button class="btn btn-sm" data-ctx="export">导出</button>
      <button class="btn btn-sm danger" data-ctx="delete">删除</button>
    </div>
    <div class="char-ctx-note" id="ctx-portrait-note"></div>`;

  // 头像：不能让 <img> 拿着裸 URL 去撞门。真机里那条请求回的是 403——
  // 请求 URL 里连 /_surface/<票据>/ 那段都没有，而 <img> 又不会自己带鉴权。
  // 所以改用带鉴权的 fetch 取字节、转 blob，再交给 <img>；取不回来就退回首字母。
  const avaImg = box.querySelector("img[data-ava]");
  if (avaImg) {
    apiBlobUrl(`characters/${avaImg.dataset.ava}/avatar`)
      .then((url) => { avaImg.src = url; })
      .catch(() => {
        const slot = avaImg.parentElement;
        if (slot) slot.textContent = initial;
      });
  }

  // 同场角色：保存名单。
  box.querySelector("#ctx-cast-save")?.addEventListener("click", async () => {
    const sel = box.querySelector("#ctx-cast-select");
    if (!sel) return;
    const ids = [...sel.selectedOptions].map((o) => o.value);
    const note = box.querySelector("#ctx-cast-note");
    if (ids.length === 0) {
      // 本地先说，不白跑一趟服务端（那边也会报同样的话）。
      if (note) note.textContent = "至少留一位——一场没法说话的对话没有意义。";
      return;
    }
    const body = { characterIds: ids };
    if (!ids.includes(String(state.currentConv?.characterId || ""))) {
      // 服务端不安静换主角（它只报错）。这里替他把话说完。
      body.characterId = ids[0];
      if (note) note.textContent = `主角换成 ${nameOf(ids[0])} 了（原来的那位不在新名单里）。`;
    }
    try {
      const res = await apiFetch(`conversations/${state.currentConv.id}/participants`, {
        method: "PATCH",
        body: JSON.stringify(body)
      });
      const data = res?.data || res || {};
      if (state.currentConv) {
        state.currentConv.characterIds = data.characterIds;
        state.currentConv.characterId = data.characterId;
        state.currentConv.characterName = data.characterName;
      }
      toast("同场角色已更新", "success");
      // 名单变了，发言者那一行与气泡署名都得跟着变——
      // 交给“打开对话”那条路重画，不自己再拼一遍。
      // （动态 import：静态 import 会让 characters ↔ chat 形成环。）
      const { openConversation } = await import("./chat.js");
      await openConversation(state.currentConv.id);
    } catch (e) {
      toast("改名单失败: " + friendlyError(e), "error");
    }
  });

  // 前情提要的动作：保存 / 清掉。
  // 清掉是**安全操作**：折叠每轮按预算重算，原文一条不少。
  box.querySelector("#ctx-summary-save")?.addEventListener("click", async () => {
    const ta = box.querySelector("#ctx-summary-text");
    if (!ta) return;
    try {
      const res = await apiFetch(`conversations/${state.currentConv.id}/summary`, {
        method: "PUT",
        body: JSON.stringify({ text: ta.value })
      });
      const data = res?.data || res || {};
      // 就地更新内存里那一份再重渲染——不为了一句文字再拉一次整场对话。
      if (state.currentConv) state.currentConv.summary = data.summary ?? null;
      toast("前情提要已保存", "success");
      await renderCharContext(gi);
    } catch (e) {
      toast("保存失败: " + friendlyError(e), "error");
    }
  });

  /*
   * 让模型重写：**一次明确的调用**。
   *
   * 为什么不是自动：折叠可能每轮都发生，自动化的那笔账
   * 就成了"用户不知道花了钱"。点它才花——所以用量要说出来。
   */
  box.querySelector("#ctx-summary-llm")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "模型在想…";
    try {
      const res = await apiFetch(`conversations/${state.currentConv.id}/summary/summarize`, {
        method: "POST",
        body: JSON.stringify({})
      });
      const data = res?.data || res || {};
      if (data.ok === false) {
        // 没得可压不是错误，是一句实话
        toast(data.reason || "现在还没有历史可压", "info");
        btn.disabled = false;
        btn.textContent = sum?.text ? "让模型重写" : "让模型写一份";
        return;
      }
      if (state.currentConv) state.currentConv.summary = data.summary ?? null;
      const u = data.usage?.total_tokens ?? data.usage?.completion_tokens ?? null;
      toast(`前情提要已重写（压了 ${data.folded ?? "?"} 条）${u ? ` · 用了 ${u} token` : ""}`, "success");
      await renderCharContext(gi);
    } catch (err) {
      toast("重写失败: " + friendlyError(err), "error");
      btn.disabled = false;
      btn.textContent = sum?.text ? "让模型重写" : "让模型写一份";
    }
  });

  box.querySelector("#ctx-summary-clear")?.addEventListener("click", async () => {
    const yes = await confirmDialog({
      title: "清掉前情提要？",
      body: "消息一条都不会少——只是让下一轮按预算重新压一遍。"
    });
    if (!yes) return;
    try {
      await apiFetch(`conversations/${state.currentConv.id}/summary`, {
        method: "PUT",
        body: JSON.stringify({ text: null })
      });
      if (state.currentConv) state.currentConv.summary = null;
      toast("已清掉", "success");
      await renderCharContext(gi);
    } catch (e) {
      toast("清掉失败: " + friendlyError(e), "error");
    }
  });

  // 动作：复用角色域已有分派（编辑/导出/删除三个真动作，不摆没实现的按钮）
  box.querySelectorAll("[data-ctx]").forEach(btn => {
    btn.addEventListener("click", () => {
      handleCharacterAction(btn.dataset.ctx, c.id);
    });
  });

  // 开场白轮换：只换预览，不动数据（真生效在建对话时随机取）
  box.querySelector("#greet-prev")?.addEventListener("click", () => renderCharContext(gi - 1));
  box.querySelector("#greet-next")?.addEventListener("click", () => renderCharContext(gi + 1));

  // 生成立绘：按钮是每次重画重建的，所以绑定也要每次重来一趟
  const { bindPortraitButton } = await import("./media.js");
  bindPortraitButton();
}
