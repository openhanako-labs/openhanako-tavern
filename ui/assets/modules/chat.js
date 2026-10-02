// chat.js — 由 characters.js 按功能拆分（B5）

import { hana } from "../sdk.js";
import { apiFetch, apiUrl, confirmDialog, escapeHtml, extractArray, formatTime, friendlyError, openImageViewer, toast, unwrap } from "./core.js";
import { splitFailure, detailIsShort } from "./illustration-failure.js";
import { renderMarkdown, renderOpening, stripForDisplay } from "./markdown.js";
import { splitStatusBlock } from "./status-block.js";
import { envFromStatus, envText } from "./env-line.js";
import { renderStoryCard } from "./story-card.js";
// 宏引擎用 ui/assets/lib/macros.js（/ui/ 可达域内的镜像）。
// 早期写成 ../../../lib/... —— URL 层级多 _surface/<token> 两级，且 lib/
// 不在 /ui/ 暴露域：整张模块图 404，页面停在"加载中"的静态初始态。
import { createMacroProcessor, contextFromCharacter } from "../lib/macros.js";
import { openDrawer, boardColumnOpen } from "./shell.js";
import { dom } from "./dom.js";
import { state } from "./state.js";


/**
 * 角色 id → 名字。群聊的气泡与发言者行都要用。
 * （消息上只存 id，不存名字——名字改了不该让旧消息说谎。）
 */
function charNameOf(id) {
  const hit = (state.charList || []).find(c => String(c.id) === String(id));
  return hit?.name || "（角色已删除）";
}

// ── 说话人区分色（群友需求：说话人一眼可辨）──
// 色相按 speakerId 稳定哈希到 7 档池；饱和度/亮度钉死在 CSS（--spk-c）。
// 同一角色全场同色；色板与纪律见 docs/spec-ui-tokens.md「说话人色板」。
const SPEAKER_HUES = [18, 42, 96, 152, 205, 262, 320];
function speakerHueOf(key) {
  const s = String(key || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return SPEAKER_HUES[h % SPEAKER_HUES.length];
}
function speakerKeyOf(m) {
  if (m.role === "system") return ""; // 旁白/系统提示不属于任何人，不染色
  if (m.role === "user") return "user";
  return m.speakerId || state.currentCharacter?.id || m.role;
}

/** 最后一条 assistant 消息的 id——换一版/重生只对它有效（后端截到最后一条用户消息为止）。 */
function lastAssistantIdOf() {
  const ms = state.currentConv?.messages || [];
  for (let i = ms.length - 1; i >= 0; i--) if (ms[i].role === "assistant") return ms[i].id;
  return null;
}

/**
 * 头像格里的那一个字。
 *
 * 样张 v4 用「头像 + 说话人 + 直排正文」取代气泡——而头像**不是图片**，
 * 是名字首字。所以这条改动不需要任何立绘数据，任何角色卡都立刻成立。
 * 认不出名字时给一个点：空框看起来像「图没加载出来」，一个点只是「没有名字」。
 */
function msgAvaText(m) {
  if (m.role === "user") {
    const un = state.currentConv?.userName || state.userProfile?.userName;
    return un ? un.slice(0, 1) : "你";
  }
  const name = m.speakerId ? charNameOf(m.speakerId) : (state.currentCharacter?.name || "");
  return name ? name.slice(0, 1) : "·";
}

/**
 * 说话人那一行。
 *
 * 样张里**每条**都有它（单人对话、玩家自己也都有）——因为气泡没了之后，
 * 「这是谁说的」只剩下这一行可以读。旧代码只在群聊里输出，单人就整条没有归属。
 *
 * system 是旁白式的居中提示，不属于任何人，不给。
 */
/** 头像格。assistant 消息显示角色立绘（有的话），user 显示「你」。 */
function avaHtml(m) {
  if (m.role === "system") return "";
  if (m.role === "user") {
    const un = state.currentConv?.userName || state.userProfile?.userName;
    // 全局头像已配置 → 占位格留给 hydrate 填图；没配则维持字格
    if (state.userProfile?.avatar) {
      return `<div class="msg-ava msg-ava-uimg" data-uava="1" title="${escapeHtml(un || "你")}"></div>`;
    }
    return `<div class="msg-ava">${escapeHtml(un ? un.slice(0, 1) : "你")}</div>`;
  }
  const name = m.speakerId ? charNameOf(m.speakerId) : (state.currentCharacter?.name || "");
  const id = m.speakerId ? String(m.speakerId) : String(state.currentCharacter?.id || "");
  // 有角色卡 id 就拼立绘 <img>（apiAvatarBlobUrl 异步填 src，挂 attachSpriteClick）；
  // 取不到就退回首字母——立绘是增强，不是门槛。
  if (id && id !== "undefined") {
    return `<div class="msg-ava msg-ava-img" data-ava="${escapeHtml(id)}" data-ava-name="${escapeHtml(name)}" title="${escapeHtml(name)}"></div>`;
  }
  return `<div class="msg-ava">${escapeHtml(name ? name.slice(0, 1) : "·")}</div>`;
}

function speakerLineHtml(m) {
  if (m.role === "system") return "";
  if (m.role === "user") {
    const un = state.currentConv?.userName || state.userProfile?.userName;
    return `<div class="msg-speaker">${escapeHtml(un || "你")}</div>`;
  }
  const name = m.speakerId ? charNameOf(m.speakerId) : (state.currentCharacter?.name || "");
  return name ? `<div class="msg-speaker">${escapeHtml(name)}</div>` : "";
}

/**
 * 插图消息的正文（第 2 批 2.7）。
 * 三态：pending / ok / failed。每态都是不同的一块，不共享。
 *
 * 为什么不用 CSS spinner：App 里没有统一 spinner 样式，
 * 而字符动画（CSS animation on ::before）在部分嵌入环境里不跑。
 * 所以用「脉动的圆点」——两个 CSS keyframes 就行。
 */
function renderIllustrationBody(m) {
  const promptLine = m.prompt
    ? `<div class="illus-prompt">${escapeHtml(m.prompt)}</div>`
    : "";
  if (m.status === "pending") {
    return `<div class="illus-pending">
      <span class="illus-spinner">●</span> 正在画这一幕…
      ${promptLine}
    </div>`;
  }
  if (m.status === "failed") {
    /*
     * 一句人话 + 原话收在「详情」里（见 illustration-failure.js 的文件头）。
     *
     * 这里原本是把宿主原话**整段**糊进聊天：跨四层调用链、中英夹杂。
     * 判据 4 要的是“不许换成一句笼统的生成失败”，不是“把栈晒给用户看”。
     */
    const { headline, detail } = splitFailure(m.failReason);
    const detailHtml = detail
      ? (detailIsShort(detail)
        ? `<div class="illus-reason">${escapeHtml(detail)}</div>`
        : `<details class="illus-detail"><summary>详情</summary><pre>${escapeHtml(detail)}</pre></details>`)
      : "";
    return `<div class="illus-failed">
      <div class="illus-failed-title">❌ 这张没画出来</div>
      <div class="illus-headline">${escapeHtml(headline)}</div>
      ${detailHtml}
      ${promptLine}
    </div>`;
  }
  /*
   * ok，但**参考图那条路没生效**。
   *
   * 图是出来了，可它没带上她——这时候不说，用户只会以为“模型画得不像”，
   * 而真相是“参考图根本没用上”。与 refNote（该卡没立绘）分开说：
   * 一个是“有但用不了”，一个是“本来就没有”。
   */
  const refLine = m.degraded
    ? `<div class="illus-note">参考图没生效——这张是纯文生图，可能不太像她。</div>`
    : (m.refNote ? `<div class="illus-note">${escapeHtml(m.refNote)}</div>` : "");

  // ok：图片从 /media/:id 拿 base64，前端拼 data URL
  return `<div class="illus-ok">
    <img class="illus-img" alt="${escapeHtml(m.prompt || "场景插图")}" data-media-id="${escapeHtml(m.mediaId || "")}" />
    ${promptLine}${refLine}
  </div>`;
}

/**
 * 把插图消息里那些带 data-media-id 的 <img> 填上真图。
 *
 * 从 /media/:id 拿 base64，拼成 data URL 写进 src。
 * 为什么不用 <img src="/media/:id">：真机里裸路径没有鉴权，会 403。
 * 所以走 JSON 通道拿 base64，与头像那条路同一个方向。
 */
async function loadIllustrationImages() {
  const imgs = dom.messagesContainer.querySelectorAll(".illus-img[data-media-id]");
  for (const img of imgs) {
    const id = img.dataset.mediaId;
    if (!id || img.dataset.loaded === "1") continue;
    img.dataset.loaded = "1";
    try {
      const r = await apiFetch(`media/${encodeURIComponent(id)}`);
      if (r.ok && r.data?.base64) {
        img.src = `data:${r.data.mime || "image/png"};base64,${r.data.base64}`;
        /*
         * 点开放大（2.7 要的那一半）。
         *
         * 之前只给**头像**绑了 bindAvatarZoom，插图没绑——画出来了却点不开，
         * 而计划里写的是“缩略图 + 点开放大 + 生成中/失败三态”。
         * 这里连图都不用再取一趟：base64 已经在手上，直接交给浮层。
         */
        img.classList.add("illus-zoomable");
        img.addEventListener("click", () => openImageViewer(img.src, img.alt || "场景插图"));
      } else {
        // 图没了：把 src 清空，给个提示
        img.src = "";
        img.alt = "插图文件已不存在";
        img.classList.add("illus-img-missing");
      }
    } catch {
      img.alt = "插图加载失败";
      img.classList.add("illus-img-missing");
    }
  }
}

/**
 * 插图轮询（第 2 批 2.7）。
 *
 * 服务端在 SSE done 之后异步触发插图生成，前端不知道什么时候好。
 * 所以发完一条消息后，每 4 秒问一次 /illustration/latest，
 * 看到 status 从 pending 变 ok/failed 就停。
 *
 * 纪律：
 *   · 同一场同一时间只跑一个轮询（幂等）。
 *   · 最多轮询 60 次（4 分钟），避免插图永远不会完成时死循环。
 *   · 用户离开这一场就停。
 */
let illusPollTimer = null;
let illusPollConvId = null;
let illusPollCount = 0;
const ILLUS_POLL_INTERVAL = 4000;
const ILLUS_POLL_MAX = 60;

function stopIllustrationPoll() {
  if (illusPollTimer) {
    clearTimeout(illusPollTimer);
    illusPollTimer = null;
  }
  illusPollConvId = null;
  illusPollCount = 0;
}

async function pollIllustration() {
  // 用户已经离开这一场：不轮询
  if (state.currentConv?.id !== illusPollConvId) return stopIllustrationPoll();
  if (illusPollCount++ >= ILLUS_POLL_MAX) return stopIllustrationPoll();

  try {
    const r = await apiFetch(`conversations/${encodeURIComponent(illusPollConvId)}/illustration/latest`);
    const latest = r.data?.latest;
    if (!latest || latest.status !== "pending") {
      // 要么没有插图，要么已经完成了：都停轮询，重画一次
      if (latest) {
        /*
         * 图是**新的一条消息**，不是更新已有那条。
         *
         * 服务端在回复落盘之后才异步追加它（先 pending，再回写 ok/failed），
         * 所以前端手里根本没有这条。只做 map 更新的话，永远匹配不到——
         * 出图成功了、消息也在库里，屏幕上什么都不出现。
         * 【2026-09-27 修：匹配不到就追加，而不是默默什么都不做】
         */
        if (state.currentConv.messages.some(m => m.id === latest.id)) {
          state.currentConv.messages = state.currentConv.messages.map(m =>
            m.id === latest.id ? latest : m
          );
        } else {
          state.currentConv.messages.push(latest);
        }
        renderMessages();
      }
      stopIllustrationPoll();
      return;
    }
    // 还是 pending：继续等
    illusPollTimer = setTimeout(pollIllustration, ILLUS_POLL_INTERVAL);
  } catch {
    // 网络失败：继续下一次
    illusPollTimer = setTimeout(pollIllustration, ILLUS_POLL_INTERVAL);
  }
}

export function startIllustrationPoll(convId) {
  stopIllustrationPoll();
  illusPollConvId = convId;
  illusPollCount = 0;
  illusPollTimer = setTimeout(pollIllustration, ILLUS_POLL_INTERVAL);
}

import { participantsOf, nextSpeaker } from "./speaker-rotation.js";

/**
 * 这一场要不要自动轮换。
 *
 * 之前存在 localStorage 里——那是**全局**偏好，而「这一场怎么轮」是场景属性：
 * 有的场就该轮流开口，有的场该一直由同一个人回答。
 * 现在挂在对话上（与 presetId 同一条设计）。
 * 读侧兜底：旧对话没有这个字段 → false。
 */
function autoRotateEnabled() {
  return state.currentConv?.autoRotate === true;
}

/*
 * 选中发言者的**详情卡**（按需拉 + 缓存）。
 *
 * 为什么不能直接用 state.charList：列表接口 `GET /characters` 只回摘要
 * （服务端注释写着“列表只有摘要”），**没有 first_mes**。
 * 而“开场”那一块需要知道这一轮是谁的卡——所以只能按 id 取一次详情。
 */
const speakerCardCache = new Map();
async function ensureSpeakerCard(id) {
  if (!id) return null;
  if (speakerCardCache.has(id)) return speakerCardCache.get(id);
  try {
    const card = unwrap(await apiFetch(`characters/${id}`)) || null;
    speakerCardCache.set(id, card);
    return card;
  } catch {
    return null;
  }
}

/** 轮到下一位发言者。只在开关打开且真的是群聊时才动。 */
function rotateSpeaker() {
  if (!autoRotateEnabled()) return;
  const ids = participantsOf(state.currentConv);
  if (ids.length < 2) return;
  state.speakerId = nextSpeaker(ids, state.speakerId);
}

/**
 * 群聊的「这一轮谁说话」。
 *
 * 单人对话整行不出现——一个没分支的选择只会让人以为非选不可。
 * 换人**默认不自动**：谁开口是作者的判断。想自动轮流的人，
 * 把右边那个「自动」打开——但默认值是关，因为轮转是他的决定（见 state.js）。
 */
export function renderSpeakerRow() {
  const row = document.getElementById("speaker-row");
  if (!row) return;
  const conv = state.currentConv;
  const ids = participantsOf(conv);

  if (ids.length < 2) {
    row.classList.add("hidden");
    row.innerHTML = "";
    state.speakerId = null;
    return;
  }

  const current = ids.includes(state.speakerId) ? state.speakerId : ids[0];
  state.speakerId = current;
  // 这位的详情卡还没拿到过 → 拉一次；回来时若还停在开场态，重画一下。
  // （缓存命中就直接跳过，不会又触发一轮重绘。）
  if (!speakerCardCache.has(current)) {
    ensureSpeakerCard(current).then((card) => {
      if (card && !state.currentConv?.messages?.length) renderMessages();
    });
  }
  const auto = autoRotateEnabled();
  row.innerHTML =
    `<span class="speaker-label">这一轮谁说话</span>` +
    ids.map(id => `<button type="button" class="speaker-chip${String(id) === String(current) ? " on" : ""}" data-speaker="${escapeHtml(id)}">${escapeHtml(charNameOf(id))}</button>`).join("") +
    `<button type="button" class="speaker-auto${auto ? " on" : ""}" id="speaker-auto" aria-pressed="${auto ? "true" : "false"}" title="发完一条后自动轮到下一位（默认关）">自动</button>`;
  row.classList.remove("hidden");
  row.querySelectorAll("[data-speaker]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.speakerId = btn.dataset.speaker;
      renderSpeakerRow();
    });
  });
  row.querySelector("#speaker-auto")?.addEventListener("click", async () => {
    // 先落服务端再改本地：写失败就什么都不动，
    // 屏幕不会先翻成“开”再默默翻回来。
    const next = !autoRotateEnabled();
    try {
      await apiFetch(`conversations/${state.currentConv.id}/rotation`, {
        method: "PUT",
        body: JSON.stringify({ autoRotate: next })
      });
    } catch (e) {
      toast("改不了这一场的轮换设置: " + friendlyError(e), "error");
      return;
    }
    if (state.currentConv) state.currentConv.autoRotate = next;
    renderSpeakerRow();
  });
}

/**
 * 私语：这一句给谁听（群聊才有）。
 *
 * 为什么单独一行、不塞进发言者那行：那是两个不同的问题——
 * 「这一轮谁说话」与「这句给谁听」。挤在一行里，选错是迟早的事。
 * 单人对话整行不出现（没有“别人”可矞）。
 */
function renderWhisperRow() {
  const row = document.getElementById("speaker-row");
  if (!row) return;
  let wr = document.getElementById("whisper-row");
  const conv = state.currentConv;
  const ids = participantsOf(conv);

  if (!conv || ids.length < 2) {
    if (wr) { wr.classList.add("hidden"); wr.innerHTML = ""; }
    state.whisperTo = null;
    return;
  }
  if (!wr) {
    wr = document.createElement("div");
    wr.id = "whisper-row";
    wr.className = "whisper-row hidden";
    row.parentNode?.insertBefore(wr, row.nextSibling);
  }
  const on = Array.isArray(state.whisperTo) && state.whisperTo.length > 0;
  wr.innerHTML =
    `<button type="button" class="whisper-toggle${on ? " on" : ""}" id="whisper-toggle" aria-pressed="${on ? "true" : "false"}" title="这句只给选中的那几位听">私语</button>` +
    (on
      ? `<span class="whisper-label">给</span>` +
        ids.map(id => `<button type="button" class="whisper-chip${state.whisperTo.includes(id) ? " on" : ""}" data-whisper="${escapeHtml(id)}">${escapeHtml(charNameOf(id))}</button>`).join("") +
        `<span class="whisper-note">其他人看不到这句</span>`
      : `<span class="whisper-note">打开后选谁听得到</span>`);
  wr.classList.remove("hidden");

  wr.querySelector("#whisper-toggle")?.addEventListener("click", () => {
    // 默认全选，再点掉不想给的——比“一个一个加”快。
    state.whisperTo = on ? null : [...ids];
    renderWhisperRow();
  });
  wr.querySelectorAll("[data-whisper]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.whisper;
      const cur = Array.isArray(state.whisperTo) ? [...state.whisperTo] : [];
      const i = cur.indexOf(id);
      if (i >= 0) cur.splice(i, 1); else cur.push(id);
      state.whisperTo = cur;
      renderWhisperRow();
    });
  });
}

/** 状态栏的呈现：一个默认收起的条。展开就是原来那段原文。 */
function statusBlockHtml(status, items) {
  if (!status) return "";
  return `<details class="status-block">` +
    `<summary><span class="sb-label">状态栏</span><span class="sb-n">${items} 项</span></summary>` +
    `<pre class="sb-body">${escapeHtml(status)}</pre></details>`;
}

/**
 * assistant 正文的统一入口：先切状态栏，剩下的交给 markdown。
 *
 * dialogue: true 打开对白标记（引号配对，判据在 markdown.js）。
 * 它只把引号里的字包一层 span，不动结构——静态渲染和流式增量
 * 都经过这个函数，所以一处打开，两条路一起生效。
 */
function renderAssistantBody(text) {
  // 净化先于状态块拆分（计划 A2）：</opening>、注释块、整行 // 不先进拆分器，
  // 不会被压进状态块误判；模型收到的原文不动，只净 UI 显示。
  const { status, body, items } = splitStatusBlock(stripForDisplay(text));
  const env = envText(envFromStatus(status));
  return envLineHtml(env) + statusBlockHtml(status, items) + renderMarkdown(body, { dialogue: true });
}

/**
 * 环境行：从状态栏里挑出的时间 / 地点 / 天候，拼成叙述上方那一行。
 *
 * 为什么从状态栏拿：这些事实本来就在状态栏里，模型每轮自己报。
 * 认不出来（env 为空串）就整行不渲染——宁可没有，也不要写一行假的。
 */
function envLineHtml(env) {
  return env ? `<div class="env-line">${escapeHtml(env)}</div>` : "";
}

export function renderMessages() {
  /*
   * 发言者行放在**最上面**，不能放在有消息的那条路径里。
   *
   * 教训：它原先被我插在主路径（有消息）末尾，于是**刚建好的群聊**——
   * 0 条消息、走的空态分支——根本看不到它，而那时恰恰是最需要
   * 选“这一轮谁说话”的时刻。函数有三个早退分支，放最上面才不挑分支。
   */
  renderSpeakerRow();
  renderWhisperRow();
  /*
   * 空的时候分两种，而且两种都不该只说「暂无消息」。
   *
   * 之前这里一句 innerHTML = 暂无消息 把两种情况搎成了一句，
   * 还顺手把 HTML 里那句更有用的「从左边挑一个角色开始」也盖掉了。
   * 而一个开着的对话空着时，真正该在中间的是**开场**——
   * 它就是开场白，也是发第一条时真正会发出去的那句。
   */
  if (!state.currentConv) {
    dom.messagesContainer.innerHTML =
      '<div class="empty"><div class="empty-title">从左边挑一个角色开始</div>' +
      '<div class="hint">点头像直接开聊</div></div>';
    renderSuggestions();
    renderHeaderMeta();
    return;
  }

  if (!state.currentConv.messages?.length) {
    const macro = state.macro || null;
    /*
     * 群聊里“开场”该是谁的？——**这一轮选中的那位**。
     * 用主角的会撒谎：明明选着任十九，屏幕上却是薇拉的开场白。
     * 选中的卡在 charList 里找不到时（刚被删），宁可不说，
     * 也不拿别人的顶上去——单人对话才退回 currentCharacter。
     */
    const ids = participantsOf(state.currentConv);
    const speakId = ids.includes(state.speakerId) ? state.speakerId : (ids[0] || null);
    const found = speakId
      ? (speakerCardCache.get(speakId) || (state.charList || []).find(c => String(c.id) === String(speakId)))
      : null;
    const card = found || (ids.length < 2 ? state.currentCharacter : null) || null;
    const first = card?.first_mes || "";
    const opening = first ? (macro ? macro.process(first) : first) : "";
    dom.messagesContainer.innerHTML = opening
      ? `<div class="empty scene-empty">
           <div class="scene-kicker">开场${ids.length > 1 && card ? ` · ${escapeHtml(card.name || "")}` : ""}</div>
           <div class="scene-body">${renderOpening(opening)}</div>
           <div class="hint">发一条消息就开场；这一条会作为第一句发给模型</div>
         </div>`
      : '<div class="empty"><div class="empty-title">这一场还没有消息</div>' +
        '<div class="hint">在下面说点什么</div></div>';
    renderSuggestions();
    renderHeaderMeta();
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
    // 插图消息（第 2 批 2.7）：不走正文渲染，按 status 显示
    if (m.kind === "illustration") {
      const spk = speakerLineHtml(m);
      return `<div class="message ${m.role} illustration" data-id="${m.id}" data-media-id="${escapeHtml(m.mediaId || "")}">
        ${avaHtml(m)}
        <div class="msg-col">
          ${spk}
          <div class="bubble illus-bubble">${renderIllustrationBody(m)}</div>
          <div class="msg-foot">
            <div class="msg-acts">
              <button class="mini" data-act="del" data-id="${m.id}">删除</button>
            </div>
            <div class="time">${formatTime(m.timestamp)}</div>
          </div>
        </div>
      </div>`;
    }
    // assistant 正文开头的状态栏块要折起来——它压在叙述上面（见 splitStatusBlock）
    // 剧情卡（cwv1）：msg.story.found 时用杂志分栏卡渲染，效果 chips 归卡片管；
    // plainRemainder（混排的普通正文）照走气泡渲染。无 story 一律走原路径。
    const hasStory = m.role === "assistant" && m.story && m.story.found;
    const hasVarDiff = Array.isArray(m.varDiff) && m.varDiff.length > 0;
    let body;
    if (hasStory) {
      const card = renderStoryCard(m.story, { hasVarDetail: hasVarDiff });
      const rest = String(m.story.plainRemainder || "").trim();
      body = card + (rest ? `<div class="sc-rest">${renderAssistantBody(expand(rest))}</div>` : "");
    } else {
      body = m.role === "assistant"
        ? renderAssistantBody(expand(m.content))
        : escapeHtml(expand(m.content));
    }
    const acts = `<div class="msg-acts">
        <button class="mini" data-act="copy" data-id="${m.id}" title="复制">复制</button>
        <button class="mini" data-act="speak" data-id="${m.id}" title="读出来">朗读</button>
        <button class="mini" data-act="edit" data-id="${m.id}">编辑</button>
        <button class="mini" data-act="del" data-id="${m.id}">删除</button>
        ${m.role === "assistant" && String(m.id) === String(lastAssistantIdOf()) ? `<button class="mini" data-act="swipe" data-id="${m.id}" title="保留这版，另生成一版（旧版进变体可切回）">换一版</button>
        <button class="mini" data-act="regen" data-id="${m.id}" title="丢掉这版重新生成">重生</button>` : ""}
        ${m.role === "assistant" && Array.isArray(m.variants) && m.variants.length > 1 ? `<span class="vsw"><button class="mini" data-act="vprev" data-id="${m.id}" title="上一版">‹</button><span class="vsw-n">${(Number.isInteger(m.variantIndex) ? m.variantIndex : m.variants.length - 1) + 1}/${m.variants.length}</span><button class="mini" data-act="vnext" data-id="${m.id}" title="下一版">›</button></span>` : ""}
      </div>`;
    // 本轮变量变化的账：正文下方一行小 chips。
    // 服务端连显示用的字都拼好了（text）——前端只负责印，
    // 免得同一条拼字逻辑长成第二份双胞胎镜像。
    // 行末的「明细 ›」进 S1 面板——chips 行本身保留作速览，不删。
    // 剧情卡已把效果 chips 收进卡片（hasStory），这里不再重复画一遍 varLine，
    // 但「明细 ›」入口跟着卡片走（见 story-card.js）——账不丢。
    const varLine = !hasStory && Array.isArray(m.varDiff) && m.varDiff.length > 0
      ? `<div class="msg-vars">${m.varDiff.map(d => `<span class="var-chip" data-change="${escapeHtml(d.change || "set")}">${escapeHtml(d.text || d.name || "")}</span>`).join("")}
           <button type="button" class="mini vars-detail" data-act="vars-detail" data-id="${m.id}" title="本轮发生了什么">明细 ›</button>
         </div>`
      : "";
    // 群聊：这条回复是谁说的。名字从角色列表解（消息上只存 id）。
    const spk = speakerLineHtml(m) +
      // 私语要标出来：屏幕上谁都看得到全部，但“这句当时只给了谁”是历史的一部分。
      (Array.isArray(m.audience)
        ? `<div class="whisper-badge">${m.audience.length === 0
            ? "私语 · 谁都没给"
            : "私语 · 只给 " + m.audience.map(id => escapeHtml(charNameOf(id))).join("、")}</div>`
        : "");
    const spkKey = speakerKeyOf(m);
    const spkStyle = spkKey ? ` style="--spk-h:${speakerHueOf(spkKey)}"` : "";
    return `<div class="message ${m.role}" data-id="${m.id}"${spkStyle}>
      ${avaHtml(m)}
      <div class="msg-col">
        ${spk}
        <div class="bubble">${body}</div>
        ${varLine}
        <div class="msg-foot">
          ${acts}
          <div class="time">${formatTime(m.timestamp)}</div>
        </div>
      </div>
    </div>`;
  }).join("");
  // 插图消息里带 data-media-id 的 <img> 要填上真图（base64）
  loadIllustrationImages();
  // 会话头像立绘：异步填 src + 挂点击反应
  hydrateMsgAvatars();

  // 事件委托：消息多了逐个绑会很慢，而且重渲染后要重绑一遍
  dom.messagesContainer.querySelectorAll(".message").forEach(el => {
    const id = el.dataset.id;
    el.querySelector('[data-act="copy"]')?.addEventListener("click", () => copyMessage(id));
    // 剧情卡选项：填进输入框并聚焦，不直接发——
    // 与 suggest-chip 同一条哲学（候选项是起点不是命令，人常想改两个字再发）。
    el.querySelectorAll(".sc-choice").forEach(btn => {
      btn.addEventListener("click", () => {
        dom.chatInput.value = btn.dataset.choice || "";
        dom.chatInput.focus();
      });
    });
    // 变量账明细：S1 面板。动态 import 保持 chat.js 启动轻。
    el.querySelector('[data-act="vars-detail"]')?.addEventListener("click", () => {
      import("./var-diff-modal.js").then(m => m.open(m.findMessage(id) || null)).catch(e => {
        console.error("[var-diff-modal] open failed:", e);
      });
    });
    el.querySelector('[data-act="speak"]')?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      // 用现成的 findMessage，不要在这里重新写一遍查找：
      // 消息 id 是**数字**，而 dataset.id 永远是**字符串**——
      // 自己写 `x.id === id` 会永远不相等，于是处理器在下一行直接 return：
      // 点了没反应，而且不报错。（探针里就撞上这个。）
      const m = findMessage(id);
      if (!m) return;
      // 读的是**还原宏之后**的文本：{{user}} 不该被念成花括号。
      const plain = macro ? macro.process(String(m.content ?? "")) : String(m.content ?? "");
      // 动态 import：语音模块只在真去点它的时候才加载，
      // 也让 chat.js 不必在启动时就依赖播放那套东西。
      const { speakText, isSpeaking } = await import("./tts.js");
      // 谁在说 → 用谁的声音。群聊里每条消息的 speakerId 就是那个人；
      // 单人对话没 speakerId，就用这场的主角。
      const speakerId = m.speakerId || state.currentConv?.characterId || "";
      const label = btn.textContent;
      try {
        const r = await speakText(plain, { key: id, characterId: speakerId, onState: () => { btn.textContent = label; } });
        // 播起来了显示“停”（再点一下就是停）；否则保持原样
        btn.textContent = r && r.ok ? "停" : label;
      } catch {
        btn.textContent = label;
      }
      if (!isSpeaking(id)) btn.textContent = label;
    });
    el.querySelector('[data-act="edit"]')?.addEventListener("click", () => startEditMessage(id));
    el.querySelector('[data-act="del"]')?.addEventListener("click", () => deleteMessage(id));
    el.querySelector('[data-act="swipe"]')?.addEventListener("click", () => swipeVariant(id));
    el.querySelector('[data-act="regen"]')?.addEventListener("click", () => regenerateFrom(id));
    el.querySelector('[data-act="vprev"]')?.addEventListener("click", () => switchVariant(id, -1));
    el.querySelector('[data-act="vnext"]')?.addEventListener("click", () => switchVariant(id, 1));
  });

  dom.messagesContainer.scrollTop = dom.messagesContainer.scrollHeight;

  // 候选项跟着消息走：最后一条 assistant 换了（发新消息、重生、删），
  // 这里就自动跟着换或消失。
  renderSuggestions();
  // 顶栏那一行的「第 N 轮」也要跟着走——否则发完一轮还停在上一轮的读数
  renderHeaderMeta();
}


/** 推进羻绊：调 /bonds/:id/advance，成功后重拉对话渲染。 */
/** 角色头像的会话级记忆：同一角色全场只拉一次。
 *  过去按元素去重，同角色 100 条消息就是 100 次 avatar.json——长对话卡顿的源头之一。 */
const msgAvaCache = new Map();
function avaUrlFor(id) {
  if (!msgAvaCache.has(id)) {
    msgAvaCache.set(id, apiAvatarBlobUrl(id, { keepPrevious: true }).catch((e) => {
      msgAvaCache.delete(id);
      throw e;
    }));
  }
  return msgAvaCache.get(id);
}

/** 会话头像立绘：为 .msg-ava-img 异步填 src，并挂点击反应（有热区时）。 */
async function hydrateMsgAvatars() {
  const imgs = dom.messagesContainer.querySelectorAll(".msg-ava-img[data-ava]");
  for (const img of imgs) {
    if (img.dataset.hydrated) continue;
    img.dataset.hydrated = "1";
    const id = img.dataset.ava;
    const name = img.dataset.avaName || "";
    try {
      const url = await avaUrlFor(id);
      img.innerHTML = `<img src="${url}" alt="${escapeHtml(name)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
      // 点击反应：找该角色的 sprite_reactions 数据挂上
      const card = (state.charList || []).find(x => String(x.id) === id) ||
        (state.currentCharacter && String(state.currentCharacter.id) === id ? state.currentCharacter : null);
      if (card?.sprite_reactions?.zones?.length) {
        const m = await import("./sprite-click-ui.js");
        m.attachSpriteClick(img, card);
      }
    } catch {
      // 没立绘：填首字母占位
      img.textContent = name ? name.slice(0, 1) : "·";
    }
  }

  // 全局 user 头像：一份 data URL，全场所有行共用同一引用，不逐条存图
  const ua = state.userProfile?.avatar;
  if (ua) {
    dom.messagesContainer.querySelectorAll(".msg-ava-uimg[data-uava]").forEach((el) => {
      if (el.dataset.hydrated) return;
      el.dataset.hydrated = "1";
      el.innerHTML = `<img src="${ua}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    });
  }
}

export async function advanceBond() {
  const conv = state.currentConv;
  if (!conv || conv.mode !== "bond" || state.isGenerating) return;
  state.isGenerating = true;
  const btn = document.getElementById("bond-advance-btn");
  if (btn) { btn.disabled = true; btn.textContent = "生成中…"; }
  try {
    const env = await apiFetch(`bonds/${conv.id}/advance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    const d = unwrap(env) || {};
    await openConversation(conv.id);   // 重拉，把新段与阶段读数都刷上来
    toast(`新的一段互动（关系阶段：${d.stage ?? "?"}）`, "success");
  } catch (e) {
    toast(`推进失败：${friendlyError(e)}`, "error");
  } finally {
    state.isGenerating = false;
    if (btn) { btn.disabled = false; btn.textContent = "推进羻绊"; }
  }
}

export async function sendMessage() {
  const content = dom.chatInput.value.trim();
  if (!content || !state.currentConv || state.isGenerating) return;
  dom.chatInput.value = "";
  state.isGenerating = true;
  dom.sendBtn.disabled = true;

  const userMsg = { id: Date.now(), role: "user", content, timestamp: new Date().toISOString() };
  // 本地这份也要带 audience：服务端存的有，但气泡是靠本地这条画的——
  // 不带的话“私语”标记要等重载才出现（屏幕先撒了一次谎）。
  if (Array.isArray(state.whisperTo) && state.whisperTo.length > 0) {
    userMsg.audience = [...state.whisperTo];
  }
  state.currentConv.messages.push(userMsg);
  renderMessages();

  const loadingEl = document.createElement("div");
  loadingEl.className = "message assistant loading";
  loadingEl.textContent = "生成中";
  dom.messagesContainer.appendChild(loadingEl);

  const streamEl = loadingEl;
  let gotReply = false; // Q2：这轮真的拿到正文了，才值得自动要方向
  try {
    // 优先走流式；失败或不可用时降级为一次性生成
    const streamRes = await sendMessageStream(content);

    if (streamRes && !streamRes.content) {
      /*
       * 通道通了，却一帧内容都没来。
       *
       * 这条**不能**再走降级：流式路径在生成之前就把用户消息落了盘，
       * 再 POST 一次 /messages 会把同一条消息写第二遍，屏幕和库里就对不上了。
       * 只有「通道压根没建起来」才允许降级——那一种在下面的 else 里。
       */
      loadingEl.remove();
      toast("这次没拿到回复——流式通道通了但一帧内容都没来。可以直接再发一条，或看一眼模型设置。", "error");
    } else if (streamRes && streamRes.content) {
      // 流式成功，移除 loading 并添加完整消息
      loadingEl.remove();
      /*
       * 正文用**流式函数自己的返回值**，不要引用 fullContent。
       *
       * 它曾经写成 content: fullContent——而 fullContent 声明在
       * sendMessageStream 里面（let fullContent = ""）。跨函数引用是
       * ReferenceError，被下面那个 catch 吞成一句 toast：
       * 气泡照样出现（流式自己画的），但这条回复**从来没进本地消息表**，
       * 而且它后面那几行（轮换、刷新会话列表）一行都不跑。
       *
       * 是 group-ui 探针抓出来的：开关全对、“发完自动轮换”却永不生效，
       * 因为那一行压根没被执行到。
       */
      const assistantMsg = {
        id: Date.now(),
        role: "assistant",
        content: streamRes.content,
        timestamp: new Date().toISOString()
      };
      state.currentConv.messages.push(assistantMsg);
      renderMessages();
      gotReply = true;
    } else {
      // 降级为同步
      // 同步生成：服务端把整段回复一次性返回，几十秒是常态——
      // 所以这条必须显式给长超时，不能吃 apiFetch 默认那 10 秒。
      const res = await apiFetch(`conversations/${state.currentConv.id}/messages`, {
        method: "POST",
        timeoutMs: 180_000,
        body: JSON.stringify({ content, speakerId: state.speakerId || undefined, audience: state.whisperTo || undefined })
      });
      if (res.data?.assistantMessage) {
        loadingEl.remove();
        state.currentConv.messages.push(res.data.assistantMessage);
        renderMessages();
        gotReply = true;
        // 非流式路径：插图也可能已经触发了（服务端保存后异步）
        startIllustrationPoll(state.currentConv.id);
      } else {
        loadingEl.remove();
        // 这里**没有异常对象**：请求是成功的，只是返回里没有回复。
        // （上一版写成了 `e ? ...` —— 那个 `e` 在这个作用域里根本不存在。）
        toast("这次没拿到回复——服务端返回里没有内容，可以重试一次", "error");
      }
    }
    // 发成功了才轮换。抛错走不到这里——换人依赖“这一轮真的落盘了”。
    // 私语是一次性的：发完就复位，免得下一条又惄惄发出去了。
    state.whisperTo = null;
    rotateSpeaker();
    // 轮完必须重画那一行：
    // 否则 state 已经到下一位、屏幕上还高亮着上一位。
    // （这条就是 group-ui 探针抓出来的：⑥b 开关全对，⑦ 发前发后都是同一个人。）
    // 界面撒谎比不轮换更坏——下一轮真的会换人，而用户以为没换。
    renderSpeakerRow();
    renderWhisperRow();
    await loadConversations();
    // Q2：正文落盘后自动给方向（输入区「自动」可关）。静默模式——
    // 这是附带的“看一眼”，失败不该打断阅读。
    if (gotReply && autoSuggestOn()) requestSuggestions({ quiet: true }).catch(() => {});
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
      body: JSON.stringify({ content, speakerId: state.speakerId || undefined, audience: state.whisperTo || undefined })
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
      // 与静态渲染同构：说话人色相也带上——重绘前的那几秒也要有区分色
      assistantMsgEl.style.setProperty("--spk-h", String(speakerHueOf(speakerKeyOf({
        role: "assistant",
        speakerId: state.speakerId || state.currentConv?.characterId
      }))));
      /*
       * 与静态渲染同构：头像 + 列。
       * 不同构的代价是可见的——流式结束时 acceptSavedMessage 会整场重画，
       * 消息会在那一帧「跳」一下（头像凭空出现、正文横移 41px）。
       */
      const streamSpeakerId = state.speakerId || state.currentConv?.characterId || "";
      const streamName = streamSpeakerId
        ? charNameOf(streamSpeakerId)
        : (state.currentCharacter?.name || "");
      assistantMsgEl.innerHTML =
        `<div class="msg-ava">${escapeHtml(streamName ? streamName.slice(0, 1) : "·")}</div>` +
        `<div class="msg-col">` +
        (streamName ? `<div class="msg-speaker">${escapeHtml(streamName)}</div>` : "") +
        `<div class="content"></div>` +
        `</div>`;
      dom.messagesContainer.appendChild(assistantMsgEl);
      try { loadingEl?.remove(); } catch { /* 已经拿掉 */ }
    };
    const paint = () => {
      if (!assistantMsgEl) return;
      // 和静态渲染走同一条路：流式过程中也别让状态栏裸着铺满屏幕
      assistantMsgEl.querySelector(".content").innerHTML = renderAssistantBody(fullContent);
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
              // 服务端落盘后的那条消息带回来的不只是正文：还有这一轮的变量账、
              // 行动候选项、以及真 id（没有它，刚出现的回复连按钮都没有）。
              // 收进内存再重画，屏上那条才和库里那条是同一个东西。
              //
              // 压力读数（meta）按「这一轮」算，不挂在消息上——它是读数不是记录。
              if (data.meta) state.lastMeta = data.meta;
              if (acceptSavedMessage(data.message)) renderMessages();
              renderUsageBar();
              // 插图可能已经在后台生成了（服务端在保存回复后异步触发）。
              // 前端不知道什么时候好，所以轮询。
              startIllustrationPoll(state.currentConv.id);
              // 这一轮可能写进了变量（{{setvar}}）。变量抽屉开着就顺手刷新，
              // 不然它会一直显示上一轮的值。
              if (!document.getElementById("drawer-variables")?.classList.contains("hidden")) {
                import("./variables.js").then(m => m.loadConvValues()).catch(() => {});
              }
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
              /*
               * 连接已经建立，这是**生成**出的错（模型未响应、上游 4xx）。
               *
               * 它和「流式通道压根没建起来」是两件事，处理方式也必须不同：
               * 通道没起来才允许降级重发；这里是已经发出去、模型跑了一半才断的，
               * 再走降级等于把同一条用户消息写第二遍，还白让模型重跑一遍。
               *
               * 原来写的是 return null 静默降级——真错只进 console，
               * 用户面前弹的是降级请求那条 10 秒超时的假象。
               * 两个错叠在一起，谁都看不见真凶。
               */
              const err = new Error(data.error?.message || data.error || "生成中断");
              err.fromStream = true;
              throw err;
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
    /*
     * 只有「通道没建起来」才返回 null 交给降级路径兜（宿主不支持 SSE、
     * 路由 404 这一类）。生成阶段断掉的错要原样往上抛——真因得能走到界面上，
     * 而不是被降级路径那条超时盖过去。
     */
    if (e?.fromStream) throw e;
    return null;
  }
}

export async function createConversation() {
  try {
    const res = await apiFetch("characters-for-conv");
    const characters = extractArray(res);
    const listEl = document.getElementById("conv-character-picks");
    if (!listEl) return;
    if (characters.length === 0) { toast("请先创建角色卡", "error"); return; }

    // 卡片点选（与角色抽屉同一套语言）。
    // 那个数字才是选卡时真正要看的：
    //   1 场 → 直接续   0 场 → 开新场   多条 → 弹选择器
    // convCount 从 state.convList 里就地数——**打开弹窗时先重拉一次**，
    // 否则 rail 那边删了对话，这边还拿着旧快照数（「删完了还显示 5 场」）。
    try {
      const convRes = await apiFetch("conversations");
      state.convList = extractArray(convRes);
    } catch { /* 拉不到就用手里那份，别拦着建对话 */ }
    const convs = state.convList || [];
    listEl.innerHTML = characters.map(c => {
      const convCount = convs.filter(x => x.characterId === c.id).length;
      const countText = convCount ? `${convCount} 场` : "还没开过";
      const initial = escapeHtml(String(c.name || "?").trim().slice(0, 1) || "?");
      return `
        <div class="conv-pick" data-char-id="${escapeHtml(String(c.id))}">
          <div class="cp-av">${initial}</div>
          <div class="cp-nm">${escapeHtml(c.name || "（无名称）")}</div>
          <div class="cp-ct">${countText}</div>
          <div class="cp-ck">✓</div>
        </div>`;
    }).join("");

    // 多选：默认单选，按住 Ctrl / Cmd 可多挑（向后兼容群聊）。
    listEl.querySelectorAll(".conv-pick").forEach(el => {
      el.addEventListener("click", (ev) => {
        if (ev.ctrlKey || ev.metaKey) {
          el.classList.toggle("selected");
          return;
        }
        listEl.querySelectorAll(".conv-pick").forEach(x => x.classList.remove("selected"));
        el.classList.add("selected");
      });
    });

    dom.newConvModalEl.classList.remove("hidden");
  } catch (e) {
    toast("加载角色失败：" + friendlyError(e), "error");
  }
}

export async function confirmNewConversation() {
  const picksEl = document.getElementById("conv-character-picks");
  // 多选：选一个 = 单人；选多个 = 群聊（**第一个是主角**，开场白由他出）。
  // 单人时只发 characterId，路径与以前逐字一样。
  const picked = [...(picksEl?.querySelectorAll(".conv-pick.selected") || [])]
    .map(el => el.dataset.charId).filter(Boolean);
  if (picked.length === 0) { toast("请选择角色", "error"); return; }
  try {
    const userName = (document.getElementById("conv-user-name")?.value || "").trim();
    const persona = (document.getElementById("conv-persona")?.value || "").trim();
    const body = picked.length > 1 ? { characterId: picked[0], characterIds: picked } : { characterId: picked[0] };
    // 表单里填了才带上；**留空就不带** —— 服务端会从这张卡最近一场继承
    // （人设跟卡走，原酒馆的规矩）。把空串写死传过去会把继承关掉。
    // 之前这两个框只存在于 HTML 里：填了、点创建、然后被丢掉。
    if (userName) body.userName = userName;
    if (persona) body.persona = persona;
    const res = await apiFetch("conversations", { method: "POST", body: JSON.stringify(body) });
    const conv = res.data || res;
    await loadConversations();
    await openConversation(conv.id);
    closeNewConvModal();
    // 左栏「最近会话」同步（操作 B：中间「新对话」建了场，左栏不刷）
    const { askRailRefresh } = await import("./nav-bus.js");
    askRailRefresh();
    toast(picked.length > 1 ? `群聊已创建（${picked.length} 位）` : "对话已创建", "success");
  } catch (e) {
    toast(`创建对话失败: ${friendlyError(e)}`, "error");
  }
}

export function closeNewConvModal() {
  dom.newConvModalEl.classList.add("hidden");
  // 关窗要清空：否则下一次开窗带着上一次的内容——用户以为“它记住了”，
  // 实际是要写进新场，还会把本该继承的那份覆盖掉。
  const un = document.getElementById("conv-user-name");
  const pe = document.getElementById("conv-persona");
  if (un) un.value = "";
  if (pe) pe.value = "";
  // 注意：?. 不能出现在赋值左侧（早期错误，整个模块会加载失败）。
  const picksEl = document.getElementById("conv-character-picks");
  if (picksEl) picksEl.innerHTML = "";
}

export async function deleteConversation() {
  if (!state.currentConv) return;
  // 说清删的是哪一场、会少什么。
  const title = state.currentConv.title || "这场对话";
  const n = (state.currentConv.messages || []).length;
  if (!(await confirmDialog({
    title: `删掉「${title}」？`,
    body: `里面的 ${n} 条消息、前情提要和这一场记下的变量都会一起删掉。`
  }))) return;
  try {
    await apiFetch(`conversations/${state.currentConv.id}`, { method: "DELETE" });
    toast("已删除", "success");
    await resetAfterConvGone();
  } catch (e) {
    toast(`删除失败: ${friendlyError(e)}`, "error");
  }
}

/** 对话没了之后的收尾：清空当前场、重拉列表、回空态。 */
async function resetAfterConvGone() {
  state.currentConv = null;
  await loadConversations();
  dom.messagesContainer.innerHTML = '<div class="empty">选择或创建对话开始聊天</div>';
  dom.chatInputArea.classList.add("hidden");
  dom.chatTitle.textContent = "选择对话";
}

/**
 * 左栏删掉了当前正看的那场（nav 消息 conv-deleted 过来）。
 * 删除本身已在 rail 那边发生，这里只负责收掉自己手里的现场——
 * 删的不是当前场就不动（state 里那场还活着）。
 */
export async function closeDeletedConversation(id) {
  if (!state.currentConv || String(state.currentConv.id) !== String(id)) return;
  await resetAfterConvGone();
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
  const ok = await confirmDialog({
    title: "删掉这条消息？",
    body: "删了之后前情提要会按剩下的内容重算一遍。"
  });
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
  // 告诉用户怎么退出去。之前这个状态**没有出口**：
  // 改到一半想放弃，只能把输入框清空再点“保存修改”，
  // 而空内容会被静默丢掉，用户根本不知道发生了什么。
  dom.chatInput.placeholder = "编辑中——Esc 取消";
}

/** 退出编辑，不保存。返回是否真的退出了（没在编辑就是 false）。 */
export function cancelEditMessage() {
  if (state.editingMessageId == null) return false;
  state.editingMessageId = null;
  dom.chatInput.value = "";
  const btn = document.getElementById("send-btn");
  if (btn) btn.textContent = "发送";
  dom.chatInput.placeholder = "输入消息…（Enter 发送，Shift+Enter 换行）";
  return true;
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

/** 换一版：把这版收进变体，另生成一版——‹ › 可切回旧版。 */
export async function swipeVariant(id) {
  if (!state.currentConv || state.isGenerating) return;
  state.isGenerating = true;
  toast("正在生成另一版…", "info");
  try {
    // 后端的 /regenerate 本来就会把旧回复存成变体（attachVariant）——
    // 过去这里发 variantOf 去打 /messages，后端根本不认那个字段，静默无效。
    await apiFetch(`conversations/${state.currentConv.id}/regenerate`, {
      method: "POST",
      body: JSON.stringify({})
    });
    await openConversation(state.currentConv.id);
  } catch (e) {
    toast("换版失败: " + friendlyError(e), "error");
  } finally {
    state.isGenerating = false;
  }
}

/** 重生：丢掉这版重新生成（旧版不保留，走 discardOld）。 */
export async function regenerateFrom(id) {
  if (!state.currentConv || state.isGenerating) return;
  if (String(id) !== String(lastAssistantIdOf())) {
    toast("重生只对最后一条回复有效", "error");
    return;
  }
  state.isGenerating = true;
  toast("正在重生…", "info");
  try {
    await apiFetch(`conversations/${state.currentConv.id}/regenerate`, {
      method: "POST",
      body: JSON.stringify({ options: { discardOld: true } })
    });
    await openConversation(state.currentConv.id);
  } catch (e) {
    toast("重生失败: " + friendlyError(e), "error");
  } finally {
    state.isGenerating = false;
  }
}

/** 切换这条例行的变体版本（服务端 switchVariant，本地跟着换显示）。 */
async function switchVariant(id, dir) {
  const msg = findMessage(id);
  if (!msg || !Array.isArray(msg.variants) || msg.variants.length < 2) return;
  const cur = Number.isInteger(msg.variantIndex) ? msg.variantIndex : msg.variants.length - 1;
  const next = Math.min(msg.variants.length - 1, Math.max(0, cur + dir));
  if (next === cur) return;
  try {
    await apiFetch(`conversations/${state.currentConv.id}/messages/${encodeURIComponent(String(id))}/variant`, {
      method: "PUT",
      body: JSON.stringify({ index: next })
    });
    msg.variantIndex = next;
    msg.content = msg.variants[next];
    renderMessages();
  } catch (e) {
    toast("切换失败: " + friendlyError(e), "error");
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

/**
 * 把服务端落盘后的那条消息收进内存，然后重画。
 *
 * 为什么必须收进来，不能只“在屏上画个气泡”：
 * 流式路径里那条回复**从来没进过 state.currentConv.messages**——
 * ensureBubble 只建了一个 DOM 节点。后果有两个：
 *   · 重画一次它就消失（我第一版就是这么做，真把回复抹掉了一次）；
 *   · 它没有 data-id，复制/编辑/删除/换一版这些按钮**一个都没有**，
 *     要等下一次整场重载才出现。
 * 服务端在 done 事件里把落盘结果给了我们，收下它就是正解——
 * 顺带把这一轮的变量账和行动候选项一起带回来。
 */
function acceptSavedMessage(saved) {
  if (!saved || typeof saved !== "object" || !state.currentConv) return false;
  const msgs = state.currentConv.messages || (state.currentConv.messages = []);
  const at = msgs.findIndex(m => m.id === saved.id);
  if (at >= 0) msgs[at] = saved;
  else msgs.push(saved);
  return true;
}

/** 正在向模型要方向——防连点。 */
let suggesting = false;

/*
 * Q2（2026-09-29）：每轮自动给方向。
 * 开关存在本地——它是「这台设备的阅读习惯」，不是会话属性。
 * 默认开：AIRP 对照里这是基础体验；想关的人多半会第一时间找开关，
 * 而开关就摆在按钮旁边，一眼能看到。
 */
const AUTO_SUGGEST_KEY = "eleckoi:auto-suggest";
function autoSuggestOn() {
  try { return localStorage.getItem(AUTO_SUGGEST_KEY) !== "0"; } catch { return true; }
}

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
export async function requestSuggestions(opts = {}) {
  const quiet = !!opts.quiet; // 自动触发时静默：失败不该为一次“附带的看”弹 toast
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
      if (!quiet) toast(data?.note ? `没给出可用的方向：${data.note}` : "没给出可用的方向", "error");
    } else if (data?.note && !quiet) {
      toast(data.note, "info");
    }
  } catch (e) {
    if (!quiet) toast("拿方向失败: " + friendlyError(e), "error");
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
  const auto = document.getElementById("suggest-auto");
  if (auto && auto.dataset.bound !== "1") {
    auto.dataset.bound = "1";
    auto.checked = autoSuggestOn();
    auto.addEventListener("change", () => {
      try { localStorage.setItem(AUTO_SUGGEST_KEY, auto.checked ? "1" : "0"); } catch { /* 隐身模式 */ }
    });
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

  if (tEl) {
    const p = state.lastMeta?.pressure || null;
    let s;
    if (prompt != null) s = `上下文 ${fmtK(prompt)}`;
    else if (p?.used) s = `上下文 ${fmtK(p.used)}（估算）`;
    else s = "上下文 —";

    /*
     * 上限只在**真窗口**时才报比例。
     * 拿不到模型真实窗口时 allocateBudget 会拿 8000 兜底，
     * 而用兜底值算出来的百分比是**假读数**——比没有读数更坏
     *（会让人以为还有余量）。那就如实说「上限未知」。
     */
    if (p?.window) {
      s += p.windowReal ? ` / ${fmtK(p.window)} · ${p.pct}%` : " / 上限未知";
    }
    // 折过历史就把条数说出来：压力高的时候这一条比百分比有用
    if (p?.dropped > 0) s += ` · 折叠 ${p.dropped} 条`;

    tEl.textContent = s;
    // 压力警戒：85% 以上不再标绿，往前就该看到「该折叠了」
    tEl.classList.toggle("tight", !!(p?.windowReal && p.used && p.pct >= 85));
  }

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

/** 读数里的大数：1280 → 1.3k。小数字原样，免得「120」被写成「120」。 */
function fmtK(n) {
  const v = Number(n) || 0;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
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
       *
       * 群聊时要把人数带上：只写主角名会让人以为这是一场单人对话——
       * 而屏幕下方正摆着两个可以换的发言者。
       */
      const ids = Array.isArray(state.currentConv.characterIds) ? state.currentConv.characterIds : [];
      const base = state.currentCharacter?.name || state.currentConv.characterName || state.currentConv.title || "（无标题）";
      dom.chatTitle.textContent = ids.length > 1 ? `${base} · 群聊 ${ids.length} 人` : base;
    }
    renderHeaderMeta();
    dom.chatInputArea?.classList.remove("hidden");
    dom.chatActions?.querySelector("#export-chat-btn")?.classList.remove("hidden");
    dom.chatActions?.querySelector("#delete-conv-btn")?.classList.remove("hidden");
    dom.chatInput?.focus();

    // 上一条对话的 usage 摆在新的对话头上是假读数——清掉，等这一场生成时再出数
    state.lastUsage = null;
    renderUsageBar();

    // 换了对话，本场的黑板格也换了。
    // 面板开着要重拉（否则显示的是上一场的格子，私密格尤其不能快照错对象）；
    // **关着也要拉**——顶栏那一行要报「世界 N 格」。
    {
      const { loadBoard } = await import("./board.js");
      await loadBoard();
      // 格子数拉回来了，顶栏那一行才是真的。
      //（上面那次调用发生在拉回来之前，所以这里是必需的，不是重复。）
      renderHeaderMeta();
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
 * 顶栏那一行：品牌之外，这一场的实况。
 *
 * 单独抽出来是因为它有三个时机：开对话时、每轮生成完后、
 * 以及**黑板格拉回来之后**——格子数在那之前还是空的，
 * 先写就会在屏幕上留下一句「世界 0 格」的假读数。
 */
export function renderHeaderMeta() {
  if (!dom.chatMeta) return;
  const conv = state.currentConv;
  if (!conv) { dom.chatMeta.classList.add("hidden"); return; }

  const n = conv.messages?.length || 0;
  const isBond = conv.mode === "bond";
  const parts = [
    isBond
      ? `羁绊${conv.bondStage?.stage ? ` · ${conv.bondStage.stage}` : ""} · ${Math.floor(n / 2)} 段`
      : (n > 0 ? `第 ${Math.ceil(n / 2)} 轮` : "还没开始")
  ];
  // 世界格子数不写在这里了——它成了标题行里那颗**按钮**
  //（既是读数也是黑板列的开关，卡里那一格就是这个用法）。
  dom.chatMeta.textContent = parts.join(" · ");
  dom.chatMeta.classList.remove("hidden");

  // 羁绊场：输入框换成「推进」——玩家不在场，不发言只旁听。
  // 注：第 6 期入口已撤（月曦夜反馈），此分支现只服务已有 bond 对话的读。
  const area = document.getElementById("chat-input-area");
  let bondBtn = document.getElementById("bond-advance-btn");
  if (isBond && area) {
    if (!bondBtn) {
      bondBtn = document.createElement("button");
      bondBtn.id = "bond-advance-btn";
      bondBtn.className = "btn btn-primary";
      bondBtn.type = "button";
      bondBtn.textContent = "推进羻绊";
      bondBtn.addEventListener("click", () => void advanceBond());
      const sendBtn = document.getElementById("send-btn");
      sendBtn?.parentElement?.insertBefore(bondBtn, sendBtn);
    }
    bondBtn.classList.remove("hidden");
    const ta = document.getElementById("chat-input");
    if (ta) ta.disabled = true;
    if (ta) ta.placeholder = "羻绊小剧场——你不在场，点「推进羻绊」生成一段互动";
  } else if (bondBtn) {
    bondBtn.classList.add("hidden");
    const ta = document.getElementById("chat-input");
    if (ta) ta.disabled = false;
  }

  // 那颗按钮：拉得到就报数，拉不到就不出场
  //（写「世界 0 格」会被读成“这一场真的没有格子”）。
  const toggle = document.getElementById("board-toggle");
  const countEl = document.getElementById("board-toggle-n");
  if (toggle) {
    const known = Array.isArray(state.boardChat);
    const cells = (state.boardWorld?.length || 0) + (state.boardChat?.length || 0);
    if (known && countEl) countEl.textContent = String(cells);
    toggle.classList.toggle("hidden", !known);
    toggle.classList.toggle("on", boardColumnOpen());
    toggle.title = boardColumnOpen() ? "收起世界黑板" : "展开世界黑板";
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
