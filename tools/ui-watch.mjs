// tools/ui-watch.mjs —— 自己拿浏览器看界面（不依赖宿主的浏览器通道）
//
// 为什么要有它：
//   · 宿主的 `browser` 工具只在 Electron 桌面模式下可用；聊天里那条通道会忽然没有，
//     「我点给你看」这件事不能建在会消失的东西上。
//   · 我自己的界面宿主（tools/ui-host.mjs）只提供 HTTP；要看**渲染出来**的样子，
//     需要一个真浏览器。
//
// 做法：用本机已装的 Chrome（不下载浏览器），playwright-core 从仓库外的
//   `~/.hanako/ephemeral/browserkit/node_modules` 取——**仓库里不留 node_modules**。
//
// 用法：
//   node tools/ui-watch.mjs --flow panels-a                跑一个流程，打印 JSON
//   node tools/ui-watch.mjs --flow look --shot shot.png     顺便截一张图
//   node tools/ui-watch.mjs --probe                         只报页面标题与基本结构
//
// 流程文件（tools/flows/*.js）在**页面里**执行：可以 `await import(相对路径)`，
// 可以读 DOM，最后 `return` 一个能 JSON 化的值。写法与探针页里完全一致。
//
// 前置：先起宿主 `node tools/ui-host.mjs`（默认 8791）。

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : (i >= 0 ? true : dflt);
};

const PORT = process.env.ELECKOI_UI_PORT || "8791";
const PAGE = arg("page") && typeof arg("page") === "string"
  ? arg("page")
  : `http://127.0.0.1:${PORT}/api/apps/eleckoi-tavern/ui/_surface/demo/characters.html?appSurfaceSession=demo`;

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
];

const BROWSEKIT = "C:/Users/Administrator/.hanako/ephemeral/browserkit/node_modules/playwright-core";
const require_ = createRequire(import.meta.url);
let playwright;
try {
  playwright = require_(BROWSEKIT);
} catch (e) {
  console.error(`取不到 playwright-core（${BROWSEKIT}）`);
  console.error(`装它：cd ~/.hanako/ephemeral/browserkit && npm install playwright-core`);
  process.exit(2);
}

const exe = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!exe) {
  console.error("找不到本机 Chrome/Edge");
  process.exit(2);
}

// ── 宿主：没起就自己起，用完收走 ────────────────────────
//
// 不给人工起停留步骤。前几轮这事的教训很具体：后台跑着的宿主
// 会随上一个命令结束被一起收掉，然后下一条命令就撞 ERR_CONNECTION_REFUSED——
// 而那个报错看上去像"界面坏了"。自己起自己收，这类问题一次性消失。
const portOpen = () => new Promise((resolve) => {
  const s = net.connect({ host: "127.0.0.1", port: Number(PORT) }, () => { s.destroy(); resolve(true); });
  s.on("error", () => resolve(false));
  s.setTimeout(400, () => { s.destroy(); resolve(false); });
});

let hostProc = null;
if (!argv.includes("--no-host") && !(await portOpen())) {
  hostProc = spawn(process.execPath, [path.join(ROOT, "tools", "ui-host.mjs")], {
    stdio: "ignore",
    env: process.env,
    detached: false
  });
  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (await portOpen()) { ready = true; break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) {
    console.error(`宿主起不来（端口 ${PORT}）`);
    hostProc.kill();
    process.exit(3);
  }
}

const say = (obj) => console.log(JSON.stringify(obj, null, 1));

try {

const browser = await playwright.chromium.launch({
  executablePath: exe,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"]
});

const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const consoleLines = [];
const pageErrors = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") consoleLines.push(`${m.type()}: ${m.text()}`.slice(0, 200));
});
page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 300)));

const shot = arg("shot", null);
const flowName = arg("flow", null);
const payload = { page: PAGE, flow: flowName || null };

try {
  const resp = await page.goto(PAGE, { waitUntil: "load", timeout: 30000 });
  payload.status = resp ? resp.status() : null;

  if (flowName) {
    const file = path.join(ROOT, "tools", "flows", `${flowName}.js`);
    const src = fs.readFileSync(file, "utf8");
    // 流程文件用顶层 return —— 包成 async IIFE 再在页面里 eval。
    // 包一层还顺手保证了里面的 await 都会被 playwright 等到。
    const wrapped = `(async () => {\n${src}\n})()`;
    payload.result = await page.evaluate((code) => eval(code), wrapped);
  } else {
    payload.probe = await page.evaluate(() => ({
      title: document.title,
      bodyLen: document.body ? document.body.innerHTML.length : 0,
      tabs: [...document.querySelectorAll(".ctx-tab")].map((b) => b.textContent.trim()),
      drawers: [...document.querySelectorAll(".drawer")].map((d) => d.id)
    }));
  }
} catch (e) {
  payload.error = String(e.message).slice(0, 600);
}

if (shot && typeof shot === "string") {
  try {
    // 后台标签会被节流 → 屏上什么都量不出来。这个浏览器是我自己的，
    // 强制把 transition/animation 关掉，量到的就是静态布局。
    await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
    await page.screenshot({ path: shot, fullPage: false });
    payload.shot = shot;
  } catch (e) {
    payload.shotError = String(e.message).slice(0, 200);
  }
}

payload.console = consoleLines.slice(0, 8);
payload.pageErrors = pageErrors.slice(0, 8);

await browser.close();
say(payload);
} finally {
  try { hostProc?.kill(); } catch { /* 已经退了 */ }
}
