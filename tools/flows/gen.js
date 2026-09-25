// tools/flows/gen.js —— 生成台：弹窗真的能开、结果真的渲染出来
//
// 为什么必须有这条：静态接线检查只能证明「id 对得上」，
// 证明不了「弹窗一打开是空白的」「列表渲染时抛错」这类事。
// 而生成台的前端一次都没真跑过——那正是它最可能烂掉的地方。
//
// 这条流程喂一份**假快照**（真跑要模型与出网，那不是验 DOM 该付的代价），
// 然后逐项问 DOM：三段在不在、卡名在不在、条目勾选框数对不对、
// 出处链在不在、越界计数有没有出现在提示里。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];
window.addEventListener("error", (e) => errs.push(String(e.message)));

const gen = await import(new URL("./assets/modules/gen.js", location.href).href);

const out = {};
out["弹窗初始"] = document.getElementById("gen-modal")?.classList.contains("hidden") ? "隐藏（对）" : "一开始就露着（错）";

gen.openGen();
await sleep(400);

const modal = document.getElementById("gen-modal");
out["打开后可见"] = modal && !modal.classList.contains("hidden") ? "是" : "否（错）";
out["三段标题"] = [...document.querySelectorAll("#gen-modal .gen-sec > h3")].map((h) => h.textContent.replace(/\s+/g, " ").trim());

// 来源体检是异步的（要真打两个站点），等它落地再读——
// 不等的话只能看到“体检中…”，而那一句什么也证明不了。
const srcBox = document.getElementById("gen-sources");
for (let i = 0; i < 60; i++) {
  const t = (srcBox?.innerText || "").trim();
  if (t && !t.includes("体检中")) break;
  await sleep(500);
}
out["来源体检（真打）"] = (srcBox?.innerText || "").replace(/\s+/g, " ").trim();
out["来源体检·圆点颜色"] = [...document.querySelectorAll("#gen-sources .gen-src")].map(
  (el) => `${el.textContent.trim().slice(0, 18)} → ${getComputedStyle(el).color}`
);

// 喂一份假快照（形状与 GET /gen/jobs/:id 的 data 一致）
const snap = {
  id: "gen-probe",
  query: "未来歌姬",
  state: "done",
  phase: "done",
  detail: "完成",
  notes: [
    { source: "moegirl", label: "萌娘百科", ok: true, count: 2 },
    { source: "arxiv", label: "arXiv", ok: false, note: "出网未就绪" }
  ],
  counts: { docs: 2, facts: 2, droppedFacts: 1, entries: 2, droppedSentences: 1 },
  error: null,
  result: {
    card: {
      name: "初音未来",
      description: "初音未来是 Crypton Future Media 开发的歌声合成软件。",
      personality: "活泼",
      scenario: "录音室",
      first_mes: "「今天也一起唱吧。」",
      mes_example: "",
      creator_notes: "",
      tags: ["歌声合成"]
    },
    book: {
      entries: [
        { name: "初音未来", keys: ["初音未来", "初音"], content: "初音未来是歌声合成软件。", position: "before_char" },
        { name: "录音室", keys: ["录音室"], content: "录音室里有台老合成器。", position: "before_char" }
      ]
    },
    facts: [
      { fact: "初音未来是 Crypton Future Media 开发的歌声合成软件。", source: { url: "https://zh.moegirl.org.cn/x", title: "初音未来", tier: "community" } }
    ],
    materials: [{ url: "https://zh.moegirl.org.cn/x", title: "初音未来" }],
    dropped: { facts: 1, entries: 0, sentences: 1, samples: ["她其实是个外星人。"] }
  }
};

gen.renderJobSnapshot(snap);
await sleep(200);

const text = (id) => (document.getElementById(id)?.innerText || "").replace(/\s+/g, " ").trim();

out["过程·阶段行"] = text("gen-progress");
out["过程·来源成败"] = text("gen-notes");
out["结果·卡名"] = document.querySelector(".gen-card-name")?.textContent.trim() || "(没有)";
out["结果·开场白在不在"] = text("gen-result").includes("今天也一起唱吧") ? "在" : "不在（错）";
out["结果·条数"] = document.querySelectorAll(".gen-entry").length;
out["结果·勾选框数"] = document.querySelectorAll(".gen-entry-ck").length;
out["结果·默认全选"] = [...document.querySelectorAll(".gen-entry-ck")].every((c) => c.checked) ? "是" : "否（错）";
out["结果·出处链"] = document.querySelector(".gen-src-link")?.getAttribute("href") || "(没有)";
out["结果·提示（越界计数）"] = text("gen-hint");
out["越界内容有没有混进列表"] = text("gen-result").includes("外星人") ? "混进来了（错）" : "没有（对）";
out["按钮"] = {
  保存: document.getElementById("gen-save")?.classList.contains("hidden") ? "藏着的（错）" : "露出来了",
  生成: document.getElementById("gen-submit")?.classList.contains("hidden") ? "藏起来（对）" : "还露着"
};

// 取消一条勾选：逐条可弃
document.querySelectorAll(".gen-entry-ck")[1].click();
out["取消第二条后勾选数"] = [...document.querySelectorAll(".gen-entry-ck")].filter((c) => c.checked).length;

gen.closeGen();
await sleep(100);
out["关掉后可见"] = modal.classList.contains("hidden") ? "隐藏（对）" : "还露着（错）";

// 控制台里两个 404——把它们是谁问出来（别猜，读 resource timing 的 responseStatus）
out["404/空响应 的请求"] = performance
  .getEntriesByType("resource")
  .filter((r) => r.responseStatus >= 400)
  .map((r) => `${r.responseStatus} ${r.name.replace(location.origin, "")}`);
out["gen/sources 的真实响应"] = (() => {
  const e = performance.getEntriesByType("resource").find((r) => r.name.includes("gen/sources"));
  return e ? `${e.responseStatus} ${e.name.replace(location.origin, "")}` : "（没发出去 / 没记录）";
})();

out["页面报错"] = errs.length ? errs : "无";

return out;
