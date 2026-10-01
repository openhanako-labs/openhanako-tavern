// settings.js — 设定库（世界书）界面逻辑
//
// 职责：拉列表、渲染、开关、增删改、从 SillyTavern 导入世界书。
// 与角色卡一样是「列表 + 编辑器」两段式；编辑器字段较多
// （trigger / characterFilter / anchor），单独有 updateTriggerFields 联动。
//
// 后端：lib/settings/routes.js，端点见该文件。
//
// 2026-09-27 UI 重做（方案文档 docs/plans/2026-09-27-settings-library-ui.md）：
//   · 分页（10/页）+ 吸底分页条
//   · 分组维度三选一：生效方式 / 分类 / 常用度
//   · 折叠（localStorage 持久化，key 带维度）
//   · 组内排序四选一：原始顺序 / 名字 / 分类 / 最近修改
//   · 批量选择（勾选槽常驻占位 26px，避免宽度跳）
//   · 分类徽章 + 常用度徽章（priority 非 100 才画）
//   · 类目管理弹层（走 settings-cats.js）

import { apiFetch, toast, confirmDialog, escapeHtml, extractArray, friendlyError } from "./core.js";
import { dom, showEditForm } from "./dom.js";
import { state } from "./state.js";
import { settingBucket, SETTING_SECTIONS, keywordsAreLive } from "./setting-buckets.js";
import { foldKey, readFolded } from "./settings-fold.js";
import { emptyHtml, errHtml } from "./drawer-state.js";
// settings-cats.js 通过 CustomEvent 通信，避免循环依赖

/** 每页多少条。方案文档定死 10。 */
const PAGE_SIZE = 10;

/** 常用度三档。priority 复用，方案文档四、5。 */
const PRIORITY_TIERS = {
  300: { label: "核心", cls: "core", hint: "世界观骨架，预算不够时优先占位" },
  200: { label: "常用", cls: "common", hint: "日常对话高频引用" },
  100: { label: "冷门", cls: "rare", hint: "未标 / 冷门（不画徽章）" }
};

/** 分组维度定义。三种维度都在 settings.js 里判，不改引擎。 */
const GROUP_BY = {
  trigger: {
    label: "生效方式",
    sectionOf: (s) => SETTING_SECTIONS.find(sec => sec.key === settingBucket(s)) || SETTING_SECTIONS[0],
    // 未分类兜底分组：当分类为空 / 已停用，塞到这里
    emptyKey: null
  },
  category: {
    label: "分类",
    // 类目由后端下发（state.categoryList），空串单独一组「未分类」
    sectionOf: (s) => {
      const c = String(s?.category || "").trim();
      if (!c) return { key: "__uncategorized__", title: "未分类", hint: "点卡片上的分类徽章手动标" };
      const hit = (state.categoryList || []).find(n => n === c);
      if (hit) return { key: c, title: c, hint: "" };
      // 类目表里已经删掉的：条目上还挂着这个 tag，退化成「（已废弃）」
      return { key: c, title: `${c}（已废弃）`, hint: "类目表里已删除" };
    },
    // 分组顺序：先按类目表顺序，「未分类」垫底
    sortSections: (sections) => {
      const order = new Map((state.categoryList || []).map((n, i) => [n, i]));
      return sections.sort((a, b) => {
        const ka = a.key === "__uncategorized__" ? 9999 : (order.get(a.key) ?? 5000);
        const kb = b.key === "__uncategorized__" ? 9999 : (order.get(b.key) ?? 5000);
        return ka - kb;
      });
    }
  },
  priority: {
    label: "常用度",
    sectionOf: (s) => {
      const p = Number(s?.priority ?? 0) || 100;
      if (p >= 300) return { key: "300", title: "核心", hint: PRIORITY_TIERS[300].hint };
      if (p >= 200) return { key: "200", title: "常用", hint: PRIORITY_TIERS[200].hint };
      return { key: "100", title: "冷门 / 未标", hint: PRIORITY_TIERS[100].hint };
    },
    // 常用度顺序：核心 → 常用 → 冷门
    sortSections: (sections) => {
      const order = { "300": 0, "200": 1, "100": 2 };
      return sections.sort((a, b) => (order[a.key] ?? 9) - (order[b.key] ?? 9));
    }
  }
};

/** 排序方式定义。 */
const SORT_BY = {
  order:    { label: "原始顺序", fn: (a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) },
  name:     { label: "名字",     fn: (a, b) => String(a.comment || a.name || "").localeCompare(String(b.comment || b.name || ""), "zh-Hans-CN") },
  category: { label: "分类",     fn: (a, b) => String(a.category || "").localeCompare(String(b.category || ""), "zh-Hans-CN") || (Number(a.order) || 0) - (Number(b.order) || 0) },
  recent:   { label: "最近修改", fn: (a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")) }
};

/**
 * 折叠状态的读写。key 的构造收在 settings-fold.js 里——
 * 那里解释了为什么必须 String() 化（常驻组的 key 是数字 0，
 * 而 dataset 读回来是字符串，两端不对齐就会「点了没反应」）。
 */
function isFolded(dim, groupKey) {
  return readFolded(groupKey, dim, (k) => localStorage.getItem(k));
}

/** 翻转折叠状态。返回新值。 */
function toggleFold(dim, groupKey) {
  const next = !isFolded(dim, groupKey);
  try { localStorage.setItem(foldKey(dim, groupKey), next ? "1" : "0"); }
  catch { /* localStorage 不可用时静默：折叠是纯 UI 状态，丢了不致命 */ }
  return next;
}

/** 当前上下文的角色 id：优先对话绑定的角色，其次右栏选中的角色。 */
function currentCharacterId() {
  return String(state.currentConv?.characterId || state.currentCharacter?.id || "").trim();
}

/** 角色 id → 名字。列表里没有时退回短 id，不显示成空白。 */
function charNameOf(id) {
  const hit = (state.charList || []).find(c => String(c.id) === String(id));
  return hit?.name || String(id).slice(0, 8);
}

/**
 * 视图状态。放在模块级，不放 state——它属于设定库抽屉本身，
 * 不需要跨模块共享。state.settingList 才是共享的。
 */
const view = {
  page: 1,
  groupBy: "trigger",
  sortBy: "order",
  selected: new Set(),
  /*
   * 归属过滤（2026-10-01）："relevant" = 本卡 + 全局，"all" = 整池。
   * 放这里不放 state——它和 page / groupBy 一样属于抽屉本身，
   * 不需要跨模块共享。
   */
  scopeFilter: "relevant",
  // 类目表 —— loadSettings 时从后端拉
};

/** 拉列表并渲染。 */
export async function loadSettings() {
  try {
    // 名字要能显示：设定库可能先于角色列表被打开，那就在这里补一次。
    // 补不上也不致命——归属标签会退化成短 id，列表本身照常。
    if (!Array.isArray(state.charList) || state.charList.length === 0) {
      try {
        state.charList = extractArray(await apiFetch("characters")) || [];
      } catch { /* 退化成短 id */ }
    }

    // 类目表：只在第一次拉；后续由 settings-cats.js 的类目增删改后调用 refreshCats
    if (!Array.isArray(state.categoryList) || state.categoryList.length === 0) {
      try {
        const catsRes = await apiFetch("settings/categories");
        const catsData = catsRes.data || catsRes;
        state.categoryList = (catsData.items || []).map(x => x.name);
      } catch {
        // 后端未注册 categoryStore（老版本）时留空数组，界面上就全是「未分类」
        state.categoryList = [];
      }
    }

    const res = await apiFetch("settings");
    const list = extractArray(res);
    state.settingList = list;
    // 翻到首页——用户点了刷新，看到的第一屏应当是"最新的"
    view.page = 1;
    renderSettings(list);
  } catch (e) {
    console.error("[Settings] load failed:", e);
    // 错误态：分清是谁的错（不是“加载失败”四个字了事）
    if (dom.settingsListEl) {
      dom.settingsListEl.innerHTML = errHtml("没能读到设定库", "连接宿主 App 服务失败：" + friendlyError(e) + "。这不是你的数据出了问题。");
    }
    toast("加载失败: " + friendlyError(e), "error");
  }
}

/** 刷新类目表（类目增删改后由弹层调用）。 */
export async function refreshCats() {
  try {
    const res = await apiFetch("settings/categories");
    const data = res.data || res;
    state.categoryList = (data.items || []).map(x => x.name);
    renderSettings(state.settingList || []);
  } catch (e) {
    toast("刷新类目失败: " + friendlyError(e), "error");
  }
}

/** 渲染列表。分页 + 分组 + 折叠 + 排序，一次算完。 */
export function renderSettings(list) {
  if (!dom.settingsListEl) return;
  const raw = Array.isArray(list) ? list : [];
  const curId = currentCharacterId();

  // 归属
  const ownerOf = (s) => String(s?.characterId || "").trim();
  const isOwn = (s) => !!curId && ownerOf(s) === curId;
  const rank = (s) => (isOwn(s) ? 0 : ownerOf(s) ? 2 : 1);

  /*
   * 归属过滤（2026-10-01）："relevant" 只留本卡 + 全局，"all" 显示全部。
   *
   * 背景：106 条里「其他」占 104 条——它们属于别的卡，默认也该让位。
   * 徽章和排序只是把归属标出来，过滤才真正把别的卡的条目收起来。
   * 定义照计划 B2：relevant = isOwn || !ownerOf（没选角色时退化成全局）。
   */
  const scopeOk = (s) => isOwn(s) || !ownerOf(s);
  const pool = view.scopeFilter === "all" ? raw : raw.filter(scopeOk);

  // 搜索（在过滤后的池子里搜——「全部」才搜得到别的卡的条目）
  const q = String(document.getElementById("settings-search")?.value || "").trim().toLowerCase();
  const hit = (s) => {
    if (!q) return true;
    const hay = [
      s?.comment, s?.name, s?.content,
      ...(Array.isArray(s?.keywords) ? s.keywords : []),
      ...(Array.isArray(s?.secondaryKeys) ? s.secondaryKeys : [])
    ].map(x => String(x ?? "")).join("\n").toLowerCase();
    return hay.includes(q);
  };
  const shown = pool.filter(hit);

  // 计数行
  const ownN = raw.filter(isOwn).length;
  const globN = raw.filter(s => !ownerOf(s)).length;
  const otherN = raw.length - ownN - globN;

  if (dom.settingsCountEl) {
    if (raw.length === 0) dom.settingsCountEl.textContent = "";
    else if (q) dom.settingsCountEl.textContent = `命中 ${shown.length} / 共 ${pool.length} 条`;
    else if (view.scopeFilter === "all") dom.settingsCountEl.textContent = curId
      ? `${raw.length} 条 · 本卡 ${ownN} · 全局 ${globN} · 其他 ${otherN}`
      : `${raw.length} 条 · 全局 ${globN}`;
    // relevant 口径：「其他」已经收起来了，计数也不再报它
    else dom.settingsCountEl.textContent = curId
      ? `${pool.length} 条 · 本卡 ${ownN} · 全局 ${globN}`
      : `${pool.length} 条 · 全局 ${globN}`;
  }

  if (raw.length === 0) {
    // 空态写“没有的是什么” + 这个功能是干什么的（docs/spec-drawer.md 第四节）
    dom.settingsListEl.innerHTML = emptyHtml({
      ico: "▤",
      title: "还没有设定",
      desc: "设定是一段按条件进入上下文的世界资料——常驻的每轮都在，带触发词的说到才进。也可以从 SillyTavern 的世界书导入。",
      action: "+ 新建一条",
      act: "new"
    });
    dom.settingsListEl.querySelector('[data-act="new"]')?.addEventListener("click", () => openSettingEditor(null));
    dom.settingsListEl.nextElementSibling?.classList.add("hidden");
    renderPager(0, 1);
    return;
  }
  if (pool.length === 0) {
    /*
     * relevant 为 0：本卡没绑条目、也没有全局——不是「空」，是「不在本场」。
     * 库里还有别的卡的条目，文案要把路指出来（切「全部」）。
     */
    dom.settingsListEl.innerHTML = emptyHtml({
      ico: "▤",
      title: "本卡未绑定世界书条目",
      desc: "本场相关（本卡 + 全局）是 0 条。库里还有别的卡的条目——把上面切到「全部」看。"
    });
    dom.settingsListEl.nextElementSibling?.classList.add("hidden");
    renderPager(0, 1);
    return;
  }
  if (shown.length === 0) {
    // 搜不到不是“空”，是“没命中”——文案要区分开
    dom.settingsListEl.innerHTML = emptyHtml({
      ico: "⌕",
      title: `没有匹配「${q}」的条目`,
      desc: "搜的是名字、正文与触发词。换个短一点的词试试。"
    });
    renderPager(0, 1);
    return;
  }

  // 分组
  const dim = GROUP_BY[view.groupBy] || GROUP_BY.trigger;
  const sectionOf = dim.sectionOf;
  const groupMap = new Map();
  for (const s of shown) {
    const sec = sectionOf(s);
    const key = sec.key;
    if (!groupMap.has(key)) groupMap.set(key, { key, title: sec.title, hint: sec.hint || "", items: [] });
    groupMap.get(key).items.push(s);
  }

  // 排序分组顺序
  let sections = [...groupMap.values()];
  if (dim.sortSections) sections = dim.sortSections(sections);
  else sections.sort((a, b) => String(a.title).localeCompare(String(b.title), "zh-Hans-CN"));

  // 每组内排序
  const sortFn = (SORT_BY[view.sortBy] || SORT_BY.order).fn;
  for (const g of sections) {
    // 排序内嵌 rank 作为 tie-break：「本卡」永远在前
    g.items.sort((a, b) => (rank(a) - rank(b)) || sortFn(a, b));
  }

  // 分页：折叠的组不计入。把「当前页要显示哪些组、每个组要显示几条」算出来。
  // 关键：折叠组只画抬头（不占卡片位），展开组按 10 条切；
  // 若一个组跨页，切到下一页时保留组抬头（这样翻页不会失去上下文）。
  const paged = paginateSections(sections);

  // 渲染
  const parts = [];
  for (const p of paged) {
    const g = p.group;
    const folded = isFolded(view.groupBy, g.key);
    const cardList = folded ? [] : (p.items || []);
    parts.push(renderSection(g, folded, cardList));
  }
  dom.settingsListEl.innerHTML = parts.join("");

  // 事件绑定
  bindCards(dom.settingsListEl);
  bindGroupHeads(dom.settingsListEl, sections);

  // 分页条
  renderPager(pagedTotalPages(sections), view.page);

  // 批量条
  renderBatchBar();
}

/**
 * 分页算法。方案文档四、1：折叠的组不参与分页。
 *
 * 关键实现：把「展开的组」按每页 10 条摊开，遇到折叠的组只留抬头占位（0 条卡片）。
 * 这样：
 *   · 折叠组仍然出现在页面上（用户能看到组名，一眼确认「哦，常驻那组我折叠了」）
 *   · 页码只数展开的条数（106 条折成 4 页，不是 11 页）
 *   · 一个组跨页时不拆组：整组要么出现在这一页，要么整组挪到下一页
 *     （拆组会让组抬头每页都出现一次，反而乱）
 */
function paginateSections(sections) {
  const page = Math.max(1, Number(view.page) || 1);
  const perPage = PAGE_SIZE;

  // 先把每个组的"展开条数"算好；折叠组是 0
  const plan = sections.map(g => {
    const folded = isFolded(view.groupBy, g.key);
    return { group: g, folded, count: folded ? 0 : g.items.length };
  });

  // 计算每个组的起始累计条数（折叠组占 0）
  const total = plan.reduce((s, p) => s + p.count, 0);
  if (total === 0) {
    // 全部折叠 → 一页显示所有抬头，无卡片
    return plan.map(p => ({ group: p.group, folded: p.folded, items: [], totalShown: 0 }));
  }

  // 从第 1 页到目标页的偏移
  const from = (page - 1) * perPage;
  const to = from + perPage;
  if (from >= total) return [];

  // 遍历组：判断这个组的哪几条落在 [from, to)
  const result = [];
  let offset = 0;
  for (const p of plan) {
    const start = offset;
    const end = offset + p.count;
    offset = end;

    // 折叠组：不管是否跨页，抬头一定显示；items 空
    if (p.folded) {
      result.push({ group: p.group, folded: true, items: [], start, end });
      continue;
    }

    // 展开组：与 [from, to) 相交的部分
    if (end <= from || start >= to) {
      // 完全在窗外：不显示（除非当前页数就是 1，且它在窗口之前——那就当翻页前的组，不显示）
      continue;
    }

    const visibleFrom = Math.max(0, from - start);
    const visibleTo = Math.min(p.count, to - start);
    result.push({
      group: p.group,
      folded: false,
      items: p.group.items.slice(visibleFrom, visibleTo),
      start: Math.max(start, from),
      end: Math.min(end, to),
      fullCount: p.group.items.length,
      truncated: visibleFrom > 0 || visibleTo < p.group.items.length
    });
  }

  return result;
}

/** 计算总页数（折叠组不计入）。 */
function pagedTotalPages(sections) {
  const total = sections.reduce((s, g) => {
    if (isFolded(view.groupBy, g.key)) return s;
    return s + g.items.length;
  }, 0);
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

/** 渲染一个分组（抬头 + 卡片）。 */
function renderSection(g, folded, cardList) {
  const headCls = `section-head${folded ? " folded" : ""}`;
  const headArrow = folded ? "▸" : "▾";
  // String() 不能省：g.key 可能是数字 0，而 escapeHtml(0) 返回空串（它用 !str 判空），
  // 那样抬头的 data-key 会是空的，折叠读写两端对不上。
  const head = `<div class="${headCls}" data-key="${escapeHtml(String(g.key))}" data-act="toggle-fold">
    <span class="section-arrow">${headArrow}</span>
    <span class="section-title">${escapeHtml(g.title)}</span>
    <span class="section-hint">${escapeHtml(g.hint || "")}</span>
    <span class="section-n">${g.items.length}</span>
  </div>`;

  if (folded) {
    return `<div class="setting-section folded">${head}</div>`;
  }

  // 组内卡片。归属去重：只在归属变了的那一行画徽章。
  let lastOwner = null;
  const cardHtmls = cardList.map(s => {
    const owner = String(s?.characterId || "").trim();
    const showOwner = owner !== lastOwner;
    lastOwner = owner;
    return renderCard(s, showOwner);
  });

  return `<div class="setting-section">${head}${cardHtmls.join("")}</div>`;
}

/** 渲染一条卡片（甲形态：五行）。 */
function renderCard(s, showOwner) {
  const on = s.enabled !== false;
  const owner = String(s?.characterId || "").trim();
  const isOwn = () => {
    const curId = currentCharacterId();
    return !!curId && owner === curId;
  };
  const badge = owner
    ? `<span class="owner${isOwn() ? " mine" : ""}" title="只在这张卡的对话里生效">${escapeHtml(charNameOf(owner))}</span>`
    : `<span class="owner glob" title="所有对话都生效">全局</span>`;

  const content = String(s.content || "");

  // 触发词：只在非常驻组画（运行时对 always 条目不读触发词）
  const kws = (keywordsAreLive(s) && Array.isArray(s.keywords)) ? s.keywords : [];
  const kwLine = kws.length
    ? `<div class="setting-kw">${kws.slice(0, 6).map(escapeHtml).join("、")}${kws.length > 6 ? ` ＋${kws.length - 6}` : ""}</div>`
    : "";

  // 分类徽章
  const catName = String(s?.category || "").trim();
  const catBadge = catName
    ? `<span class="setting-cat-badge" data-act="pick-category" title="点击改分类">${escapeHtml(catName)}</span>`
    : `<span class="setting-cat-badge is-empty" data-act="pick-category" title="点击选分类">＋分类</span>`;

  // 常用度徽章：只在 priority != 100 时画
  const priority = Number(s?.priority ?? 100);
  const priorityBadge = priority !== 100
    ? (() => {
        const tier = PRIORITY_TIERS[300] && priority >= 300 ? "core"
                   : PRIORITY_TIERS[200] && priority >= 200 ? "common"
                   : "rare";
        const label = PRIORITY_TIERS[300] && priority >= 300 ? "核心"
                   : PRIORITY_TIERS[200] && priority >= 200 ? "常用"
                   : `P${priority}`;
        return `<span class="setting-priority-badge ${tier}" data-act="pick-priority" title="点击改常用度">${escapeHtml(label)}</span>`;
      })()
    : `<span class="setting-priority-badge is-empty" data-act="pick-priority" title="点击标常用度">＋常用度</span>`;

  const metaParts = [];
  if (showOwner) metaParts.push(badge);
  metaParts.push(catBadge);
  metaParts.push(priorityBadge);
  if (s.anchor) metaParts.push(`<span class="anchor">@${escapeHtml(s.anchor)}</span>`);
  const meta = `<div class="setting-meta">${metaParts.join("")}</div>`;

  const selected = view.selected.has(String(s.id)) ? " selected" : "";
  const tier = s.tier || "core";

  return `<div class="setting-card tier-${escapeHtml(tier)}${on ? "" : " off"}${selected}" data-id="${escapeHtml(s.id)}">
    <label class="check-col" title="选中这条">
      <input type="checkbox" data-act="toggle-select" ${view.selected.has(String(s.id)) ? "checked" : ""}>
      <span></span>
    </label>
    <div class="setting-main">
      <div class="setting-head">
        <h4>${escapeHtml(s.comment || s.name || "（无标题）")}</h4>
        <label class="switch" title="启用/停用">
          <input type="checkbox" data-act="toggle" ${on ? "checked" : ""}>
          <span></span>
        </label>
      </div>
      ${kwLine}
      ${meta}
      <div class="setting-foot">
        ${content
          ? `<details class="setting-detail"><summary>正文</summary><div class="setting-body">${escapeHtml(content)}</div></details>`
          : `<span class="setting-spacer"></span>`}
        <div class="setting-actions">
          <button class="mini" data-act="edit">编辑</button>
          <button class="mini danger" data-act="delete">删除</button>
        </div>
      </div>
    </div>
  </div>`;
}

/** 给列表里的所有卡片绑定事件。 */
function bindCards(root) {
  root.querySelectorAll(".setting-card").forEach(card => {
    const id = card.dataset.id;
    card.querySelector('[data-act="toggle"]')?.addEventListener("change", (e) => {
      toggleSetting(id, e.target.checked);
    });
    card.querySelector('[data-act="edit"]')?.addEventListener("click", () => openSettingEditor(id));
    card.querySelector('[data-act="delete"]')?.addEventListener("click", () => deleteSetting(id));
    card.querySelector('[data-act="toggle-select"]')?.addEventListener("change", (e) => {
      toggleSelect(id, e.target.checked);
    });
    card.querySelector('[data-act="pick-category"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent("settings:open-category-picker", { detail: { anchorEl: card, id } }));
    });
    card.querySelector('[data-act="pick-priority"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      openPriorityPicker(card, id);
    });
  });
}

/** 抬头折叠事件绑定。 */
function bindGroupHeads(root, sections) {
  root.querySelectorAll(".section-head[data-act='toggle-fold']").forEach(head => {
    head.addEventListener("click", () => {
      const key = head.dataset.key;
      toggleFold(view.groupBy, key);
      // 折叠状态改了，页码可能不合法（比如从 3 页翻到 2 页），
      // 直接回到当前页——view.page 不变，但总页数变了，越界就钳到最后一页。
      const totalPages = pagedTotalPages(sections);
      if (view.page > totalPages) view.page = totalPages;
      renderSettings(state.settingList || []);
    });
  });
}

/** 分页条。 */
function renderPager(totalPages, page) {
  const el = dom.settingsPagerEl;
  if (!el) return;
  if (!totalPages || totalPages < 1) {
    el.innerHTML = "";
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  const from = (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, totalItemsOfExpanded());
  el.innerHTML = `
    <button class="pager-btn" data-act="prev" ${page <= 1 ? "disabled" : ""}>‹</button>
    <span class="pager-info">${page} / ${totalPages} · ${from}–${to}</span>
    <button class="pager-btn" data-act="next" ${page >= totalPages ? "disabled" : ""}>›</button>
  `;
  el.querySelector('[data-act="prev"]')?.addEventListener("click", () => {
    if (view.page > 1) { view.page--; renderSettings(state.settingList || []); }
  });
  el.querySelector('[data-act="next"]')?.addEventListener("click", () => {
    if (view.page < totalPages) { view.page++; renderSettings(state.settingList || []); }
  });
}

/** 展开的总条数（折叠组不计）。 */
function totalItemsOfExpanded() {
  // 简单起见：从 state.settingList 里过滤出通过搜索的、再看折叠
  const raw = Array.isArray(state.settingList) ? state.settingList : [];
  const q = String(document.getElementById("settings-search")?.value || "").trim().toLowerCase();
  const hit = (s) => {
    if (!q) return true;
    const hay = [s?.comment, s?.name, s?.content, ...(Array.isArray(s?.keywords) ? s.keywords : []), ...(Array.isArray(s?.secondaryKeys) ? s.secondaryKeys : [])].map(x => String(x ?? "")).join("\n").toLowerCase();
    return hay.includes(q);
  };
  const dim = GROUP_BY[view.groupBy] || GROUP_BY.trigger;
  const sectionOf = dim.sectionOf;
  const groupMap = new Map();
  for (const s of raw.filter(hit)) {
    const sec = sectionOf(s);
    if (!groupMap.has(sec.key)) groupMap.set(sec.key, 0);
    groupMap.set(sec.key, groupMap.get(sec.key) + 1);
  }
  let total = 0;
  for (const [key, n] of groupMap) {
    if (isFolded(view.groupBy, key)) continue;
    total += n;
  }
  return total;
}

/** 批量条渲染。选中 0 条时隐藏。 */
function renderBatchBar() {
  const el = dom.settingsBatchBarEl;
  if (!el) return;
  const n = view.selected.size;
  if (n === 0) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.classList.remove("hidden");
  el.innerHTML = `
    <span class="batch-info">已选 <b>${n}</b> 条</span>
    <span class="batch-sep">·</span>
    <span class="batch-label">设为</span>
    <select id="batch-cat-select" class="batch-select"></select>
    <button class="btn btn-sm" data-act="apply-cat">应用分类</button>
    <select id="batch-prio-select" class="batch-select">
      <option value="300">核心</option>
      <option value="200">常用</option>
      <option value="100">冷门 / 未标</option>
    </select>
    <button class="btn btn-sm" data-act="apply-prio">应用常用度</button>
    <button class="btn btn-ghost btn-sm" data-act="clear-select">取消</button>
  `;
  // 填充类目下拉
  const catSel = document.getElementById("batch-cat-select");
  if (catSel) {
    const cats = state.categoryList || [];
    catSel.innerHTML = '<option value="">— 清空分类 —</option>' +
      cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  }
  el.querySelector('[data-act="apply-cat"]')?.addEventListener("click", applyBatchCategory);
  el.querySelector('[data-act="apply-prio"]')?.addEventListener("click", applyBatchPriority);
  el.querySelector('[data-act="clear-select"]')?.addEventListener("click", () => {
    view.selected.clear();
    renderSettings(state.settingList || []);
  });
}

/** 切换单条的选中状态。 */
function toggleSelect(id, checked) {
  if (checked) view.selected.add(String(id));
  else view.selected.delete(String(id));
  renderBatchBar();
  // 只刷当前页的卡片样式，不重排——勾选不该影响布局
  document.querySelectorAll(`.setting-card[data-id="${CSS.escape(String(id))}"]`).forEach(el => {
    el.classList.toggle("selected", checked);
  });
}

/** 批量应用分类。 */
async function applyBatchCategory() {
  const sel = document.getElementById("batch-cat-select");
  const cat = sel?.value || "";
  if (view.selected.size === 0) return;
  try {
    let ok = 0;
    for (const id of view.selected) {
      await apiFetch(`settings/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ category: cat }) });
      ok++;
    }
    // 同步 state.settingList 里的字段，避免列表里还是旧值
    const map = new Map(state.settingList.map(s => [String(s.id), s]));
    for (const id of view.selected) {
      const s = map.get(id);
      if (s) s.category = cat;
    }
    view.selected.clear();
    toast(`已应用分类到 ${ok} 条`, "success");
    renderSettings(state.settingList);
  } catch (e) {
    toast("应用分类失败: " + friendlyError(e), "error");
  }
}

/** 批量应用常用度。 */
async function applyBatchPriority() {
  const sel = document.getElementById("batch-prio-select");
  const p = Number(sel?.value) || 100;
  if (view.selected.size === 0) return;
  try {
    let ok = 0;
    for (const id of view.selected) {
      await apiFetch(`settings/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ priority: p }) });
      ok++;
    }
    const map = new Map(state.settingList.map(s => [String(s.id), s]));
    for (const id of view.selected) {
      const s = map.get(id);
      if (s) s.priority = p;
    }
    view.selected.clear();
    toast(`已应用常用度到 ${ok} 条`, "success");
    renderSettings(state.settingList);
  } catch (e) {
    toast("应用常用度失败: " + friendlyError(e), "error");
  }
}

/** 打开分类浮层选择器（点小徽章）。 */
function openCategoryPickerInline(cardEl, id) {
  // 复用 settings-cats.js 的浮层
  openCategoryPicker(cardEl, id);
}

/** 常用度浮层：三档。 */
function openPriorityPicker(cardEl, id) {
  if (dom.priorityPickerEl) return;
  const el = document.createElement("div");
  el.className = "picker-pop priority-picker";
  el.innerHTML = `
    <div class="picker-title">常用度</div>
    <button data-p="300">核心</button>
    <button data-p="200">常用</button>
    <button data-p="100">冷门 / 未标</button>
  `;
  document.body.appendChild(el);
  dom.priorityPickerEl = el;

  const rect = cardEl.getBoundingClientRect();
  el.style.position = "fixed";
  el.style.left = rect.right + "px";
  el.style.top = rect.top + "px";

  const close = () => { el.remove(); dom.priorityPickerEl = null; document.removeEventListener("mousedown", outside); };
  const outside = (e) => {
    if (!el.contains(e.target)) close();
  };
  setTimeout(() => document.addEventListener("mousedown", outside), 0);

  el.querySelectorAll("button[data-p]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const p = Number(btn.dataset.p);
      close();
      await applySinglePriority(id, p);
    });
  });
}

async function applySinglePriority(id, p) {
  try {
    await apiFetch(`settings/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ priority: p }) });
    const s = (state.settingList || []).find(x => String(x.id) === String(id));
    if (s) s.priority = p;
    renderSettings(state.settingList);
  } catch (e) {
    toast("修改常用度失败: " + friendlyError(e), "error");
  }
}

/** 打开编辑器。id 为空 → 新建。 */
export async function openSettingEditor(id) {
  try {
    if (id) {
      const res = await apiFetch(`settings/${encodeURIComponent(id)}`);
      state.currentSetting = res.data || res;
    } else {
      state.currentSetting = {
        id: null,
        comment: "",
        content: "",
        keywords: [],
        secondaryKeys: [],
        selectiveLogic: "and_any",
        anchor: "",
        tier: "core",
        enabled: true,
        order: 100,
        priority: 100,
        category: "",
        probability: 100,
        characterFilter: []
      };
    }
    state.currentForm = "setting";
    fillSettingForm(state.currentSetting);
    showEditForm("setting");
    dom.modalEl?.classList.remove("hidden");
  } catch (e) {
    toast("打开失败: " + friendlyError(e), "error");
  }
}

/** 把条目填进表单。 */
function fillSettingForm(s) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ""; };
  set("sf-name", s.comment || "");
  set("sf-content", s.content || "");
  set("sf-keywords", (s.keywords || []).join(", "));
  set("sf-secondary-keys", (s.secondaryKeys || []).join(", "));
  set("sf-trigger-type", s.anchor || "");
  set("sf-tier", s.tier || "core");
  set("sf-logic", s.selectiveLogic || "and_any");
  set("sf-order", s.order ?? 100);
  set("sf-priority", s.priority ?? 100);
  set("sf-probability", s.probability ?? 100);
  if (document.getElementById("sf-category")) set("sf-category", s.category || "");
  const en = document.getElementById("sf-enabled");
  if (en) en.checked = s.enabled !== false;
  updateTriggerFields(String(s.tier || "core"));
}

/** 保存（新建或更新）。 */
export async function saveSetting() {
  const s = state.currentSetting;
  if (!s) return;
  const val = (id) => document.getElementById(id)?.value ?? "";

  const body = {
    selectiveLogic: val("sf-logic") || "and_any",
    comment: val("sf-name").trim(),
    content: val("sf-content"),
    keywords: val("sf-keywords").split(/[,，]/).map(x => x.trim()).filter(Boolean),
    secondaryKeys: val("sf-secondary-keys").split(/[,，]/).map(x => x.trim()).filter(Boolean),
    anchor: val("sf-trigger-type").trim(),
    tier: val("sf-tier") || "core",
    order: Number(val("sf-order")) || 100,
    priority: Number(val("sf-priority")) || 100,
    probability: Number(val("sf-probability")) || 100,
    enabled: document.getElementById("sf-enabled")?.checked !== false
  };
  // category 是本地字段，只在前端表单里存在时才带过去
  const catEl = document.getElementById("sf-category");
  if (catEl) body.category = catEl.value || "";
  if (!body.content.trim()) { toast("内容不能为空", "error"); return; }

  try {
    if (s.id) await apiFetch(`settings/${encodeURIComponent(s.id)}`, { method: "PUT", body: JSON.stringify(body) });
    else await apiFetch("settings", { method: "POST", body: JSON.stringify(body) });

    state.currentSetting = null;
    state.currentForm = null;
    dom.modalEl?.classList.add("hidden");
    await loadSettings();
    toast("已保存", "success");
  } catch (e) {
    toast("保存失败: " + friendlyError(e), "error");
  }
}

/** 删除（有确认，删了不可恢复）。 */
export async function deleteSetting(id) {
  const ok = await confirmDialog(`删除这条设定？此操作不可恢复。`);
  if (!ok) return;
  try {
    await apiFetch(`settings/${encodeURIComponent(id)}`, { method: "DELETE" });
    view.selected.delete(String(id));
    await loadSettings();
    toast("已删除", "success");
  } catch (e) {
    toast("删除失败: " + friendlyError(e), "error");
  }
}

/** 开关。 */
export async function toggleSetting(id, on) {
  try {
    await apiFetch(`settings/${encodeURIComponent(id)}/toggle`, {
      method: "PUT",
      body: JSON.stringify({ enabled: on === true })
    });
  } catch (e) {
    toast("切换失败: " + friendlyError(e), "error");
    await loadSettings();
  }
}

/** 列表项的动作分派（事件委托用）。 */
export function handleSettingAction(action, id) {
  if (action === "edit") openSettingEditor(id);
  else if (action === "delete") deleteSetting(id);
  else if (action === "toggle") toggleSetting(id, true);
}

/**
 * 导出为 ST 世界书。
 *
 * 导的是「本卡 + 全局」——和列表里属于这一场的那几节是同一批。
 * 没有当前角色时退回全部（那时列表也没有归属可分）。
 */
export async function exportSTWorldBook() {
  try {
    const cid = currentCharacterId();
    const qs = cid ? `?characterId=${encodeURIComponent(cid)}` : "";
    const res = await apiFetch(`settings/export-st${qs}`);
    const data = res.data || res;
    const book = data.worldBook;
    const total = Number(data.total) || Object.keys(book?.entries || {}).length;
    if (!book || total === 0) { toast("没有可导出的条目", "error"); return; }

    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

    const blob = new Blob([JSON.stringify(book, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `worldbook_${stamp}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`已导出 ${total} 条`, "success");
  } catch (e) {
    toast("导出失败：" + friendlyError(e), "error");
  }
}

/** 从文件选择器导入 ST 世界书。 */
export async function importSTWorldBook() {
  dom.stImportInput?.click();
}

/** 文件选中的处理。 */
export async function handleSTImport(e) {
  const files = e?.target?.files;
  if (!files || files.length === 0) return;

  try {
    // 多个文件逐个发（一次一份，数才能分得清）
    let added = 0;
    let updated = 0;
    for (const f of files) {
      const raw = await f.text();
      let worldBook;
      try {
        worldBook = JSON.parse(raw);
      } catch (err) {
        throw new Error(`${f.name} 不是合法 JSON：${err.message}`);
      }
      const res = await apiFetch("settings/import-st", {
        method: "POST",
        body: JSON.stringify({ worldBook })
      });
      const data = res.data || res;
      added += data.added ?? 0;
      updated += data.updated ?? 0;
    }
    toast(`导入完成：新增 ${added}、更新 ${updated}`, "success");
    await loadSettings();
  } catch (err) {
    toast("导入失败: " + friendlyError(err), "error");
  } finally {
    e.target.value = "";
  }
}

/** 跑一次启发式分类。默认只填空串位。 */
export async function runAutocategorize() {
  try {
    const res = await apiFetch("settings/autocategorize", {
      method: "POST",
      body: JSON.stringify({ onlyEmpty: true })
    });
    const data = res.data || res;
    const filled = Number(data?.filled) || 0;
    const total = Number(data?.total) || 0;
    if (filled === 0) toast(`启发式没匹上任何条目（共扫 ${total} 条）`, "info");
    else toast(`自动分类：新标 ${filled} 条`, "success");
    await loadSettings();
  } catch (e) {
    toast("自动分类失败: " + friendlyError(e), "error");
  }
}

/**
 * 绑定工具条与过滤器的控件。
 *
 * 单独一个函数：shell.js 打开抽屉时才绑一次，避免每次渲染都重复 addEventListener。
 */
export function bindSettingsControls() {
  const s = dom;
  s.createSettingBtn?.addEventListener("click", () => openSettingEditor(null));
  s.importStBtn?.addEventListener("click", () => importSTWorldBook());
  s.exportStBtn?.addEventListener("click", () => exportSTWorldBook());
  s.autocategorizeBtn?.addEventListener("click", () => runAutocategorize());
  s.catsBtn?.addEventListener("click", () => openCatsModal());
  s.settingsSearch?.addEventListener("input", () => {
    view.page = 1;
    renderSettings(state.settingList || []);
  });
  s.settingsGroupBy?.addEventListener("change", () => {
    view.groupBy = s.settingsGroupBy.value;
    view.page = 1;
    renderSettings(state.settingList || []);
  });
  s.settingsSortBy?.addEventListener("change", () => {
    view.sortBy = s.settingsSortBy.value;
    renderSettings(state.settingList || []);
  });
  // 归属过滤（2026-10-01）：本场相关 / 全部。切了回首页——过滤后的第一屏应当是「最靠前的」
  s.settingsScope?.addEventListener("change", () => {
    view.scopeFilter = s.settingsScope.value === "all" ? "all" : "relevant";
    view.page = 1;
    renderSettings(state.settingList || []);
  });
}

/**
 * tier 变了就联动 trigger 区域。
 */
export function updateTriggerFields(tier) {
  const t = String(tier || "core");
  const show = (id, on) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.closest(".field")?.classList.toggle("hidden", !on);
  };
  show("sf-trigger-type", true);
  show("sf-order", t !== "core");
  show("sf-priority", true);
  show("sf-probability", true);
}

// 供外部调试 / 测试用
export { view };
export const _internal = { GROUP_BY, SORT_BY, PAGE_SIZE, view, renderSettings };

// ── 跨模块事件：settings-cats.js 通过事件通知 settings.js 数据已变更 ──
// 用事件而不是 import，是因为两边会互调函数，ES modules 循环 import 会让
// 顶层导出未定义。事件只在运行时派发，模块加载顺序无关。
window.addEventListener("settings:changed", () => loadSettings());
