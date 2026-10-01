// ui/assets/modules/battle.js — 战斗面板（第 8 期）
//
// 入口：聊天区 ⋯ 菜单「遭遇战」（有对话时）。
// 面板：HP 条 + 行动按钮（普攻/技能/撤退）+ 战斗日志。
// 胜负后后端自动把结果注入对话，前端提示去气泡看战后剧情。

import { apiFetch, unwrap, escapeHtml, toast, friendlyError } from "./core.js";
import { state } from "./state.js";

let bound = false;
function el(id) { return document.getElementById(id); }

// 日志 side 的合法值。既是防御（未知 side 回退 player），
// 也让 CSS 动态类 player/enemy 的字面量出现在源码里（check-css-wiring 反向守门）。
const LOG_SIDES = ["player", "enemy"];

function hpBar(label, cur, max) {
  const pct = Math.max(0, Math.min(100, (cur / (max || 1)) * 100));
  const cls = pct > 50 ? "up" : pct > 20 ? "mid" : "down";
  return `<div class="battle-hp">
    <span class="battle-hp-label">${escapeHtml(label)}</span>
    <div class="battle-hp-bar"><div class="battle-hp-fill ${cls}" style="width:${pct}%"></div></div>
    <span class="battle-hp-num">${cur} / ${max}</span>
  </div>`;
}

function renderPanel(battle) {
  const box = el("battle-body");
  if (!box) return;
  if (!battle || battle.status === "none") {
    box.innerHTML = `<div class="hint" style="padding:10px">没有进行中的战斗。输入敌人描述（留空 = 随机）发起遭遇。</div>`;
    return;
  }
  const active = battle.status === "active";
  const skills = Array.isArray(battle.player?.skills) ? battle.player.skills : [];
  const maxP = Number(battle.player.attrs?.["体力"] ?? 100) || 100;
  const maxE = Number(battle.enemy.attrs?.["体力"] ?? battle.enemy.attrs?.["生命"] ?? 100) || 100;

  box.innerHTML = `
    ${battle.preStory ? `<div class="battle-story">${escapeHtml(battle.preStory)}</div>` : ""}
    ${battle.status === "won" ? `<div class="battle-result win">胜利</div>` : ""}
    ${battle.status === "lost" ? `<div class="battle-result lose">败北</div>` : ""}
    ${battle.status === "fled" ? `<div class="battle-result">撤退成功</div>` : ""}
    ${hpBar(`你 · ${battle.player.name}`, battle.player.hp, maxP)}
    ${hpBar(`${battle.enemy.name}`, battle.enemyHp, maxE)}
    <div class="battle-acts">
      ${active ? `<button class="btn btn-primary btn-sm" data-b="attack">攻击</button>` : ""}
      ${active ? skills.map(s => `<button class="btn btn-sm" data-b="skill" data-name="${escapeHtml(s.name)}" title="${escapeHtml(s.formula)}${s.cost ? `（${escapeHtml(s.cost)}）` : ""}">${escapeHtml(s.name)}</button>`).join("") : ""}
      ${active ? `<button class="btn btn-sm" data-b="flee">撤退</button>` : ""}
      ${!active ? `<button class="btn btn-sm" data-b="close">收工——回对话看剧情</button>` : ""}
    </div>
    <div class="battle-log">
      ${(battle.log || []).slice(-10).map(l => `<div class="battle-log-line ${LOG_SIDES.includes(l.side) ? l.side : "player"}">T${l.turn} ${escapeHtml(l.text)}</div>`).join("")}
    </div>`;

  box.querySelectorAll("[data-b]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const kind = btn.dataset.b;
      if (kind === "close") { el("battle-modal")?.classList.add("hidden"); return; }
      if (!state.currentConv) return;
      const body = kind === "skill" ? { kind, name: btn.dataset.name } : { kind };
      try {
        const env = await apiFetch(`conversations/${state.currentConv.id}/battle/action`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
        });
        const d = unwrap(env) || {};
        renderPanel(d.battle);
        if (d.battle?.status === "won" || d.battle?.status === "lost") {
          toast("战斗结束——战后剧情已注入对话", "success");
          const chat = await import("./chat.js");
          await chat.openConversation(state.currentConv.id);
        }
      } catch (e) {
        toast(`行动失败：${friendlyError(e)}`, "error");
      }
    });
  });
}

async function encounter() {
  const conv = state.currentConv;
  if (!conv) { toast("先打开一场对话", "error"); return; }
  const enemyDesc = prompt("遭遇什么敌人？（描述一下，留空 = 随机）") ?? "";
  const btn = el("battle-encounter-btn");
  if (btn) { btn.disabled = true; btn.textContent = "遭遇中…"; }
  try {
    const env = await apiFetch(`conversations/${encodeURIComponent(conv.id)}/battle/encounter`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enemyDesc: enemyDesc.trim() || undefined })
    });
    const d = unwrap(env) || {};
    el("battle-modal")?.classList.remove("hidden");
    renderPanel(d.battle);
    // 敌人配图（异步生成的）：media 台账的 id 拉字节填进面板顶部
    if (d.enemyImage) {
      try {
        const env2 = await apiFetch(`media/${encodeURIComponent(d.enemyImage)}`);
        const m = unwrap(env2) || {};
        const b64 = m.base64 || m.bytes;
        if (typeof b64 === "string" && b64) {
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i2 = 0; i2 < bin.length; i2++) bytes[i2] = bin.charCodeAt(i2);
          const url = URL.createObjectURL(new Blob([bytes], { type: m.mime || "image/png" }));
          const box = el("battle-body");
          if (box) {
            const img = document.createElement("img");
            img.src = url;
            img.className = "battle-enemy-img";
            box.prepend(img);
          }
        }
      } catch { /* 图拿不到就不展示，不挡战斗 */ }
    }
  } catch (e) {
    toast(`遭遇失败：${friendlyError(e)}`, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "遭遇战"; }
  }
}

/** 绑定（main.js 调一次）。幂等。 */
export function bindBattle() {
  if (bound) return;
  bound = true;

  el("battle-open")?.addEventListener("click", async () => {
    if (!state.currentConv) { toast("先打开一场对话", "error"); return; }
    el("battle-modal")?.classList.remove("hidden");
    renderPanel({ status: "none" });
    // 有进行中的战斗就拉回来
    try {
      const env = await apiFetch(`conversations/${encodeURIComponent(state.currentConv.id)}/battle`);
      const d = unwrap(env) || {};
      if (d.battle && d.battle.status === "active") renderPanel(d.battle);
    } catch { /* ignore */ }
  });
  el("battle-close")?.addEventListener("click", () => el("battle-modal")?.classList.add("hidden"));
  el("battle-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "battle-modal") el("battle-modal")?.classList.add("hidden");
  });
  el("battle-encounter-btn")?.addEventListener("click", () => void encounter());
}

export default { bindBattle };
