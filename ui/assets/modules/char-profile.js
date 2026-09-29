// char-profile.js — C3 二期 · 角色档案（八区块只读展示）
//
// 数据来源：当前对话的 primary 角色 + extensions.profile + codex 引用。
// 只读：面板不提供写入口。八区块按推断实现（原图未校准），
// 版面标注「待校准」——提供写入口等于提前定形，等原图到位再放开。
//
// 八区块（顺序按推断）：
//   ① 身份  ② 基础资料  ③ 标签  ④ 简介
//   ⑤ 职业与专精  ⑥ 势力身份  ⑦ 力量体系  ⑧ 装备与圣物

import { state } from "./state.js";
import { apiFetch, escapeHtml, toast, friendlyError } from "./core.js";

const $ = (id) => document.getElementById(id);

/** 从带前缀 id 前缀反查实体名（用于势力名字显示）。 */
function nameOfRef(id, refs) {
  if (!id) return "—";
  for (const arr of refs) {
    const hit = (arr || []).find(x => x.id === id);
    if (hit) return hit.name || id;
  }
  // 未命中：原样显示（可能是尚未同步的引用）
  return id;
}

export async function loadCharProfile() {
  const card = state.currentCharacter;
  if (!card) {
    toast("当前对话没有主角卡", "error");
    return;
  }
  try {
    // 拉一次档案（后端会 fallback 到 extensions.profile，缺失字段回默认）
    const res = await apiFetch(`characters/${encodeURIComponent(card.id)}/profile`);
    const profile = res.data || res || {};

    // 拉 codex 引用：势力名 + 该人物绑定的力量
    const persons = (await apiFetch("codex/persons")).data?.merged || [];
    const factions = (await apiFetch("codex/factions")).data?.merged || [];
    const powers = (await apiFetch("codex/powers")).data?.merged || [];

    const myPowers = powers.filter(p => p.personId === card.id);

    const body = $("char-profile-body");
    if (!body) return;

    const gearHtml = (profile.gear || []).length
      ? (profile.gear).map(g =>
          `<div class="char-profile-item"><div class="char-profile-item-name">${escapeHtml(g.name || "（未命名）")}</div>${g.type ? `<div class="char-profile-item-type">${escapeHtml(g.type)}</div>` : ""}${g.note ? `<div class="char-profile-item-note">${escapeHtml(g.note)}</div>` : ""}</div>`
        ).join("")
      : `<div class="char-profile-empty">—</div>`;

    const axes = profile.abilityAxes || [];
    const axesHtml = axes.length
      ? axes.map(a => {
          const v = (a.value === null || a.value === undefined) ? "—" : String(a.value);
          const m = (a.max === null || a.max === undefined) ? "—" : String(a.max);
          const missing = (a.value === null || a.value === undefined);
          return `<div class="char-profile-axis" data-missing="${missing ? 1 : 0}">
            <span class="char-profile-axis-name">${escapeHtml(a.name || "（未命名）")}</span>
            <span class="char-profile-axis-val">${escapeHtml(v)}</span>
            <span class="char-profile-axis-max">/ ${escapeHtml(m)}</span>
          </div>`;
        }).join("")
      : `<div class="char-profile-empty">—</div>`;

    // 力量体系：codex powers（按 system 分组）
    const systems = new Map();
    for (const p of myPowers) {
      const key = p.system || "（未命名）";
      if (!systems.has(key)) systems.set(key, []);
      systems.get(key).push(p);
    }
    const systemHtml = systems.size
      ? [...systems.entries()].map(([sys, arr]) => `
        <div class="char-profile-system">
          <div class="char-profile-system-hd">${escapeHtml(sys)}</div>
          ${arr.map(p => `
            <div class="char-profile-system-axis">
              <span>${escapeHtml(p.axis || "（未定轴）")}</span>
              <span>${(p.value === null || p.value === undefined) ? "—" : p.value}</span>
              <span>/ ${(p.max === null || p.max === undefined) ? "—" : p.max}</span>
            </div>`).join("")}
        </div>`).join("")
      : `<div class="char-profile-empty">—</div>`;

    body.innerHTML = `
      <div class="char-profile-wrap">
        <div class="char-profile-hd">
          <div class="char-profile-name">${escapeHtml(card.name || "（未命名）")}</div>
          <div class="char-profile-ver">v ${escapeHtml(card.character_version || "1.0")} · by ${escapeHtml(card.creator || "—")}</div>
        </div>

        <section class="char-profile-sec">
          <div class="char-profile-sec-hd"><span class="char-profile-sec-idx">①</span>身份</div>
          <div class="char-profile-sec-body">
            <div class="char-profile-row"><span class="char-profile-k">名字</span><span class="char-profile-v">${escapeHtml(card.name || "—")}</span></div>
            <div class="char-profile-row"><span class="char-profile-k">卡 id</span><span class="char-profile-v mono">${escapeHtml(String(card.id || "—").slice(0, 16))}</span></div>
          </div>
        </section>

        <section class="char-profile-sec">
          <div class="char-profile-sec-hd"><span class="char-profile-sec-idx">②</span>基础资料</div>
          <div class="char-profile-sec-body">
            <div class="char-profile-row"><span class="char-profile-k">年龄</span><span class="char-profile-v">${escapeHtml(profile.age || "—")}</span></div>
            <div class="char-profile-row"><span class="char-profile-k">性别</span><span class="char-profile-v">${escapeHtml(profile.gender || "—")}</span></div>
            <div class="char-profile-row"><span class="char-profile-k">种族</span><span class="char-profile-v">${escapeHtml(profile.race || "—")}</span></div>
            <div class="char-profile-row"><span class="char-profile-k">身高</span><span class="char-profile-v">${escapeHtml(profile.height || "—")}</span></div>
          </div>
        </section>

        <section class="char-profile-sec">
          <div class="char-profile-sec-hd"><span class="char-profile-sec-idx">③</span>标签</div>
          <div class="char-profile-sec-body">
            ${card.tags?.length
              ? `<div class="char-profile-tags">${card.tags.map(t => `<span class="char-profile-tag">${escapeHtml(t)}</span>`).join("")}</div>`
              : `<div class="char-profile-empty">—</div>`}
          </div>
        </section>

        <section class="char-profile-sec">
          <div class="char-profile-sec-hd"><span class="char-profile-sec-idx">④</span>简介</div>
          <div class="char-profile-sec-body">
            <div class="char-profile-desc">${card.description ? escapeHtml(card.description).replace(/\n/g, "<br>") : '<span class="char-profile-empty">—</span>'}</div>
            ${profile.bio ? `<div class="char-profile-desc char-profile-desc-bio">${escapeHtml(profile.bio).replace(/\n/g, "<br>")}</div>` : ""}
          </div>
        </section>

        <section class="char-profile-sec">
          <div class="char-profile-sec-hd"><span class="char-profile-sec-idx">⑤</span>职业与专精</div>
          <div class="char-profile-sec-body">
            <div class="char-profile-row"><span class="char-profile-k">职业</span><span class="char-profile-v">${escapeHtml(profile.profession || "—")}</span></div>
            <div class="char-profile-row"><span class="char-profile-k">专精</span><span class="char-profile-v">${escapeHtml(profile.specialty || "—")}</span></div>
          </div>
        </section>

        <section class="char-profile-sec">
          <div class="char-profile-sec-hd"><span class="char-profile-sec-idx">⑥</span>势力身份</div>
          <div class="char-profile-sec-body">
            ${profile.factionId
              ? `<div class="char-profile-row"><span class="char-profile-k">所属势力</span><span class="char-profile-v">${escapeHtml(nameOfRef(profile.factionId, [factions]))}</span></div>`
              : `<div class="char-profile-empty">—</div>`}
          </div>
        </section>

        <section class="char-profile-sec">
          <div class="char-profile-sec-hd"><span class="char-profile-sec-idx">⑦</span>力量体系</div>
          <div class="char-profile-sec-body">
            ${systemHtml}
          </div>
        </section>

        <section class="char-profile-sec">
          <div class="char-profile-sec-hd"><span class="char-profile-sec-idx">⑧</span>装备与圣物</div>
          <div class="char-profile-sec-body">
            ${gearHtml}
          </div>
        </section>
      </div>
    `;

    // 能力维度：轴名列表（作为第 ⑧ 区块下方的辅助显示——原图待校，不强行画雷达）
    if (axes.length) {
      const axesWrap = document.createElement("div");
      axesWrap.className = "char-profile-axes-block";
      axesWrap.innerHTML = `
        <div class="char-profile-axes-hd">能力维度</div>
        ${axesHtml}
      `;
      body.appendChild(axesWrap);
    }

    $("char-profile-title").textContent = `角色档案 · ${card.name || "（未命名）"}`;
    $("char-profile-modal").classList.remove("hidden");
  } catch (e) {
    toast("加载失败：" + friendlyError(e), "error");
  }
}

export function closeCharProfile() {
  $("char-profile-modal")?.classList.add("hidden");
}

export function bindCharProfile() {
  $("char-profile-close")?.addEventListener("click", closeCharProfile);
  $("char-profile-btn")?.addEventListener("click", () => {
    if (!state.currentCharacter) {
      toast("当前对话没有主角卡", "error");
      return;
    }
    loadCharProfile();
  });
}
