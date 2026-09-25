// tools/flows/chain.js —— 线① 核心扮演链体检
//
// 第一步：**别猜选择器**。先让页面把自己的骨架吐出来，我照骨架选。
// 同时把那个 404 的资源名抓出来（console 只肯说"404"，不肯说是谁）。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (p, opt) => fetch(`/__api/${p}`, opt).then((r) => r.json());
const post = (p, body) => api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const out = {};
const txt = (el) => (el ? String(el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 28) : "");

function skeleton(root, maxDepth = 4, maxNodes = 80) {
  const lines = [];
  const walk = (el, d) => {
    if (!el || lines.length >= maxNodes || d > maxDepth) return;
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className.trim()
      ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
      : "";
    const tag = el.tagName.toLowerCase();
    const interesting = id || cls || ["button", "input", "textarea", "a", "li", "nav"].includes(tag);
    if (interesting) lines.push(`${"  ".repeat(d)}${tag}${id}${cls}  ${txt(el)}`);
    for (const c of el.children) walk(c, d + 1);
  };
  walk(root, 0);
  return lines.join("\n");
}

// 页面骨架（从一个容器开始，看不到就退到 body）
const scope = document.querySelector("#characters-page, #app, main, .layout") || document.body;
out["骨架 · 顶层"] = skeleton(scope, 3, 60);

// 左栏（角色卡列表那一块）单独再来一份，深一点
const sidebar = document.querySelector("#sidebar, .sidebar, aside, #char-list, .char-list") || null;
out["骨架 · 左栏"] = sidebar ? skeleton(sidebar, 5, 50) : "(没找到左栏容器)";

// 那个 404 到底是谁
const rs = performance.getEntriesByType("resource") || [];
const bad = rs.filter((e) => typeof e.responseStatus === "number" && e.responseStatus >= 400);
out["404/4xx 的资源"] = bad.length
  ? bad.slice(0, 8).map((e) => `${e.responseStatus} ${String(e.name).replace(location.origin, "")}`).join(" | ")
  : "(performance 里没记到 4xx)";

// 页面上所有"像入口"的东西：带 data-* 的元素全列一遍（前 20 个）
const d = [...document.querySelectorAll("[data-action], [data-act], [data-id], [data-tab], [data-nav]")];
out["带 data-* 的元素数"] = d.length;
out["带 data-* 的元素（前 20）"] = d.slice(0, 20).map((el) => {
  const ds = Object.entries(el.dataset).map(([k, v]) => `${k}=${String(v).slice(0, 14)}`).join(",");
  return `${el.tagName.toLowerCase()}[${ds}] "${txt(el)}"`;
}).join(" | ");

// 角色卡数据本身（服务端视角，含 has_book 之类的推导字段）
const chars = (await api("characters"))?.data || [];
out["角色卡数"] = chars.length;
out["第一张卡的字段"] = chars[0] ? Object.keys(chars[0]).join(", ") : "(无)";
out["第一张卡的 preview"] = chars[0]?.preview ? JSON.stringify(chars[0].preview).slice(0, 160) : "(没有 preview 字段)";

return out;
