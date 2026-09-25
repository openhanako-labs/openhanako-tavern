// tools/verify-st-import.mjs —— 拿一份**真的 ST 世界书**验导入这条路
//
// 为什么不能只点界面：「设定库 → 导入 ST」弹的是**原生文件选择框**，
// 自动化里没人能替它选文件——所以"点了没反应"是正常的，
// 而那也意味着**界面这条路永远测不到**。要验就绕过选择框，直接喂接口：
//
//   POST /settings/import-st   （JSON：{ worldBook }）
//
// 注意契约：路由用 `c.req.json()` 读，所以这里必须发 JSON。
// 界面原先是发 multipart 的——两边从来没对上，于是这个功能一直是坏的；
// 这个脚本第一次跑就撞出了那个 400。
//
// 数据落在宿主的临时副本上（%TEMP%\eleckoi-ui-host-data），
// 碰不到你的真数据目录。
//
// 用法：
//   node tools/verify-st-import.mjs "W:/Games/SillyTavern/.../某个世界书.json"
//   不带参数则自动从 ST 的世界书目录里挑一个小的。

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = process.env.ELECKOI_UI_PORT || "8791";
const BASE = `http://127.0.0.1:${PORT}`;

const ST_WORLDS = "W:/Games/SillyTavern/SillyTavern/data/default-user/worlds";

function pickDefault() {
  if (!fs.existsSync(ST_WORLDS)) return null;
  const files = fs.readdirSync(ST_WORLDS)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ f, size: fs.statSync(path.join(ST_WORLDS, f)).size }))
    .filter((x) => x.size > 200 && x.size < 400 * 1024)   // 太大只是慢，不代表更真
    .sort((a, b) => b.size - a.size);
  return files[0] ? path.join(ST_WORLDS, files[0].f) : null;
}

const file = process.argv[2] || pickDefault();
if (!file) {
  console.error("给了个不存在的路径，也没能从 ST 世界书目录里挑到：", process.argv[2] || ST_WORLDS);
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error("文件不存在：", file);
  process.exit(2);
}

const portOpen = () => new Promise((resolve) => {
  const s = net.connect({ host: "127.0.0.1", port: Number(PORT) }, () => { s.destroy(); resolve(true); });
  s.on("error", () => resolve(false));
  s.setTimeout(400, () => { s.destroy(); resolve(false); });
});

let host = null;
try {
  if (!(await portOpen())) {
    host = spawn(process.execPath, [path.join(ROOT, "tools", "ui-host.mjs")], { stdio: "ignore", env: process.env });
    let ready = false;
    for (let i = 0; i < 40; i++) {
      if (await portOpen()) { ready = true; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!ready) throw new Error("宿主起不来");
  }

  const before = (await (await fetch(`${BASE}/__api/settings`)).json())?.data || [];
  const buf = fs.readFileSync(file);
  const worldBook = JSON.parse(buf.toString("utf8"));

  console.log(`  喂入：${path.basename(file)}  ${Math.round(buf.length / 1024)} KB`);
  console.log(`  导入前：${before.length} 条设定`);

  const t0 = Date.now();
  const res = await fetch(`${BASE}/__api/settings/import-st`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ worldBook })
  });
  const text = await res.text();
  console.log(`  HTTP ${res.status}  ${Date.now() - t0}ms`);

  let payload = null;
  try { payload = JSON.parse(text); } catch { /* 非 JSON 就原样打印 */ }
  const data = payload?.data ?? payload;
  if (payload && payload.ok === false) {
    console.log(`  ✗ 失败：${payload.error}`);
  } else {
    console.log(`  回话：新增 ${data?.added ?? "?"}、更新 ${data?.updated ?? "?"}、跳过 ${data?.skipped ?? 0}`);

    const after = (await (await fetch(`${BASE}/__api/settings`)).json())?.data || [];
    console.log(`  导入后：${after.length} 条设定`);

    // 抽查：新进来的条目长什么样——触发词、位置、tier 是 ST 兼容的关键
    const sample = after.slice(-3);
    for (const s of sample) {
      // 打印要贴着真实形状：trigger 是对象、keywords 可能埋在它里面——
      // 上一版直接印 s.trigger 得到了 [object Object]，看上去像导入坏了。
      const trig = typeof s.trigger === "object" && s.trigger !== null
        ? JSON.stringify(s.trigger).slice(0, 70)
        : String(s.trigger ?? "-");
      const kw = Array.isArray(s.keywords) && s.keywords.length > 0
        ? s.keywords.slice(0, 4).join("/")
        : (s.trigger && Array.isArray(s.trigger.keys) ? s.trigger.keys.slice(0, 4).join("/") : "(无)");
      console.log(
        `    · ${String(s.name || "").slice(0, 22)} | anchor=${s.anchor ?? "-"}（position=${JSON.stringify(s.position)}） | tier=${s.tier ?? "(默认)"} | 词=${kw.slice(0, 40)}`
      );
      // 溯源字段也要看：ST 兼容的命脉是“原字段不丢”
      console.log(
        `      source=${s.source ?? "-"} externalId=${s.externalId ?? "-"} enabled=${s.enabled} order=${s.order} 原字段=${s.extensions?._raw ? "保留✓" : "没保留✗"}`
      );
    }
  }
} finally {
  try { host?.kill(); } catch { /* 已经退了 */ }
}
