// gen.js — 「AI 生成」生成台（前端）
//
// 三段式：需求 / 过程 / 结果。第三段是审查台。
//
// 两条产品纪律写在这里，不是随口说的：
//   ① **越界内容不进审查列表**（用户明确）：没出处的断言在核对那一步就删了，
//      列表里只列有据可查的东西，只在过程区留一个数字。
//      人的眼睛最贵，不拿来看废弃品。
//   ② **逐条可弃**：世界书条目默认全选、点一下取消。不做"全要或全不要"。
//
// 长任务走提交 + 轮询，不新增宿主能力。

import { apiFetch, toast, escapeHtml, friendlyError } from "./core.js";

const POLL_MS = 1000;
const MAX_POLLS = 240;          // 最多等 4 分钟

let timer = null;
let job = null;                 // 当前任务快照
let busy = false;

const $ = (id) => document.getElementById(id);

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text ?? "";
}

function stopPoll() {
  if (timer) { clearTimeout(timer); timer = null; }
}

// ── 打开 / 关闭 ─────────────────────────────────────────

export function openGen() {
  const modal = $("gen-modal");
  if (!modal) { toast("生成台没装上（缺 #gen-modal）", "error"); return; }
  modal.classList.remove("hidden");
  setText("gen-hint", "");
  const q = $("gen-query");
  q?.focus();
  // 打开就体检：先知道今天哪条来源通，免得上去了才发现白等
  void loadSources();
}

export function closeGen() {
  stopPoll();
  $("gen-modal")?.classList.add("hidden");
}

// ── 来源体检 ────────────────────────────────────────────

async function loadSources() {
  const box = $("gen-sources");
  if (!box) return;
  box.innerHTML = '<span class="gen-src-loading">体检中…</span>';
  try {
    const res = await apiFetch("gen/sources");
    const list = (res.data || res)?.sources || [];
    box.innerHTML = list.map((s) => `
      <span class="gen-src ${s.ok ? "ok" : "bad"}" title="${escapeHtml(s.note || "")}">
        ${s.ok ? "●" : "○"} ${escapeHtml(s.label || s.id)}${s.ok ? ` · ${s.ms}ms` : " · 不通"}
      </span>`).join("");
    const dead = list.filter((s) => !s.ok);
    if (dead.length > 0) {
      const first = dead[0];
      box.innerHTML += `<div class="gen-src-note">${escapeHtml(first.label)}：${escapeHtml(first.note || "不可达")}</div>`;
    }
  } catch (e) {
    box.innerHTML = `<span class="gen-src bad">○ 体检失败：${escapeHtml(friendlyError(e))}</span>`;
  }
}

// ── 提交与轮询 ──────────────────────────────────────────

export async function submitGen() {
  if (busy) return;
  const query = ($("gen-query")?.value || "").trim();
  if (!query) { toast("先说清楚要什么", "error"); return; }

  busy = true;
  job = null;
  const submit = $("gen-submit");
  if (submit) submit.disabled = true;
  $("gen-save")?.classList.add("hidden");
  setText("gen-result", "");
  setText("gen-notes", "");
  setText("gen-hint", "");
  setText("gen-progress", "提交中…");

  try {
    const res = await apiFetch("gen/jobs", {
      method: "POST",
      body: JSON.stringify({
        query,
        docsPerSource: Number($("gen-docs")?.value) || 3,
        makeBook: $("gen-book")?.checked !== false
      })
    });
    const data = res.data || res;
    if (!data?.id) throw new Error("没拿到任务 id");
    setText("gen-progress", "已提交，正在检索…");
    poll(data.id, 0);
  } catch (e) {
    busy = false;
    if (submit) submit.disabled = false;
    setText("gen-progress", "提交失败");
    toast("提交失败: " + friendlyError(e), "error");
  }
}

function poll(id, n) {
  stopPoll();
  timer = setTimeout(async () => {
    try {
      const res = await apiFetch(`gen/jobs/${encodeURIComponent(id)}`);
      const snap = (res.data || res);
      if (!snap) throw new Error("任务快照为空");
      job = snap;
      renderProgress(snap);

      if (snap.state === "running") {
        if (n >= MAX_POLLS) throw new Error("等太久了，先停下");
        poll(id, n + 1);
        return;
      }

      busy = false;
      const submit = $("gen-submit");
      if (submit) submit.disabled = false;

      if (snap.state === "done") renderResult(snap);
      else setText("gen-progress", "失败：" + (snap.error || "未知原因"));
    } catch (e) {
      busy = false;
      const submit = $("gen-submit");
      if (submit) submit.disabled = false;
      setText("gen-progress", "轮询失败：" + friendlyError(e));
    }
  }, POLL_MS);
}

// ── 渲染：过程 ──────────────────────────────────────────

const PHASE_LABEL = {
  searching: "检索中",
  extracting: "抽取事实",
  composing: "组装卡与世界书",
  verifying: "核对出处",
  done: "完成",
  failed: "失败"
};

function renderProgress(snap) {
  setText("gen-progress", `${PHASE_LABEL[snap.phase] || snap.phase} · ${snap.detail || ""}`);
  const notes = Array.isArray(snap.notes) ? snap.notes : [];
  if (notes.length === 0) return;
  $("gen-notes").innerHTML = notes.map((n) => `
    <div class="gen-note ${n.ok ? "" : "bad"}">
      ${n.ok ? "✓" : "✕"} ${escapeHtml(n.label || n.source)}
      ${n.ok ? `取了 ${n.count ?? 0} 份` : escapeHtml(n.note || "失败")}
    </div>`).join("");
}

// ── 渲染：结果（审查台）─────────────────────────────────

function renderResult(snap) {
  const r = snap.result || {};
  const card = r.card || {};
  const entries = (r.book?.entries || []).map((e, i) => ({ ...e, _i: i }));
  const facts = Array.isArray(r.facts) ? r.facts : [];
  const dropped = r.dropped || {};

  // 越界内容不进审查列表，只报个数
  const droppedBits = [];
  if (dropped.facts) droppedBits.push(`丢弃 ${dropped.facts} 条没出处的事实`);
  if (dropped.entries) droppedBits.push(`丢弃 ${dropped.entries} 条空条目`);
  if (dropped.sentences) droppedBits.push(`删除 ${dropped.sentences} 句无出处内容`);
  setText("gen-hint", droppedBits.length ? droppedBits.join(" · ") : "");

  const factsHtml = facts.map((f) => `
    <div class="gen-fact">
      <div class="gen-fact-t">${escapeHtml(f.fact)}</div>
      <a class="gen-src-link" href="${escapeHtml(f.source?.url || "#")}" target="_blank" rel="noreferrer">
        ${escapeHtml((f.source?.url || "").replace(/^https?:\/\//, "").slice(0, 46))}
      </a>
    </div>`).join("");

  const entriesHtml = entries.map((e) => `
    <label class="gen-entry">
      <input type="checkbox" class="gen-entry-ck" data-i="${e._i}" checked>
      <span class="gen-entry-b">
        <span class="gen-keys">${e.keys.map((k) => `<i>${escapeHtml(k)}</i>`).join("")}</span>
        <span class="gen-entry-c" contenteditable="true" data-i="${e._i}">${escapeHtml(e.content)}</span>
      </span>
    </label>`).join("");

  $("gen-result").innerHTML = `
    <div class="gen-card">
      <div class="gen-card-name">${escapeHtml(card.name || "（没有名字）")}</div>
      <div class="gen-card-desc">${escapeHtml(card.description || "")}</div>
      <div class="gen-card-line"><b>开场白</b>${escapeHtml(card.first_mes || "（没有）")}</div>
      ${card.personality ? `<div class="gen-card-line"><b>性格</b>${escapeHtml(card.personality)}</div>` : ""}
      ${card.scenario ? `<div class="gen-card-line"><b>场景</b>${escapeHtml(card.scenario)}</div>` : ""}
      ${(card.tags || []).length ? `<div class="gen-card-tags">${card.tags.map((t) => `<i>${escapeHtml(t)}</i>`).join("")}</div>` : ""}
    </div>
    ${entries.length ? `<div class="gen-sub">世界书条目（点一下取消）</div>${entriesHtml}` : ""}
    ${facts.length ? `<div class="gen-sub">用到的资料</div>${factsHtml}` : ""}
  `;

  $("gen-save")?.classList.remove("hidden");
  $("gen-submit")?.classList.add("hidden");
}

// ── 落库 ────────────────────────────────────────────────

export async function saveGen() {
  if (!job || job.state !== "done") { toast("还没有可保存的结果", "error"); return; }
  const card = { ...(job.result?.card || {}) };

  // 只带勾上的条目；改过的正文以页面上的为准
  const checked = new Set(
    [...document.querySelectorAll(".gen-entry-ck")]
      .filter((el) => el.checked)
      .map((el) => Number(el.dataset.i))
  );
  const entries = (job.result?.book?.entries || [])
    .map((e, i) => {
      if (!checked.has(i)) return null;
      const edited = document.querySelector(`.gen-entry-c[data-i="${i}"]`)?.textContent;
      return { keys: e.keys, content: (edited ?? e.content).trim(), position: e.position || "before_char" };
    })
    .filter((e) => e && e.content);

  if (!card.name) { toast("卡没有名字，先补一个再存", "error"); return; }

  try {
    if (entries.length > 0) card.character_book = { entries };
    const made = await apiFetch("characters", { method: "POST", body: JSON.stringify({ card }) });
    const saved = made.data || made;
    if (!saved?.id) throw new Error("建卡没拿到 id");

    if (entries.length > 0) {
      // 走现成那条：把卡内世界书写进设定库（replace=true，重导不堆重复）
      await apiFetch(`characters/${encodeURIComponent(saved.id)}/import-book`, {
        method: "POST",
        body: JSON.stringify({ replace: true })
      });
    }

    toast(`已写入卡库：${saved.name || card.name}${entries.length ? `（世界书 ${entries.length} 条）` : ""}`, "success");
    closeGen();
    const { loadCharacters } = await import("./characters.js");
    await loadCharacters();
  } catch (e) {
    toast("保存失败: " + friendlyError(e), "error");
  }
}

export function discardGen() {
  stopPoll();
  job = null;
  busy = false;
  setText("gen-result", "");
  setText("gen-notes", "");
  setText("gen-hint", "");
  setText("gen-progress", "已丢掉，可以重新开始");
  $("gen-save")?.classList.add("hidden");
  $("gen-submit")?.classList.remove("hidden");
  const submit = $("gen-submit");
  if (submit) submit.disabled = false;
}

/** 主视图收到左栏的 gen-open 时调用。 */
export function bindGen() {
  $("gen-close")?.addEventListener("click", closeGen);
  $("gen-submit")?.addEventListener("click", () => void submitGen());
  $("gen-save")?.addEventListener("click", () => void saveGen());
  $("gen-discard")?.addEventListener("click", discardGen);
  $("gen-modal")?.addEventListener("click", (e) => {
    if (e.target === $("gen-modal")) closeGen();
  });
}
