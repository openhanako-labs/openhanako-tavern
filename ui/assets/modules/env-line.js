// env-line.js —— 从状态栏里挑出「环境」字段，拼成一行
//
// 为什么从状态栏拿，而不是另立一套 {{setvar}} 变量约定：
// 时间/地点这类会变的事实，模型每轮本来就会报在状态栏里；
// 再引入一套约定，等于让同一件事有两个来源，迟早不一致。
// 而状态栏已经切好了（见 status-block.js），这里只做纯解析。
//
// 三条原则：
//   1. 只认切出来的状态栏，不扫正文——正文里出现「时间」两个字太容易了。
//   2. 认不出来就不显示。宁可没有环境行，也不要写一行假的。
//   3. 显示顺序固定（地点 · 时间 · 天候），不跟状态栏里的书写顺序走——
//      同一场戏里环境行的读法应该稳定，跳来跳去等于每次都要重读。
//
// 纯函数，无 DOM、无 state：判据有边界（认哪些键、取哪个值），边界要能真跑。

/**
 * 认哪些键。**数组顺序就是环境行的显示顺序**。
 *
 * 用 includes 而不全等：卡作者写「当前地点」「物理位置」「当前位置」
 * 是一回事，没必逼他们统一。代价是「时间」会命中「时间流速」这类
 * 不是环境的东西——但那种键少见，值也短，不致命。
 */
const ENV_KEYS = [
  ["place", ["地点", "位置", "场所", "所在地"]],
  ["time", ["时间", "时刻", "时段"]],
  ["weather", ["天候", "天气", "气候"]],
];

/**
 * 从状态栏原文里挑出环境字段。
 *
 * @param {string} status  splitStatusBlock 切出来的那段（键: 值 清单）
 * @returns {Array<{kind: string, value: string}>} 按 ENV_KEYS 顺序，可能为空
 */
export function envFromStatus(status) {
  const src = String(status ?? "");
  if (!src) return [];

  const found = new Map();
  for (const raw of src.split("\n")) {
    // 星号一律先剥掉：状态栏里 `**任务面板:** {}` 这种写法很常见，把它留给「值」会拼出一个带星号的环境行。
    const line = raw.trim().replace(/\*\*/g, "");
    if (!line) continue;
    // 状态栏的判据是「键: 值」（splitStatusBlock 已经保证过一半以上成立），
    // 这里按同一形状取，键长给到 30 与那边保持一致。
    const m = /^([^:：]{1,30})[:：]\s*(.+)$/.exec(line);
    if (!m) continue;

    const key = m[1].trim();
    // 值里带箭头的表示「这一轮变了」——环境行要的是**现在**，取箭头右边那个
    const val = (m[2].includes("→") ? m[2].split("→").pop() : m[2]).trim();
    if (!val) continue;

    for (const [kind, names] of ENV_KEYS) {
      // 已找到这个字段 → 看下一个 kind（continue，不是 break：
      // break 会跳出整个内层循环，于是一旦认出「地点」，
      // 后面所有行都再也认不出「时间」了）
      if (found.has(kind)) continue;
      if (!names.some((n) => key.includes(n))) continue;
      found.set(kind, val);
      break; // 这个键已经用掉，换下一行
    }
  }

  return ENV_KEYS.filter(([k]) => found.has(k)).map(([k]) => ({ kind: k, value: found.get(k) }));
}

/**
 * 拼成显示用的一行。空数组 → 空串（调用方据此决定要不要渲染）。
 *
 * @param {Array<{kind: string, value: string}>} env
 * @returns {string}
 */
export function envText(env) {
  if (!Array.isArray(env) || !env.length) return "";
  return env.map((e) => (e && e.value ? String(e.value).trim() : "")).filter(Boolean).join(" · ");
}
