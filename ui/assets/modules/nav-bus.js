// nav-bus.js — card 页与 Hana 左栏（functionPanel）之间的导航通道
//
// 两个 surface 是同源不同 iframe，localStorage 共享、storage 事件跨帧触发。
// rail.js 写意图，这里收。方向是单向的：左栏指挥，主区执行。
//
// 另有一条反走的：主区新建/删了对话，让左栏刷新。

const BUS_KEY = "eleckoi:nav";
const ACTIVE_KEY = "eleckoi:active-conv";
const HEARTBEAT_KEY = "eleckoi:rail-alive";
const HEARTBEAT_TTL = 15000;

/**
 * 订阅导航意图。
 * @param {(msg: {t:string, id?:string}) => void} onNav
 * @returns {() => void} 取消订阅
 */
export function onNavigation(onNav) {
  const handler = (e) => {
    if (e.key !== BUS_KEY || !e.newValue) return;
    try {
      const msg = JSON.parse(e.newValue);
      if (msg && typeof msg.t === "string") onNav(msg);
    } catch { /* 坏消息就丢 */ }
  };
  window.addEventListener("storage", handler);

  // 同帧内（rail 与 card 恰在同一文档时）补一次读，避免漏掉刚写的那条
  try {
    const raw = localStorage.getItem(BUS_KEY);
    if (raw) {
      const msg = JSON.parse(raw);
      if (msg && Date.now() - (msg.ts || 0) < 8000) onNav(msg);
    }
  } catch { /* ignore */ }

  return () => window.removeEventListener("storage", handler);
}

/** 让左栏刷新列表。 */
export function askRailRefresh() {
  try { localStorage.setItem(BUS_KEY, JSON.stringify({ t: "rail-refresh", ts: Date.now() })); } catch { /* ignore */ }
}

/** 把当前对话 id 同步给左栏（用于高亮）。 */
export function setActiveConv(id) {
  try { localStorage.setItem(ACTIVE_KEY, String(id || "")); } catch { /* ignore */ }
}

/**
 * 左栏是否活着。
 *
 * 决定主区要不要显示自己的兜底侧栏：用户从 App 卡片直接进来时，
 * functionPanel 不一定挂着，那时没导航就没法用了。
 */
export function railAlive() {
  try {
    const t = Number(localStorage.getItem(HEARTBEAT_KEY) || 0);
    return Date.now() - t < HEARTBEAT_TTL;
  } catch { return false; }
}
