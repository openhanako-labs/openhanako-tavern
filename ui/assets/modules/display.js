// display.js — 文字与字体（阅读偏好）
//
// 为什么走 localStorage 而不是后端：背景图必须存服务端（它是文件，走 appearance），
// 字号字体是纯前端渲染参数——跟「玩家消息靠左」「导航收起」同一族，存 eleckoi:* 就够。
//
// 应用方式（都落在 documentElement 的 inline style 上，跟背景遮罩同一手法）：
//   字号：字号 token 全是 px 定值（characters.css :root 的注释——322 处收成 6 档），
//         不能走 rem，所以在 inline 上按比例重写 6 个 --fs-*；
//         100% 时移除 inline，:root 里那组设计基准原样生效。
//   字体：改 --serif（叙事正文的字体变量）。界面无衬线不动——
//         「谁在说话」靠界面/正文两族字区分（.message.assistant .bubble 的设计前提），
//         改界面字体等于把这条线抹掉。
//
// 交互形态：改动即时生效、即时落盘，没有「保存」——✕ 关闭就是完成，
// 页脚只留「恢复默认」。跟 bg-modal 同一条纪律。

const SCALE_KEY = "eleckoi:text-scale";
const FONT_KEY = "eleckoi:body-font";

// :root 里 6 档的设计基准（characters.css）。动 :root 时这里必须跟着改。
const FS_BASE = { "2xs": 10.5, xs: 11, sm: 12, md: 13, lg: 15, xl: 20 };
const SCALE_MIN = 90;
const SCALE_MAX = 130;

// 正文字体候选。空串 = 默认，不写 inline——CSS 里那串衬线栈就是设计意图，
// 伪装成「一个选项」反而会让人忘了默认其实是什么。
const BODY_FONTS = {
  "": null,
  song: '"SimSun", "Songti SC", serif',
  kai: '"KaiTi", "Kaiti SC", "STKaiti", serif',
  sans: '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", Roboto, sans-serif'
};

let bound = false;

const $ = (id) => document.getElementById(id);

function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function readScale() {
  try {
    return clampNum(localStorage.getItem(SCALE_KEY), SCALE_MIN, SCALE_MAX, 100);
  } catch { return 100; } // 隐私模式读不了就按基准跑
}

function readFont() {
  try {
    const v = localStorage.getItem(FONT_KEY);
    return v && Object.prototype.hasOwnProperty.call(BODY_FONTS, v) ? v : "";
  } catch { return ""; }
}

/** 把当前偏好落到界面。幂等；init 和面板里每次改动都走它。 */
export function applyDisplay() {
  const root = document.documentElement.style;
  const scale = readScale();
  if (scale === 100) {
    for (const k of Object.keys(FS_BASE)) root.removeProperty(`--fs-${k}`);
  } else {
    for (const [k, v] of Object.entries(FS_BASE)) {
      root.setProperty(`--fs-${k}`, `${((v * scale) / 100).toFixed(2)}px`);
    }
  }
  const stack = BODY_FONTS[readFont()];
  if (!stack) root.removeProperty("--serif");
  else root.setProperty("--serif", stack);
}

function saveScale(v) {
  try { localStorage.setItem(SCALE_KEY, String(v)); } catch { /* 写不了就这次不记 */ }
}
function saveFont(v) {
  try { localStorage.setItem(FONT_KEY, v); } catch { /* 同上 */ }
}

/** 打开面板时把控件回填成当前值。 */
function renderModal() {
  const scale = readScale();
  const slider = $("display-size");
  if (slider) slider.value = String(scale);
  const val = $("display-size-val");
  if (val) val.textContent = `${scale}%`;
  const font = $("display-font");
  if (font) font.value = readFont();
}

export function openDisplayModal() {
  const m = $("display-modal");
  if (!m) return;
  renderModal();
  m.classList.remove("hidden");
}
export function closeDisplayModal() {
  $("display-modal")?.classList.add("hidden");
}

/** 绑定。幂等（init 只跑一次，但跟 bindAppearance 同一防护）。 */
export function bindDisplay() {
  if (bound) return;
  bound = true;

  $("display-open")?.addEventListener("click", openDisplayModal);
  $("display-close")?.addEventListener("click", closeDisplayModal);
  // 点遮罩关闭——bg-modal / tts-modal 都有这条，手势一致性不省
  $("display-modal")?.addEventListener("click", (e) => { if (e.target.id === "display-modal") closeDisplayModal(); });

  // 滑块：input 时实时生效+实时存（localStorage 写入极轻，犯不上分两步）
  $("display-size")?.addEventListener("input", () => {
    const v = clampNum($("display-size").value, SCALE_MIN, SCALE_MAX, 100);
    saveScale(v);
    const val = $("display-size-val");
    if (val) val.textContent = `${v}%`;
    applyDisplay();
  });

  $("display-font")?.addEventListener("change", () => {
    const v = $("display-font").value;
    saveFont(Object.prototype.hasOwnProperty.call(BODY_FONTS, v) ? v : "");
    applyDisplay();
  });

  $("display-reset")?.addEventListener("click", () => {
    try {
      localStorage.removeItem(SCALE_KEY);
      localStorage.removeItem(FONT_KEY);
    } catch { /* ignore */ }
    renderModal();
    applyDisplay();
  });
}

/** 开局调一次：把上次的选择落回界面。localStorage 拉不到按默认跑，不抛。 */
export function loadDisplay() {
  applyDisplay();
}
