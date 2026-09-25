// tts.js — 语音朗读：设置面板 + 播放
//
// 两件事，一个模块：
//   · 设置面板：填 key / region / baseUrl，选声音。它的**唯一任务**是让人填完就知道通没通。
//     所以面板底部那行状态比上面的输入框重要——填完保存，那行字就是体检报告。
//   · 播放：消息旁边那个小喇叭。一次只播一条（再点就停），
//     共用一个 <audio> 而不是每条消息挂一个，免得页面上躺着十几个播放器。
//
// 关于"试听"：它会**先保存再出声**。
// 理由是别让人猜"我刚才填的到底生效了没有"——试听用的就是已经存下来的那份配置。

import { apiFetch, toast, escapeHtml, friendlyError, apiUrl } from "./core.js";
import { state } from "./state.js";

let providersLoaded = false;
let providers = [];
let current = null;      // 面板里正在编辑的配置（含 hasKey 这类只读信息）
let audio = null;        // 共用的播放器
let playingKey = null;   // 正在读的是哪一条（消息 id / "preview"）
let onStop = null;       // 播完后要回调的那个按钮

const $ = (id) => document.getElementById(id);

/**
 * 拆信封，并把“服务端拒绝了”当成真的错误抛出来。
 *
 * 为什么要专门写一个：这个 App 的 `apiFetch` 在 4xx 时**不抛**——
 * 它把 `{ok:false, error}` 整个返回。于是不懂这个约定的写法会把错误信封
 * 当数据用（`r.url` 是 undefined），而真正报出来的错是下游那句
 * “Invalid plugin API path.”——服务端说了什么、缺什么，全被吞了。
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

function player() {
  if (!audio) {
    audio = new Audio();
    audio.addEventListener("ended", () => {
      playingKey = null;
      if (onStop) { onStop("done"); onStop = null; }
    });
    audio.addEventListener("error", () => {
      playingKey = null;
      if (onStop) { onStop("error"); onStop = null; }
    });
  }
  return audio;
}

export function stopSpeak() {
  if (audio) {
    try { audio.pause(); } catch { /* 没在放就算了 */ }
  }
  playingKey = null;
  if (onStop) { onStop("stop"); onStop = null; }
}

export function isSpeaking(key) {
  return playingKey !== null && playingKey === key;
}

/**
 * 读一段文字，或者停掉正在读的那段。
 *
 * @param {string} text
 * @param {{key?: string, characterId?: string, onState?: (s: string) => void, autoSave?: boolean}} [opts]
 *   characterId：谁在说。传了就按角色分配的声音读（群聊一人一嗓）。
 */
export async function speakText(text, opts = {}) {
  const key = opts.key || "text";
  if (playingKey === key) { stopSpeak(); return { stopped: true }; }

  const say = stripForSpeech(text);
  if (!say) { toast("这条没什么可读的", "error"); return { ok: false }; }

  stopSpeak();                       // 先让上一条闭嘴
  const p = player();
  onStop = opts.onState || null;

  let r;
  try {
    const res = await apiFetch("tts/speak", {
      method: "POST",
      body: JSON.stringify({
        text: say,
        ...(opts.characterId ? { characterId: String(opts.characterId) } : {})
      })
    });
    r = readEnvelope(res, "朗读");
    if (!r || !r.url) throw new Error("服务端没给出音频地址");
  } catch (e) {
    onStop = null;
    // 没配好是这里最常见的一种失败，而"去设置"藏在 ⋯ 菜单里——
    // 所以这句话得自己把路指出来。
    const why = friendlyError(e);
    toast(`朗读不了：${why}（⋯ 菜单里有「语音朗读」）`, "error");
    return { ok: false, error: why };
  }

  try {
    p.src = apiUrl(r.url);
    playingKey = key;
    await p.play();
  } catch (e) {
    playingKey = null;
    onStop = null;
    toast("拿到了音频，但浏览器不让放：" + friendlyError(e), "error");
    return { ok: false, error: String(e) };
  }

  if (r.truncated) toast(r.note || "文本太长，只读了一部分", "error");
  return { ok: true, ...r };
}

// ── 设置面板 ────────────────────────────────────────────

async function ensureProviders() {
  if (providersLoaded) return providers;
  const d = readEnvelope(await apiFetch("tts/providers"), "读提供方清单");
  providers = Array.isArray(d?.providers) ? d.providers : [];
  providersLoaded = true;
  return providers;
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
  if (azKey) { azKey.value = ""; azKey.placeholder = az.hasKey ? "已存（留空 = 不改动）" : "粘贴 key"; }
  const azClear = $("tts-azure-clear");
  if (azClear) { azClear.checked = false; azClear.closest("label")?.classList.toggle("hidden", !az.hasKey); }

  const oa = cfg.openai || {};
  const base = $("tts-openai-base");
  if (base) base.value = oa.baseUrl || "";
  const model = $("tts-openai-model");
  if (model) model.value = oa.model || "";
  const oaKey = $("tts-openai-key");
  if (oaKey) { oaKey.value = ""; oaKey.placeholder = oa.hasKey ? "已存（留空 = 不改动）" : "留空即可（本机服务多半不要）"; }
  const oaClear = $("tts-openai-clear");
  if (oaClear) { oaClear.checked = false; oaClear.closest("label")?.classList.toggle("hidden", !oa.hasKey); }

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

  renderVoiceMap(cfg);
  renderStatus(cfg);
}

/** 这场对话里的角色（群聊就是名单里的人；单人就是主角）。 */
function convCharacters() {
  const conv = state.currentConv;
  // 名字从 state.charList 取（跟 chat.js 的 charNameOf 同一个源）——
  // 别处没有第二份名单，自创一个就会得到“角色已不在库”这种假话（探针里就摸到过）。
  const all = Array.isArray(state.charList) ? state.charList : [];
  const ids = Array.isArray(conv?.characterIds) && conv.characterIds.length
    ? conv.characterIds
    : (conv?.characterId ? [conv.characterId] : []);
  return ids.map((id) => all.find((c) => String(c.id) === String(id)) || { id, name: "（角色已删除）" });
}

/**
 * 按角色分配声音。
 *
 * 改动即时保存（不等那个“保存”键）：一条声音的得失是一笔小而清楚的写，
 * 而“改完了忘了按保存”是这类面板最常见的怨气。
 */
function renderVoiceMap(cfg) {
  const box = $("tts-voice-map");
  if (!box) return;
  const chars = convCharacters();
  if (chars.length === 0) {
    box.innerHTML = `<div class="hint">先开一场对话——按角色分配是“这场里谁该是什么声音”。</div>`;
    return;
  }

  const meta = providers.find((x) => x.id === cfg.provider);
  const voices = [...(meta?.voices || [])];
  for (const v of Object.values(cfg.voices || {})) if (v && !voices.includes(v)) voices.push(v);

  box.innerHTML = chars.map((ch) => {
    const cur = cfg.voices?.[ch.id] || "";
    const opts = [`<option value="">跟随默认${cfg.voice ? `（${escapeHtml(cfg.voice)}）` : ""}</option>`]
      .concat(voices.map((v) => `<option value="${escapeHtml(v)}"${v === cur ? " selected" : ""}>${escapeHtml(v)}</option>`));
    return `<div class="tts-vm-row">
      <span class="tts-vm-name">${escapeHtml(ch.name || ch.id)}</span>
      <select class="tts-vm-sel" data-cid="${escapeHtml(ch.id)}">${opts.join("")}</select>
    </div>`;
  }).join("");

  box.querySelectorAll(".tts-vm-sel").forEach((sel) => {
    sel.addEventListener("change", async () => {
      try {
        const res = await apiFetch("tts/config", {
          method: "PUT",
          body: JSON.stringify({ voices: { [sel.dataset.cid]: sel.value } })
        });
        const fresh = readEnvelope(res, "保存角色声音");
        current = fresh;
        renderStatus(fresh);
      } catch (e) {
        toast("存不住这个声音：" + friendlyError(e), "error");
      }
    });
  });
}

function renderStatus(cfg) {
  const el = $("tts-status");
  if (!el) return;
  const p = providers.find((x) => x.id === cfg.provider);
  const name = p ? p.label : cfg.provider;
  el.classList.toggle("bad", !cfg.ready);
  el.textContent = cfg.ready
    ? `当前用：${name} · 已配好，可以去消息旁边点那个小喇叭了`
    : `当前用：${name} · ${cfg.reason || "还没配好"}`;
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
async function saveTts(silent = false) {
  const res = await apiFetch("tts/config", {
    method: "PUT",
    body: JSON.stringify(collectPatch())
  });
  const cfg = readEnvelope(res, "保存语音设置");
  fillForm(cfg);
  if (!silent) toast(cfg.ready ? "语音设置已保存" : "已保存——" + (cfg.reason || ""), cfg.ready ? "success" : "error");
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
    const st = $("tts-status");
    if (st) { st.classList.add("bad"); st.textContent = "读不到语音配置：" + friendlyError(e); }
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
  modal.addEventListener("click", (e) => { if (e.target === modal) closeTts(); });

  $("tts-save")?.addEventListener("click", async () => {
    try { await saveTts(false); }
    catch (e) { toast("保存失败：" + friendlyError(e), "error"); }
  });

  // 试听：先保存再出声——否则"我刚才填的生效了吗"要靠猜。
  $("tts-preview")?.addEventListener("click", async () => {
    const btn = $("tts-preview");
    const sample = $("tts-sample")?.value || "夜色落在城墙上，我在这里守夜。";
    if (btn) btn.disabled = true;
    try {
      const cfg = await saveTts(true);
      if (!cfg.ready) {
        const st = $("tts-status");
        if (st) { st.classList.add("bad"); st.textContent = `还不能试听：${cfg.reason || "配置不完整"}`; }
        return;
      }
      const r = await speakText(sample, { key: "preview" });
      if (r?.ok) toast("试听中…", "success");
    } catch (e) {
      toast("试听失败：" + friendlyError(e), "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

export { saveTts };
