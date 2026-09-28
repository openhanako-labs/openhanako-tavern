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

import { apiFetch, toast, escapeHtml, friendlyError, confirmDialog } from "./core.js";

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

// ── 三阶段切换 ────────────────────────────────────
//
// 之前三个阶段同时常驻（没跑就能看到两个空段），现在改成按状态推进：
//   idle：只给那一个问题（大输入 + 示例 + 参数）
//   running：进度条 + 分步日志，其他阶段让位
//   done：结果占屏（按“一张卡的样子”展示），需求区与进度区隐去
//
// 为什么不删 DOM：三个阶段各自绑定了自己的控件（gen-query / gen-notes /
// gen-result……），删了就回不来了。用 hidden 切换既保留了控件，又只把
// 当前阶段摆在用户面前。
const PHASE = {
  idle: "gen-phase-idle",
  running: "gen-phase-running",
  done: "gen-phase-done"
};

function setPhase(phase) {
  for (const p of Object.values(PHASE)) $(p)?.classList.add("hidden");
  $(PHASE[phase])?.classList.remove("hidden");

  // 页脚按钮按阶段切：
  //   idle：开始生成（主）
  //   running：隐藏开始（避免重复提交），保留丢掉（取消）
  //   done：隐藏开始，显示“再来一次”与“写进角色库”（主）
  const submit = $("gen-submit");
  const retry = $("gen-retry");
  const save = $("gen-save");
  submit?.classList.toggle("hidden", phase !== "idle");
  retry?.classList.toggle("hidden", phase !== "done");
  save?.classList.toggle("hidden", phase !== "done");
}

// ── 打开 / 关闭 ─────────────────────────────────────────

export function openGen() {
  const modal = $("gen-modal");
  if (!modal) { toast("生成台没装上（缺 #gen-modal）", "error"); return; }
  modal.classList.remove("hidden");
  setPhase("idle");
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

// 体检条提到最上、形式与语音/出图/场景一致：● + 一句人话 + 一句细节 + 一个「重测」。
// 之前那一排小圆点堆在页面底部「每个来源取几份材料」旁边——它回答的是“能不能用”，
// 属于“能不能开始”级别的信息，不是参数级别的，不该跟参数抢位置。
async function loadSources() {
  const box = $("gen-sources");
  if (!box) return;
  box.innerHTML = `
    <span class="mh-dot"></span>
    <div class="mh-text">
      <div class="mh-title">体检中</div>
      <div class="mh-sub">向服务器要一份来源探活报告……</div>
    </div>`;
  try {
    const res = await apiFetch("gen/sources");
    const list = (res.data || res)?.sources || [];
    const okCount = list.filter((s) => s.ok).length;
    const dead = list.filter((s) => !s.ok);
    const allOk = dead.length === 0;
    const noneOk = okCount === 0;

    // 状态开关与现有 .modal-health 对齐：默认未体检、全通过 → .is-ok，有失败 → .is-bad
    box.classList.toggle("is-ok", !allOk === false && !noneOk);
    box.classList.toggle("is-bad", noneOk);

    // 一句人话：能 / 部分能 / 全不通；一句细节：具体到哪几条 + 大概多少 ms
    const t1 = noneOk ? "都通不了" : (allOk ? "都能用" : `通 ${okCount}/${list.length} 条`);
    const t2 = list.length
      ? list.map((s) => `${s.ok ? "●" : "○"} ${s.label || s.id}${s.ok ? ` · ${s.ms}ms` : " · 不通"}`).join("　")
      : "没拿到来源列表";
    box.innerHTML = `
      <span class="mh-dot"></span>
      <div class="mh-text">
        <div class="mh-title">${escapeHtml(t1)}</div>
        <div class="mh-sub">${escapeHtml(t2)}</div>
      </div>
      <div class="mh-act">
        <button type="button" id="gen-retest" class="btn btn-sm">重测</button>
      </div>`;
    // 重绑「重测」：innerHTML 重绘后旧 button 没了，得重新抓
    $("gen-retest")?.addEventListener("click", () => void loadSources());
  } catch (e) {
    box.classList.add("is-bad");
    box.innerHTML = `
      <span class="mh-dot"></span>
      <div class="mh-text">
        <div class="mh-title">体检失败</div>
        <div class="mh-sub">${escapeHtml(friendlyError(e))}</div>
      </div>
      <div class="mh-act">
        <button type="button" id="gen-retest" class="btn btn-sm">重测</button>
      </div>`;
    $("gen-retest")?.addEventListener("click", () => void loadSources());
  }
}

// ── 提交与轮询 ──────────────────────────────────────────

export async function submitGen() {
  if (busy) return;
  const query = ($("gen-query")?.value || "").trim();
  if (!query) { toast("先说清楚要什么", "error"); return; }

  busy = true;
  job = null;
  setPhase("running");
  const submit = $("gen-submit");
  if (submit) submit.disabled = true;
  setText("gen-result", "");
  setText("gen-hint", "");
  const gnEl = $("gen-notes");
  if (gnEl) gnEl.innerHTML = "";
  setProgress({ title: "提交中…", sub: "服务端接到任务，开始拉取参考素材。" });

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
    setProgress({ title: "已提交", sub: "等待第一个进度信号……" });
    poll(data.id, 0);
  } catch (e) {
    busy = false;
    if (submit) submit.disabled = false;
    setPhase("idle");
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
      renderJobSnapshot(snap);

      if (snap.state === "running") {
        if (n >= MAX_POLLS) throw new Error("等太久了，先停下");
        poll(id, n + 1);
        return;
      }

      busy = false;
      const submit = $("gen-submit");
      if (submit) submit.disabled = false;

      if (snap.state === "done") renderResult(snap);
      else {
        setPhase("idle");
        toast("生成失败：" + (snap.error || "未知原因"), "error");
      }
    } catch (e) {
      busy = false;
      const submit = $("gen-submit");
      if (submit) submit.disabled = false;
      setPhase("idle");
      toast("轮询失败：" + friendlyError(e), "error");
    }
  }, POLL_MS);
}

// ── 渲染：过程（进度条 + 分步日志）─────────────────────

const PHASE_LABEL = {
  searching: "检索参考素材",
  extracting: "抽取事实",
  composing: "组装卡与世界书",
  verifying: "核对出处",
  done: "完成",
  failed: "失败"
};

const PHASE_STEP = {
  searching: 1,
  extracting: 2,
  composing: 3,
  verifying: 4,
  done: 5
};

// 进度条只报当前那一步，分步日志列完每一步。
// 一次要跑几十秒的生成，最难受的不是等，是不知道在等什么。
// 所以日志里每一步都要有：它做了什么、花了多久。
function setProgress({ title, sub, step, total, eta }) {
  const t1 = $("gen-prog-title");
  const t2 = $("gen-prog-sub");
  const etaEl = $("gen-prog-eta");
  if (t1) t1.textContent = title || "";
  if (t2) t2.textContent = sub || "";
  if (etaEl) etaEl.textContent = eta || "";
  const fill = $("gen-prog-fill");
  if (fill) {
    const pct = total ? Math.min(100, Math.round((step / total) * 100)) : 0;
    fill.style.width = pct + "%";
  }
}

function renderProgress(snap) {
  const step = PHASE_STEP[snap.phase] || 0;
  const title = PHASE_LABEL[snap.phase] || snap.phase;
  const sub = snap.detail || "";
  setProgress({ title, sub, step, total: 5, eta: "约 30 秒" });

  const notes = Array.isArray(snap.notes) ? snap.notes : [];
  if (notes.length === 0) {
    const gnEl = $("gen-notes");
  if (gnEl) gnEl.innerHTML = "";
    return;
  }
  $("gen-notes").innerHTML = notes.map((n) => {
    const done = !!n.ok;
    // 时长字段：后端可能给 ms / duration / took_ms，都接一下；拿不到就写……
    const ms = n.ms ?? n.duration ?? n.took_ms;
    const msText = typeof ms === "number" ? (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`) : "……";
    return `
      <div class="glr ${done ? "done" : "bad"}">
        <span class="glr-dot"></span>
        <span class="glr-tx">${escapeHtml(n.label || n.source)}${n.ok ? (n.count != null ? ` · 取了 ${n.count} 份` : "") : escapeHtml(n.note || "失败")}</span>
        <span class="glr-ms">${msText}</span>
      </div>`;
  }).join("");
}

// ── 渲染：结果（审查台）─────────────────────────────────

/**
 * 把一份任务快照渲染进结果区。
 *
 * 导出是为了探针（tools/flows/gen.js）能喂一份**假快照**验渲染——
 * 真跑一次要模型与出网，那不是验 DOM 该付的代价。
 * 这也是为什么它收快照而不是自己去取：取数是轮询的事，渲染是纯的。
 */
export function renderJobSnapshot(snap) {
  renderProgress(snap);
  if (snap?.state === "done") renderResult(snap);
}

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

  // 世界书条目：卡片里列出名字与一句内容，默认全选、点一下可取消。
  // 不再把整块 JSON 抛回去——用户要做的是“判断像不像”，不是“解析 JSON”。
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
    ${entries.length ? `<div class="gen-sub">顺带生成的世界书 · ${entries.length} 条（点一下取消）</div>${entriesHtml}` : ""}
    ${facts.length ? `<div class="gen-sub">用到的资料</div>${factsHtml}` : ""}
  `;

  // 阶段推进到 done：需求与进度都让位，结果占屏
  setPhase("done");
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
      // name 必须带上：设定库按 name::characterId 去重，没名字的条目会在那儿被吞掉
      return { name: e.name || e.keys?.[0] || "", keys: e.keys, content: (edited ?? e.content).trim(), position: e.position || "before_char" };
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

    toast(`已写入角色卡：${saved.name || card.name}${entries.length ? `（世界书 ${entries.length} 条）` : ""}`, "success");
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
  setPhase("idle");
  const submit = $("gen-submit");
  if (submit) submit.disabled = false;
}

/** 丢掉之前先问一句：误触一次的成本是再等几分钟重新生成。 */
export async function discardGenConfirmed() {
  const yes = await confirmDialog({
    title: "丢掉这次生成的结果？",
    body: "没写进卡库的部分会没，下次得重新跑一遍。"
  });
  if (!yes) return false;
  discardGen();
  return true;
}

/** 再来一次：重用上次那句 query，直接重提。 */
export async function retryGen() {
  if (busy) return;
  // 回到 idle 相后，输入框还在，query 保留不变；直接 submit 就重新跑一遍
  discardGen();
  const q = $("gen-query");
  if (q) q.focus();
}

/** 主视图收到左栏的 gen-open 时调用。 */
export function bindGen() {
  $("gen-close")?.addEventListener("click", closeGen);
  $("gen-submit")?.addEventListener("click", () => void submitGen());
  $("gen-save")?.addEventListener("click", () => void saveGen());
  $("gen-discard")?.addEventListener("click", () => { void discardGenConfirmed(); });
  $("gen-retry")?.addEventListener("click", () => void retryGen());
  // 示例：点一下就填进 query 框，不直接提交——用户可能还想改几个字。
  $("gen-phase-idle")?.querySelectorAll(".bigq-examples b").forEach(b => {
    b.addEventListener("click", () => {
      const q = $("gen-query");
      if (q) { q.value = b.textContent.trim(); q.focus(); }
    });
  });
  $("gen-modal")?.addEventListener("click", (e) => {
    if (e.target === $("gen-modal")) closeGen();
  });
}
