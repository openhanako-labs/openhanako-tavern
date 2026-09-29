// graph-renderer.js — 图谱与雷达图的纯渲染函数（C3-2）
//
// 把 SVG 拼接逻辑从 codex.js 抽出来，原因：
//   1) codex.js 依赖 DOM（document / window / hana sdk），Node 测试导入会炸。
//   2) renderGraph / renderRadar 本质是纯函数（输入数据 → 输出 SVG 字符串），
//      不依赖任何 DOM API，抽出来就能用纯 Node 回归。
//   3) 拆出后，将来如果要在别的页面（如角色档案）复用雷达图，不必再翻 codex.js。
//
// 契约：
//   renderGraph(data, focusPersonId) → { svg, stats }
//   renderRadar(axes, opts) → svg 字符串
//
// data 形状：
//   { persons: [...], places: [...], factions: [...], relations: [...] }
//   每张表是已 normalize 的对象数组（id, name, ...）。

const SVG_NS = "http://www.w3.org/2000/svg";

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── 图谱 ─────────────────────────────────────────────

/**
 * 静态环形布局，无向边灰、有向边带箭头。
 * 所有节点（含孤立）都入图——孤点本身就是信息。
 *
 * @param {Object} data  { persons, places, factions, relations }
 * @param {string|null} focusPersonId 高亮的人物 id（只控制视觉高亮，不控制入图）
 * @returns {{ svg: string, stats: string }}
 */
export function renderGraph(data, focusPersonId) {
  const persons = data.persons || [];
  const places = data.places || [];
  const factions = data.factions || [];
  const relations = data.relations || [];

  // 把 relations 表里的 id 引用映射回具体的 codex 对象。
  // 支持两种写法：带前缀（p_ / pl_ / f_）与无前缀（纯 UUID）。
  const strip = (s) => String(s || "").replace(/^(p_|pl_|f_)/, "");
  const resolveRef = (id) => {
    if (!id) return null;
    const raw = strip(id);
    if (id.startsWith("p_")) {
      const p = persons.find(x => x.id === raw);
      return p ? { type: "person", obj: p } : null;
    }
    if (id.startsWith("pl_")) {
      const p = places.find(x => x.id === raw);
      return p ? { type: "place", obj: p } : null;
    }
    if (id.startsWith("f_")) {
      const p = factions.find(x => x.id === raw);
      return p ? { type: "faction", obj: p } : null;
    }
    const p = persons.find(x => x.id === raw);
    if (p) return { type: "person", obj: p };
    const pl = places.find(x => x.id === raw);
    if (pl) return { type: "place", obj: pl };
    const f = factions.find(x => x.id === raw);
    return f ? { type: "faction", obj: f } : null;
  };

  // 收集所有引用到的实体（带边的）
  const seen = new Map();
  for (const r of relations) {
    for (const id of [r.from, r.to]) {
      if (!id || seen.has(id)) continue;
      const info = resolveRef(id);
      if (info.obj) seen.set(id, info);
    }
  }
  // 也收孤立的实体——AIRP 那张图全部实体都在图上，
  // 孤点本身就是信息（「这个人还没和任何人发生关系」）。
  // 人物、地点、势力都要收，不管有没有 focusPersonId；
  // focus 只控制视觉高亮，不控制是否入图。
  for (const p of persons) if (!seen.has(p.id)) seen.set(p.id, { type: "person", obj: p });
  for (const pl of places) if (!seen.has(pl.id)) seen.set(pl.id, { type: "place", obj: pl });
  for (const f of factions) if (!seen.has(f.id)) seen.set(f.id, { type: "faction", obj: f });

  const nodes = [...seen.values()].filter(x => x.obj);

  const W = 900, H = 520;
  const cx = W / 2, cy = H / 2 + 20;
  const R = Math.min(W, H) * 0.36;
  const n = nodes.length;

  // 环形布局
  const posMap = new Map();
  for (let i = 0; i < n; i++) {
    const id = nodes[i].obj.id;
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    posMap.set(id, { x: cx + R * Math.cos(angle), y: cy + R * Math.sin(angle) });
  }

  let svg = `<svg class="codex-graph-svg-inner" viewBox="0 0 ${W} ${H}" width="100%" height="100%" xmlns="${SVG_NS}" preserveAspectRatio="xMidYMid meet">`;

  // 定义箭头 marker
  svg += `<defs>`;
  svg += `<marker id="codex-graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">`;
  svg += `<path d="M 0 0 L 10 5 L 0 10 z" class="codex-graph-arrow-fill"/>`;
  svg += `</marker>`;
  svg += `</defs>`;

  // 边（先画边，再画节点，节点盖在边上）
  for (const r of relations) {
    const fromInfo = resolveRef(r.from);
    const toInfo = resolveRef(r.to);
    if (!fromInfo || !toInfo) continue;
    const from = posMap.get(fromInfo.obj.id);
    const to = posMap.get(toInfo.obj.id);
    if (!from || !to) continue;
    const isDirected = r.direction === "from-to";
    const absStr = Math.abs(r.strength || 0);
    const w = 1 + Math.min(3, absStr / 30);
    const marker = isDirected ? ' marker-end="url(#codex-graph-arrow)"' : "";
    svg += `<line x1="${from.x.toFixed(2)}" y1="${from.y.toFixed(2)}" x2="${to.x.toFixed(2)}" y2="${to.y.toFixed(2)}" stroke-width="${w.toFixed(2)}" class="codex-graph-edge" data-directed="${isDirected ? 1 : 0}"${marker} data-rel-id="${escapeHtml(r.id)}"/>`;
    if (r.kind) {
      const mx = (from.x + to.x) / 2;
      const my = (from.y + to.y) / 2;
      svg += `<text x="${mx.toFixed(2)}" y="${my.toFixed(2)}" class="codex-graph-edge-label" text-anchor="middle" dominant-baseline="central">${escapeHtml(r.kind)}</text>`;
    }
  }

  // 节点
  for (const info of nodes) {
    const p = posMap.get(info.obj.id);
    if (!p) continue;
    const obj = info.obj;
    const name = obj.name || "（未命名）";
    // focus 只针对人物（势力/地点不参与焦点）
    const focus = info.type === "person" && obj.id === focusPersonId;
    // focusAttr 对三种形状都一样：focus=true 就加 data-focus=1。
    // ⚠️ 定义在 if/else 之前，否则势力/地点分支引用的时候会是 undefined
    // （ReferenceError）——C3-2-fix2 的教训：定义放在循环顶部，不分叉。
    const focusAttr = focus ? " data-focus=1" : "";

    let shape;
    if (info.type === "faction") {
      const s = 22;
      shape = `<rect x="${(p.x - s / 2).toFixed(2)}" y="${(p.y - s / 2).toFixed(2)}" width="${s}" height="${s}" class="codex-graph-node" data-type="${info.type}"${focusAttr} data-node-id="${escapeHtml(obj.id)}" data-node-type="${info.type}"/>`;
    } else if (info.type === "place") {
      const s = 22;
      const h = s * 0.87;
      shape = `<polygon points="${p.x.toFixed(2)},${(p.y - h / 2).toFixed(2)} ${(p.x - s / 2).toFixed(2)},${(p.y + h / 2).toFixed(2)} ${(p.x + s / 2).toFixed(2)},${(p.y + h / 2).toFixed(2)}" class="codex-graph-node" data-type="${info.type}"${focusAttr} data-node-id="${escapeHtml(obj.id)}" data-node-type="${info.type}"/>`;
    } else {
      shape = `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="11" class="codex-graph-node" data-type="${info.type}"${focusAttr} data-node-id="${escapeHtml(obj.id)}" data-node-type="${info.type}"/>`;
    }
    svg += shape;
    svg += `<text x="${p.x.toFixed(2)}" y="${(p.y + 28).toFixed(2)}" class="codex-graph-node-label" data-focus="${focus ? 1 : 0}" text-anchor="middle">${escapeHtml(name)}</text>`;
  }

  svg += `</svg>`;
  const stats = `${persons.length} 人 · ${factions.length} 势力 · ${places.length} 地 · ${relations.length} 关系`;
  return { svg, stats };
}

// ── 雷达图 ───────────────────────────────────────────

/**
 * 纯 SVG 雷达图。缺值轴画虚线圈 + 「—」，不进多边形顶点。
 * 有效轴 >= 3 且满一圈 → <polygon>（闭合）；否则 → <polyline>（不闭合）。
 *
 * @param {Array} axes  [{ name, value, max }]，value === null 表示缺
 * @param {Object} opts  { title, size }
 * @returns {string} svg 字符串
 */
export function renderRadar(axes, opts = {}) {
  const size = Number(opts.size) || 150;
  const title = String(opts.title || "");
  const cx = size / 2;
  const cy = size / 2;
  const r = (size / 2) - 18;
  const list = (axes || []).filter(a => a && a.name);
  const total = list.length;

  let svg = `<svg class="codex-radar" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" xmlns="${SVG_NS}" aria-label="${escapeHtml(title || "雷达")}">`;

  // 背景同心圆（装饰，不参与数据）
  svg += `<circle cx="${cx}" cy="${cy}" r="${r}" class="codex-radar-ring"/>`;
  svg += `<circle cx="${cx}" cy="${cy}" r="${(r * 2 / 3).toFixed(1)}" class="codex-radar-ring"/>`;
  svg += `<circle cx="${cx}" cy="${cy}" r="${(r / 3).toFixed(1)}" class="codex-radar-ring"/>`;

  if (total === 0) {
    return svg + `<text x="${cx}" y="${cy}" class="codex-radar-empty" text-anchor="middle" dominant-baseline="middle">（无轴）</text></svg>`;
  }

  const filled = [];
  for (let i = 0; i < total; i++) {
    const angle = -Math.PI / 2 + (i / total) * Math.PI * 2;
    const nx = cx + r * Math.cos(angle);
    const ny = cy + r * Math.sin(angle);

    svg += `<line x1="${cx}" y1="${cy}" x2="${nx.toFixed(2)}" y2="${ny.toFixed(2)}" class="codex-radar-axis"/>`;

    const a = list[i];
    const hasVal = typeof a.value === "number" && Number.isFinite(a.value);
    if (!hasVal) {
      // 缺值轴：虚线圈 + 「—」标签，不进多边形顶点
      svg += `<circle cx="${nx.toFixed(2)}" cy="${ny.toFixed(2)}" r="9" class="codex-radar-missing"/>`;
      svg += `<text x="${nx.toFixed(2)}" y="${ny.toFixed(2)}" class="codex-radar-missing-label" text-anchor="middle" dominant-baseline="central">—</text>`;
    } else {
      filled.push({ angle, value: a.value, name: a.name });
    }

    // 轴标签（无论有没有值都画）
    const lx = cx + (r + 10) * Math.cos(angle);
    const ly = cy + (r + 10) * Math.sin(angle);
    svg += `<text x="${lx.toFixed(2)}" y="${ly.toFixed(2)}" class="codex-radar-label" text-anchor="middle" dominant-baseline="central">${escapeHtml(a.name)}</text>`;
  }

  if (filled.length >= 1) {
    const scale = (typeof opts.max === "number" && opts.max > 0) ? opts.max : 1;
    const pts = filled.map(f => {
      const ratio = Math.max(0, Math.min(1, (f.value || 0) / scale));
      const px = cx + r * ratio * Math.cos(f.angle);
      const py = cy + r * ratio * Math.sin(f.angle);
      return `${px.toFixed(2)},${py.toFixed(2)}`;
    });
    if (filled.length >= 3) {
      // 满一圈（filled 数 == total 轴数）→ 闭合多边形；否则 open polyline
      if (filled.length >= total) {
        svg += `<polygon points="${pts.join(" ")}" class="codex-radar-shape"/>`;
      } else {
        svg += `<polyline points="${pts.join(" ")}" class="codex-radar-shape"/>`;
      }
    }
    for (const p of pts) {
      const [x, y] = p.split(",");
      svg += `<circle cx="${x}" cy="${y}" r="3" class="codex-radar-dot"/>`;
    }
  }

  svg += `</svg>`;
  return svg;
}
