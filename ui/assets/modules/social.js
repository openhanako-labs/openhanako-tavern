// ui/assets/modules/social.js — 朋友圈 UI（第 7 期，最简形态）
//
// 档案面板「朋友圈」按钮 → 打开浮层：动态列表（新的在前）+ 发一条 +
// 点赞 + 评论（玩家评论后 AI 以角色口吻回一句）。
// 后端默认关（social.json enabled=false）：开关在浮层顶部，开了才能发。

import { apiFetch, unwrap, escapeHtml, toast, friendlyError } from "./core.js";
import { state } from "./state.js";

let bound = false;

function el(id) { return document.getElementById(id); }

/** 渲染动态列表。 */
async function renderFeed() {
  const listEl = el("social-feed-list");
  if (!listEl) return;
  try {
    const env = await apiFetch("social/feed");
    const d = unwrap(env) || {};
    const posts = Array.isArray(d.posts) ? d.posts : [];
    if (posts.length === 0) {
      listEl.innerHTML = `<div class="hint" style="padding:12px">还没有动态——点上面「让 ${currentName()} 发一条」试试。</div>`;
      return;
    }
    listEl.innerHTML = posts.map(p => `
      <div class="social-post" data-id="${escapeHtml(p.id)}">
        <div class="social-post-hd">
          <b>${escapeHtml(p.characterName || "角色")}</b>
          <span class="social-post-at">${escapeHtml(fmt(p.at))}</span>
        </div>
        <div class="social-post-text">${escapeHtml(p.text)}</div>
        <div class="social-post-acts">
          <button class="mini" data-act="like" data-id="${escapeHtml(p.id)}">👍 ${p.likes?.length || 0}</button>
          <button class="mini" data-act="comment" data-id="${escapeHtml(p.id)}">评论</button>
          <button class="mini" data-act="del" data-id="${escapeHtml(p.id)}">删</button>
        </div>
        ${(p.comments || []).length ? `<div class="social-comments">${p.comments.map(c =>
          `<div class="social-comment${c.isCharacter ? " is-char" : ""}"><b>${escapeHtml(c.by)}</b> ${escapeHtml(c.text)}</div>`
        ).join("")}</div>` : ""}
      </div>
    `).join("");

    listEl.querySelectorAll("[data-act]").forEach(btn => {
      btn.addEventListener("click", () => void onAct(btn.dataset.act, btn.dataset.id));
    });
  } catch (e) {
    listEl.innerHTML = `<div class="hint" style="padding:12px">${escapeHtml(friendlyError(e))}</div>`;
  }
}

function currentName() {
  const c = state.currentCharacter;
  const p = state.pickerCharacterId;
  return c?.name || p || "她";
}

function fmt(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

async function onAct(act, id) {
  try {
    if (act === "like") {
      await apiFetch(`social/feed/${encodeURIComponent(id)}/like`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({})
      });
    } else if (act === "del") {
      await apiFetch(`social/feed/${encodeURIComponent(id)}`, { method: "DELETE" });
    } else if (act === "comment") {
      const text = prompt("评论一句：");
      if (!text) return;
      toast("角色在想怎么回…", "info");
      await apiFetch(`social/feed/${encodeURIComponent(id)}/comment`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text })
      });
    }
    await renderFeed();
  } catch (e) {
    toast(`失败：${friendlyError(e)}`, "error");
  }
}

/** 绑定（main.js 调一次）。幂等。 */
export function bindSocial() {
  if (bound) return;
  bound = true;

  el("social-open")?.addEventListener("click", async () => {
    el("social-modal")?.classList.remove("hidden");
    // 回填开关状态
    try {
      const cfg = unwrap(await apiFetch("social/config")) || {};
      const cb = el("social-enabled");
      if (cb) cb.checked = cfg.enabled === true;
    } catch { /* ignore */ }
    await renderFeed();
  });
  el("social-close")?.addEventListener("click", () => el("social-modal")?.classList.add("hidden"));
  el("social-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "social-modal") el("social-modal")?.classList.add("hidden");
  });

  el("social-enabled")?.addEventListener("change", async (e) => {
    try {
      await apiFetch("social/config", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: e.target.checked })
      });
      toast(e.target.checked ? "虚拟社交已开启" : "虚拟社交已关闭", "success");
    } catch (err) {
      toast(`没存下：${friendlyError(err)}`, "error");
    }
  });

  el("social-post-btn")?.addEventListener("click", async () => {
    const btn = el("social-post-btn");
    // 选角色发（choiceDialog 列出所有卡，不依赖当前面板选中）
    let cid = state.currentCharacter?.id || state.pickerCharacterId;
    if (!cid) {
      try {
        const all = unwrap(await apiFetch("characters")) || [];
        if (!all.length) { toast("还没有角色卡", "error"); return; }
        const { choiceDialog } = await import("./core.js");
        cid = await choiceDialog({
          title: "谁发这条动态？",
          options: all.map(x => ({ value: String(x.id), label: x.name || "（未命名）" }))
        });
      } catch (e) { toast(`拉角色失败：${friendlyError(e)}`, "error"); return; }
    }
    if (!cid) return;
    if (btn) { btn.disabled = true; btn.textContent = "在想…"; }
    try {
      await apiFetch("social/feed/post", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterId: cid })
      });
      await renderFeed();
    } catch (e) {
      toast(`发失败：${friendlyError(e)}`, "error");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "让 TA 发一条"; }
    }
  });

  // 主动单聊：给当前对话的角色发一条主动消息
  el("social-proactive-btn")?.addEventListener("click", async () => {
    const conv = state.currentConv;
    if (!conv) { toast("先打开一场对话", "error"); return; }
    const btn = el("social-proactive-btn");
    if (btn) { btn.disabled = true; btn.textContent = "在写…"; }
    try {
      await apiFetch(`conversations/${encodeURIComponent(conv.id)}/proactive`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({})
      });
      toast("TA 给你发来一条消息——去对话里看", "success");
      const chat = await import("./chat.js");
      await chat.openConversation(conv.id);
    } catch (e) {
      toast(`失败：${friendlyError(e)}`, "error");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "让 TA 主动发消息"; }
    }
  });
}
