// tts.js — 语音朗读：设置面板 + 播放
//
// 两件事，一个模块：
//   · 设置面板：填 key / region / baseUrl，选声音。它的**唯一任务**是让人填完就知道通没通。
//     所以面板顶部那行体检条比下面的输入框重要——填完保存，那行字就是体检报告。
//   · 播放：消息旁边那个小喇叭。一次只播一条（再点就停），
//     共用一个 <audio> 而不是每条消息挂一个，免得页面上躺着十几个播放器。
//
// 关于"试听"：它会**先保存再出声**。
// 理由是别让人猜"我刚才填的到底生效了没有"——试听用的就是已经存下来的那份配置。
//
// 2026-09-28 改造：
//   · 状态条提到最上（.modal-health）
//   · Azure 与 OpenAI 不再同时铺开——单选卡 + 选中才展开
//   · 声音表分两段：上段是这场对话里的角色（自动列），下段是按名字匹配（手动加）
//     ——两段联动完全不同，合成一张表就看不见这个差别
//   · 匹配预览：让用户看见自己加的名字到底能不能命中
//   · 底部按钮改成 取消 / 保存 右对齐

import { apiFetch, toast, escapeHtml, friendlyError, apiUrl } from "./core.js";
import { state } from "./state.js";
import { planNarration, progressText } from "./narration-plan.js";

let providersLoaded = false;
let providers = [];
let current = null;      // 面板里正在编辑的配置（含 hasKey 这类只读信息）
let audio = null;        // 共用的播放器
let playingKey = null;   // 正在读的是哪一条（消息 id / "preview"）
let onStop = null;       // 播完后要回调的那个按钮

const $ = (id) => document.getElementById(id);

/**
 * 拆信封，并把"服务端拒绝了"当成真的错误抛出来。
 *
 * 为什么要专门写一个：这个 App 的 `apiFetch` 在 4xx 时**不抛**——
 * 它把 `{ok:false, error}` 整个返回。于是不懂这个约定的写法会把错误信封
 * 当数据用（`r.url` 是 undefined），而真正报出来的错是下游那句
 * "Invalid plugin API path."——服务端说了什么、缺什么，全被吞了。
 * 探针里就摸到过这一幕。
 */
function readEnvelope(res, what) {
  const env = res && typeof res === "object" ? res : {};
  if (env.ok === false) throw new Error(env.error || `${what}被拒绝了`);
  return env.data !== undefined ? env.data : env;
}

/**
 * 去掉不该读出来的符号。
 *
 * 消息正文里带着 markdown（**强调**、`代码`、# 标题、> 引用）。
 * 让机器把星号念出来是那种"技术上没错、听上去很蠢"的体验。
 */
export function stripForSpeech(text) {
  return String(text ?? "")
    .replace(/```[\s\S]*?```/g, "（代码块）")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// ── 播放 ────────────────────────────────────────────────

/**
 * 共用一只播放器。
 *
 * 监听器**每次播都重新挂、播完就摘**——不挂常驻监听。
 * 常驻监听看着省事，但"上一条的 ended"与"这一条的 ended"会撞在一起，
 * 而连播恰恰就是把一条接一条播下去，撞上是早晚的事。
 */
function player() {
  if (!audio) audio = new Audio();
  return audio;
}

/** 播一个地址，等它播完（或被打断）。 */
function playUrl(url, key, onState) {
  const p = player();
  try { p.pause(); } catch { /* 之前没在放 */ }

  playingKey = key;
  onStop = onState || null;

  return new Promise((resolve) => {
    const settle = (how) => {
      p.removeEventListener("ended", onEnded);
      p.removeEventListener("error", onError);
      if (playingKey === key) playingKey = null;
      const cb = onStop; onStop = null;
      if (cb && how !== "next") cb(how);
      resolve(how);
    };
    const onEnded = () => settle("done");
    const onError = () => settle("error");
    p.addEventListener("ended", onEnded);
    p.addEventListener("error", onError);

    p.src = url;
    p.play().catch(() => settle("error"));
  });
}

/** 要一段音频（不播）。opts 支持 characterId 与 speaker——后者对应五级匹配的后三级。 */
async function fetchSpeech(text, opts = {}) {
  const body = { text };
  if (opts.characterId) body.characterId = String(opts.characterId);
  if (opts.speaker) body.speaker = String(opts.speaker);
  const res = await apiFetch("tts/speak", {
    method: "POST",
    body: JSON.stringify(body)
  });
  const r = readEnvelope(res, "朗读");
  if (!r || !r.url) throw new Error("服务端没给出音频地址");
  return r;
}

export function stopSpeak() {
  if (audio) {
    try { audio.pause(); } catch { /* 没在放就算了 */ }
    // 把当前这条 settle 掉：连播循环在等它，不断开就会卡在那儿。
    try { audio.dispatchEvent(new Event("ended")); } catch { /* 算了 */ }
  }
  playingKey = null;
  if (onStop) { const cb = onStop; onStop = null; cb("stop"); }
}

export function isSpeaking(key) {
  return playingKey !== null && playingKey === key;
}

/**
 * 读一段文字，或者停掉正在读的那段。
 *
 * @param {string} text
 * @param {{key?: string, characterId?: string, speaker?: string, onState?: (s: string) => void}} [opts]
 *   characterId：谁在说。传了就按角色分配的声音读（群聊一人一嗓）。
 *   speaker：发言者名字。传了就按名字关键词匹配（世界书里的人、旁白）。
 */
export async function speakText(text, opts = {}) {
  const key = opts.key || "text";
  if (playingKey === key) { stopSpeak(); return { stopped: true }; }

  const say = stripForSpeech(text);
  if (!say) { toast("这条消息里没有可读的文字（宏展开后是空的）", "error"); return { ok: false }; }

  let r;
  try {
    r = await fetchSpeech(say, { characterId: opts.characterId, speaker: opts.speaker });
  } catch (e) {
    // 没配好是这里最常见的一种失败，而"去设置"藏在 ⋯ 菜单里——
    // 所以这句话得自己把路指出来。
    const why = friendlyError(e);
    toast(`朗读不了：${why}（⋯ 菜单里有「语音朗读」）`, "error");
    return { ok: false, error: why };
  }

  const how = await playUrl(apiUrl(r.url), key, opts.onState);
  if (r.truncated) toast(r.note || "文本太长，只读了一部分", "error");
  return { ok: how !== "error", ...r, how };
}

// ── 连播整场 ──────────────────────────────────────────

/** 正在连播的那个队列（null = 没在连播）。 */
let queue = null;

export function isPlayingAll() {
  return !!queue;
}

/**
 * 从这一条开始连播下去。
 *
 * 逐条现要（不预取）：一条台词几十秒，预取会把好几条塞进队列里等着，
 * 而用户想停的时候，真正浪费的是那几条已经付过钱的。
 *
 * @param {{items: Array<{id, speakerId, text}>, onProgress?: (done: number, total: number) => void,
 *          onFinish?: (reason: string) => void}} args
 */
export async function playQueue({ items, onProgress, onFinish } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) { toast("这场里没有角色的台词可读（空对话、或只有你自己的话）", "error"); return { ok: false }; }
  if (queue) stopPlayback();

  queue = { stop: false };
  const mine = queue;

  try {
    for (let i = 0; i < list.length; i++) {
      if (mine.stop) break;
      if (onProgress) onProgress(i, list.length);

      const it = list[i];
      let r;
      try {
        r = await fetchSpeech(stripForSpeech(it.text), { characterId: it.speakerId });
      } catch (e) {
        const why = friendlyError(e);
        // 第一条就失败：别再往下试了。
        // "没配好/没网络"这类错不会因为再试三条就变好——只会往屏幕上堆三句一样的话。
        if (i === 0) { toast(`连播不了：${why}`, "error"); break; }
        // 中间某条失败不拖垮整场：从哪条断的要说清楚，然后接着读完。
        toast(`第 ${i + 1} 条读不出来：${why}`, "error");
        continue;
      }
      if (mine.stop) break;
      const how = await playUrl(apiUrl(r.url), `all:${it.id}`, null);
      if (mine.stop || how === "stop") break;
    }
  } finally {
    const stopped = mine.stop;
    if (queue === mine) queue = null;
    if (onFinish) onFinish(stopped ? "stopped" : "done");
  }

  return { ok: true };
}

/** 停连播（并让当前那条闭嘴）。 */
export function stopPlayback() {
  if (queue) queue.stop = true;
  stopSpeak();
}

/**
 * 连播这场：再点一下是停。
 *
 * 读的是**角色的台词**（自己的话不念——那是你说过的，不是别人说给你听的），
 * 宏先还原再剪符号。具体读什么由 narration-plan.js 决定，那边有单测。
 */
export async function playConversation() {
  const conv = state.currentConv;
  if (!conv) { toast("先开一场对话", "error"); return { ok: false }; }
  if (isPlayingAll()) { stopPlayback(); return { stopped: true }; }

  const macro = state.macro || null;
  const items = planNarration(conv.messages, {
    characterId: conv.characterId,
    process: (s) => (macro ? macro.process(s) : s)
  });
  if (items.length === 0) { toast("这场没有可读的台词", "error"); return { ok: false }; }

  const bar = $("tts-bar");
  const txt = $("tts-bar-text");
  bar?.classList.remove("hidden");
  if (txt) txt.textContent = progressText(0, items.length, conv.title || "");

  try {
    await playQueue({
      items,
      onProgress: (i, total) => { if (txt) txt.textContent = progressText(i, total, conv.title || ""); },
      onFinish: (reason) => {
        bar?.classList.add("hidden");
        if (reason === "done") toast(`这一场读完了（${items.length} 条）`, "success");
      }
    });
  } catch (e) {
    bar?.classList.add("hidden");
    toast("连播出错：" + friendlyError(e) + "（可以再点一次「连播这场」重试）", "error");
  }
  return { ok: true };
}

// ── 设置面板 ────────────────────────────────────────────

async function ensureProviders() {
  if (providersLoaded) return providers;
  const d = readEnvelope(await apiFetch("tts/providers"), "读提供方清单");
  providers = Array.isArray(d?.providers) ? d.providers : [];
  providersLoaded = true;
  return providers;
}

/**
 * 体检条：● + 一句人话 + 一句细节 + 一个直接动作。
 *
 * 语音面板的体检条有「试听」动作——不像场景插图那个没动作。
 * 试听会先保存再出声，所以它是**唯一的**让用户填完立刻知道通没通的路径。
 *
 * 三态：
 *   is-ok    —— 已配好，试听按钮可点
 *   is-bad   —— 缺凭据或供应商不可用
 *   （默认灰） —— 还没配过
 */
function setHealth(opts) {
  const el = $("tts-health");
  if (!el) return;
  const { state: st = "", title = "", sub = "", hasAction = false, disabled = false } = opts || {};
  el.classList.remove("is-ok", "is-bad");
  if (st === "ok") el.classList.add("is-ok");
  if (st === "bad") el.classList.add("is-bad");
  el.querySelector(".mh-title")?.replaceChildren(title);
  el.querySelector(".mh-sub")?.replaceChildren(sub);
  const act = el.querySelector(".mh-act");
  if (act) {
    act.classList.toggle("hidden", !hasAction);
    const btn = act.querySelector("button");
    if (btn) btn.disabled = disabled;
  }
}

function fillForm(cfg) {
  current = cfg;
  const p = cfg.provider;
  document.querySelectorAll("#tts-providers .tts-prov").forEach((el) => {
    el.classList.toggle("on", el.dataset.id === p);
  });

  const azBox = $("tts-azure-box");
  const oaBox = $("tts-openai-box");
  if (azBox) azBox.classList.toggle("hidden", p !== "azure");
  if (oaBox) oaBox.classList.toggle("hidden", p !== "openai");

  const meta = providers.find((x) => x.id === p);
  const hint = $("tts-hint");
  if (hint) hint.textContent = meta?.hint || "";

  const az = cfg.azure || {};
  const region = $("tts-azure-region");
  if (region) region.value = az.region || "";
  const azKey = $("tts-azure-key");
  if (azKey) {
    azKey.value = "";
    azKey.placeholder = az.hasKey ? "已存（留空 = 不改动）" : "粘贴 key";
  }
  const azClear = $("tts-azure-clear");
  if (azClear) {
    azClear.checked = false;
    const lab = azClear.closest("label");
    if (lab) lab.classList.toggle("hidden", !az.hasKey);
  }

  const oa = cfg.openai || {};
  const base = $("tts-openai-base");
  if (base) base.value = oa.baseUrl || "";
  const model = $("tts-openai-model");
  if (model) model.value = oa.model || "";
  const oaKey = $("tts-openai-key");
  if (oaKey) {
    oaKey.value = "";
    oaKey.placeholder = oa.hasKey ? "已存（留空 = 不改动）" : "留空即可（本机服务多半不要）";
  }
  const oaClear = $("tts-openai-clear");
  if (oaClear) {
    oaClear.checked = false;
    const lab = oaClear.closest("label");
    if (lab) lab.classList.toggle("hidden", !oa.hasKey);
  }

  // 声音下拉：把当前值也放进去（否则换 provider 后已存的声音会"看不见"）
  const sel = $("tts-voice");
  if (sel) {
    const list = [...(meta?.voices || [])];
    if (cfg.voice && !list.includes(cfg.voice)) list.unshift(cfg.voice);
    sel.innerHTML = list.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
    sel.value = cfg.voice || meta?.defaultVoice || list[0] || "";
  }
  const rate = $("tts-rate");
  if (rate) rate.value = cfg.rate || "";

  renderVoiceMap();
  refreshHealth();
  refreshMatchPreview();
}

/**
 * 这场对话里的角色（群聊就是名单里的人；单人就是主角）。
 * 用 state.charList 而不是自己 fetch——chat 已经加载了角色库，
 * 别自己再要一份，两边不一致时会出「角色卡存在但 voice 没对上」这种幽灵 bug。
 */
function conversationChars() {
  const conv = state.currentConv;
  if (!conv) return [];
  const all = Array.isArray(state.charList) ? state.charList : [];
  let ids = Array.isArray(conv.characterIds) && conv.characterIds.length
    ? conv.characterIds
    : (conv.characterId ? [conv.characterId] : []);
  return ids.map((id) => {
    const c = all.find((x) => String(x.id) === String(id));
    return c || { id: String(id), name: `#${id}` };
  });
}

/**
 * 把 voices map 拆成两段：
 *   auto   —— 这场对话里角色对应的键（按 characterId 精确取）
 *   manual —— 其他键（用户手动加的，键是名字）
 *
 * 两段联动完全不同：auto 随对话变，manual 一直在。
 */
function splitVoices() {
  const voices = current?.voices || {};
  const chars = conversationChars();
  const charIds = new Set(chars.map((c) => String(c.id)));
  const auto = chars.map((ch) => ({
    key: String(ch.id),
    name: ch.name || ch.id,
    isCharacter: true,
    voice: voices[ch.id] || ""
  }));
  const manual = [];
  for (const [k, v] of Object.entries(voices)) {
    if (!charIds.has(String(k))) manual.push({ key: String(k), name: String(k), voice: v });
  }
  return { auto, manual };
}

/**
 * 渲染声音表：两段（auto + manual）。
 *
 * auto 段每行：[角色名] [voice select] [试听]
 * manual 段每行：[⠿ handle] [name input] [voice select] [试听] [✕]
 *
 * 手动段还有底部「＋ 加一条」按钮 + 匹配预览。
 */
function renderVoiceMap() {
  const { auto, manual } = splitVoices();
  const meta = providers.find((x) => x.id === current?.provider);
  const voicesList = meta?.voices || [];
  const providerVoices = voicesList.length > 0
    ? voicesList
    : Object.values(current?.voices || {}).filter((v) => v);

  const autoBox = $("tts-voices-auto-list");
  if (autoBox) {
    if (auto.length === 0) {
      autoBox.innerHTML = `<div class="hint" style="padding: 6px 2px;">这场对话里还没有角色——先开一场对话。</div>`;
    } else {
      autoBox.innerHTML = auto.map((row) => {
        const selOpts = [
          `<option value="">（用默认）</option>`,
          ...providerVoices.map((v) => `<option value="${escapeHtml(v)}"${v === row.voice ? " selected" : ""}>${escapeHtml(v)}</option>`)
        ].join("");
        return `
          <div class="vm-row" data-key="${escapeHtml(row.key)}" data-kind="auto">
            <span class="vm-name"><b>${escapeHtml(row.name)}</b></span>
            <select class="vm-select" data-action="voice">${selOpts}</select>
            <button type="button" class="vm-preview" data-action="preview" title="试听">试听</button>
          </div>`;
      }).join("");
    }
    const note = $("tts-voices-auto-note");
    if (note) note.textContent = auto.length ? `自动列出来，不用手填（${auto.length} 个）` : "自动列出来，不用手填";
  }

  const manualBox = $("tts-voices-manual-list");
  if (manualBox) {
    if (manual.length === 0) {
      manualBox.innerHTML = `<div class="hint" style="padding: 6px 2px;">还没有手动加的——「＋ 加一条」在下面。</div>`;
    } else {
      manualBox.innerHTML = manual.map((row) => {
        const selOpts = [
          `<option value="">（用默认）</option>`,
          ...providerVoices.map((v) => `<option value="${escapeHtml(v)}"${v === row.voice ? " selected" : ""}>${escapeHtml(v)}</option>`)
        ].join("");
        return `
          <div class="vm-row" data-key="${escapeHtml(row.key)}" data-kind="manual">
            <span class="vm-handle" title="拖动排序">⠿</span>
            <input type="text" class="vm-name-input" data-action="name" value="${escapeHtml(row.name)}" placeholder="名字或关键词" style="flex: 1; min-width: 0; padding: 6px 10px; background: transparent; border: 1px solid var(--border); border-radius: 6px; font-size: 12px; color: var(--fg);">
            <select class="vm-select" data-action="voice">${selOpts}</select>
            <button type="button" class="vm-preview" data-action="preview" title="试听">试听</button>
            <button type="button" class="vm-del" data-action="del" title="删除">✕</button>
          </div>`;
      }).join("");
    }
    const note = $("tts-voices-manual-note");
    if (note) note.textContent = manual.length ? `你自己加的（${manual.length} 条）` : "你自己加的——旁白、世界书里的人、别的卡";
  }

  bindVoiceMapEvents();
}

/**
 * 给声音表挂事件。用事件委托——每次重渲染后不用重新绑。
 */
function bindVoiceMapEvents() {
  const root = $("tts-voices-auto-list");
  const manual = $("tts-voices-manual-list");
  for (const el of [root, manual]) {
    if (!el || el.dataset.bound === "1") continue;
    el.dataset.bound = "1";
    el.addEventListener("click", onVoiceMapClick);
    el.addEventListener("change", onVoiceMapChange);
    el.addEventListener("input", onVoiceMapInput);
  }
}

function onVoiceMapClick(e) {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const row = btn.closest(".vm-row");
  if (!row) return;
  const action = btn.dataset.action;
  const kind = row.dataset.kind;
  const key = row.dataset.key;

  if (action === "del" && kind === "manual") {
    delete current.voices[key];
    saveCurrentVoices().then(() => renderVoiceMap());
  } else if (action === "preview") {
    // 试听听这一行的声音
    const sample = $("tts-sample")?.value || "夜色落在城墙上，我在这里守夜。";
    if (kind === "auto") {
      speakText(sample, { characterId: key, key: `row:${key}` });
    } else {
      speakText(sample, { speaker: key, key: `row:${key}` });
    }
  }
}

function onVoiceMapChange(e) {
  const sel = e.target.closest('select[data-action="voice"]');
  if (!sel) return;
  const row = sel.closest(".vm-row");
  if (!row) return;
  const key = row.dataset.key;
  const v = sel.value;
  if (v) current.voices[key] = v;
  else delete current.voices[key];
  saveCurrentVoices().then(() => refreshHealth());
}

function onVoiceMapInput(e) {
  const input = e.target.closest('input[data-action="name"]');
  if (!input) return;
  // 只在失焦时保存（input 事件触发太频繁）
  // 用 debounce 或直接 blur——这里用 blur 更可靠
}

/** 名字 input 的 blur：把新名字写进 voices map（如果非空） */
function bindNameBlur() {
  document.querySelectorAll('input[data-action="name"]').forEach((input) => {
    if (input.dataset.bound === "1") return;
    input.dataset.bound = "1";
    input.addEventListener("blur", onNameBlur);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    });
  });
}

function onNameBlur(e) {
  const input = e.target;
  const row = input.closest(".vm-row");
  if (!row || row.dataset.kind !== "manual") return;
  const oldKey = row.dataset.key;
  const newKey = (input.value || "").trim();
  if (newKey === oldKey) return;

  const oldVoice = current.voices[oldKey] || "";
  delete current.voices[oldKey];
  if (newKey) current.voices[newKey] = oldVoice;

  saveCurrentVoices().then(() => renderVoiceMap());
}

/**
 * 「＋ 加一条」：新行直接出现在列表里，光标落进名字输入框。
 *
 * 不要弹 prompt——prompt 是 20 年前的交互，跟这个面板的其他部分不搭。
 * 而且 prompt 里没地方放 voice select，用户得先关 prompt 再选声音，绕。
 */
function addManualEntry() {
  if (!current.voices) current.voices = {};
  // 用一个带时间戳的临时 key，用户填名字之后再改过来
  const tempKey = `__new_${Date.now()}`;
  current.voices[tempKey] = "";
  renderVoiceMap();
  // 把光标落到新行的名字输入框
  const rows = document.querySelectorAll('input[data-action="name"]');
  const newRow = [...rows].find((r) => r.closest(".vm-row")?.dataset.key === tempKey);
  if (newRow) {
    newRow.focus();
    newRow.select();
  }
  bindNameBlur();
}

/** 保存当前 voices 到后端。返回新的 cfg。 */
async function saveCurrentVoices() {
  const res = await apiFetch("tts/config", {
    method: "PUT",
    body: JSON.stringify({ voices: current.voices })
  });
  const fresh = readEnvelope(res, "保存声音分配");
  current = fresh;
  return fresh;
}

/**
 * 匹配预览：把 voices map 里所有 key 在文本里找出来，高亮并标声音。
 *
 * 为什么这个 UI 是**最该做的东西**：
 *   关键词匹配的正确性没法靠脑子推——你得看见它到底抓到了谁。
 *   「我明明加了老城主怎么没生效」会变成最常见的困惑。
 *   预览就是解药。
 */
function refreshMatchPreview() {
  const ta = $("tts-match-text");
  const box = $("tts-match-preview");
  if (!ta || !box) return;
  const text = ta.value || "";
  box.innerHTML = "";
  if (!text.trim()) {
    box.innerHTML = `<div class="vm-md-hint" style="opacity: .6; margin: 0;">输入一段台词看看能匹配到谁</div>`;
    return;
  }

  // 在文本里找所有 voices key 的命中位置
  const voices = current?.voices || {};
  const keys = Object.keys(voices).filter((k) => k && !k.startsWith("__"));  // 排除临时 key
  // 先长后短：长的先匹配
  keys.sort((a, b) => b.length - a.length);

  // 收集所有匹配区间
  const matches = [];
  for (const k of keys) {
    let from = 0;
    while (true) {
      const idx = text.indexOf(k, from);
      if (idx < 0) break;
      matches.push({ key: k, start: idx, end: idx + k.length });
      from = idx + 1;
    }
  }
  if (matches.length === 0) {
    box.innerHTML = `<div class="vm-md-fall">这段话里没有出现任何已配置的名字</div>`;
    return;
  }
  // 按起点排序
  matches.sort((a, b) => a.start - b.start);

  // 渲染：把文本切分，命中处高亮
  let html = "";
  let cursor = 0;
  const voiceOf = (k) => voices[k] || "（用默认）";
  for (const m of matches) {
    if (m.start < cursor) continue;   // 重叠的跳过
    html += escapeHtml(text.slice(cursor, m.start));
    const voice = voiceOf(m.key);
    html += `<mark title="${escapeHtml(m.key)} → ${escapeHtml(voice)}">${escapeHtml(text.slice(m.start, m.end))}</mark>`;
    html += `<span class="vm-md-fall"> → ${escapeHtml(voice)}</span>`;
    cursor = m.end;
  }
  html += escapeHtml(text.slice(cursor));
  box.innerHTML = `<div>${html}</div>`;

  // 统计
  const uniqKeys = [...new Set(matches.map((m) => m.key))];
  const fall = matches.length;
  if (uniqKeys.length > 0) {
    box.innerHTML += `<div class="vm-md-fall" style="margin-top: 4px; font-size: 10.5px; opacity: .75;">命中 ${uniqKeys.length} 个名字，共 ${fall} 处</div>`;
  }
}

/** 刷新体检条 */
function refreshHealth() {
  const cfg = current;
  if (!cfg) return;
  const meta = providers.find((x) => x.id === cfg.provider);
  const label = meta?.label || cfg.provider;

  if (!cfg.ready) {
    setHealth({ state: "bad", title: "还没配好", sub: `${label} · ${cfg.reason || "缺凭据"}`, hasAction: true, disabled: true });
    return;
  }

  // 已配好
  const voiceLabel = cfg.voice || (meta?.defaultVoice || "默认声音");
  const rate = cfg.rate ? ` · 语速 ${cfg.rate}` : "";
  const voicesCount = Object.keys(cfg.voices || {}).filter((k) => !k.startsWith("__")).length;
  const voicesNote = voicesCount ? ` · 已分配 ${voicesCount} 个` : "";
  setHealth({
    state: "ok",
    title: "通了",
    sub: `${label} · 默认声音 ${voiceLabel}${rate}${voicesNote}`,
    hasAction: true,
    disabled: false
  });
}

function collectPatch() {
  const patch = {
    provider: current?.provider,
    voice: $("tts-voice")?.value || "",
    rate: $("tts-rate")?.value || ""
  };
  patch.azure = { region: $("tts-azure-region")?.value || "" };
  patch.openai = {
    baseUrl: $("tts-openai-base")?.value || "",
    model: $("tts-openai-model")?.value || ""
  };
  // 空输入框 = "不改动已存的"；要清空得显式勾那个框。
  // 这两件事不能共用一种写法——否则每次保存都会把已存的 key 抹掉。
  const azKey = $("tts-azure-key")?.value || "";
  if (azKey) patch.azure.key = azKey;
  if ($("tts-azure-clear")?.checked) patch.azure.key = "";
  const oaKey = $("tts-openai-key")?.value || "";
  if (oaKey) patch.openai.key = oaKey;
  if ($("tts-openai-clear")?.checked) patch.openai.key = "";
  return patch;
}

/** 保存并回填（回填很重要：hasKey 变了，界面得跟着变）。 */
export async function save() {
  const res = await apiFetch("tts/config", {
    method: "PUT",
    body: JSON.stringify(collectPatch())
  });
  const cfg = readEnvelope(res, "保存语音设置");
  fillForm(cfg);
  toast(cfg.ready ? "语音设置已保存" : "已保存——" + (cfg.reason || ""), cfg.ready ? "success" : "error");
  return cfg;
}

export async function openTts() {
  const modal = $("tts-modal");
  if (!modal) return;
  modal.classList.remove("hidden");
  try {
    await ensureProviders();
    const box = $("tts-providers");
    if (box) {
      box.innerHTML = providers.map((p) => `
        <button type="button" class="tts-prov${p.id === current?.provider ? " on" : ""}" data-id="${escapeHtml(p.id)}">
          <span class="tts-prov-name">${escapeHtml(p.label)}</span>
          <span class="tts-prov-sub">${escapeHtml(p.id === "azure" ? "要 key 与 region" : "填 baseUrl 即可")}</span>
        </button>`).join("");
      box.querySelectorAll(".tts-prov").forEach((el) => {
        el.addEventListener("click", () => {
          current = { ...(current || {}), provider: el.dataset.id };
          // 换 provider 时把还没保存的输入让位给新 provider 的已存值
          fillForm({ ...current, voice: "", rate: current.rate || "" });
        });
      });
    }
    const res = await apiFetch("tts/config");
    fillForm(readEnvelope(res, "读语音配置"));
  } catch (e) {
    setHealth({ state: "bad", title: "读不到配置", sub: friendlyError(e), hasAction: true, disabled: true });
  }
}

export function closeTts() {
  $("tts-modal")?.classList.add("hidden");
}

/** 幂等绑定：面板里的按钮 + 遮罩点击关闭。 */
export function bindTts() {
  const modal = $("tts-modal");
  if (!modal || modal.dataset.bound === "1") return;
  modal.dataset.bound = "1";

  $("tts-close")?.addEventListener("click", closeTts);
  $("tts-cancel")?.addEventListener("click", closeTts);
  $("tts-bar-stop")?.addEventListener("click", stopPlayback);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeTts(); });

  $("tts-save")?.addEventListener("click", async () => {
    try { await save(); }
    catch (e) { toast("保存失败：" + friendlyError(e), "error"); }
  });

  // 试听：先保存再出声——否则"我刚才填的生效了吗"要靠猜。
  const doPreview = async () => {
    const btn = $("tts-preview");
    const btnTop = $("tts-preview-top");
    const sample = $("tts-sample")?.value || "夜色落在城墙上，我在这里守夜。";
    [btn, btnTop].forEach((b) => { if (b) b.disabled = true; });
    try {
      await save();
      if (!current?.ready) return;
      const r = await speakText(sample, { key: "preview" });
      if (r?.ok) toast("试听中…", "success");
    } catch (e) {
      toast("试听失败：" + friendlyError(e), "error");
    } finally {
      [btn, btnTop].forEach((b) => { if (b) b.disabled = false; });
    }
  };
  $("tts-preview")?.addEventListener("click", doPreview);
  $("tts-preview-top")?.addEventListener("click", doPreview);

  // 加一条
  $("tts-voice-add")?.addEventListener("click", addManualEntry);

  // 匹配预览：实时刷新
  $("tts-match-text")?.addEventListener("input", refreshMatchPreview);
}
