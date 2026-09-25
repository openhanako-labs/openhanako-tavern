// tools/flows/panels-c.js —— 最后四个面板的主要动作
//
// 角色编辑弹窗（顺便验证 showEditForm 那次改动没有伤到它）、迁移、导入 ST、群聊。
// 老规矩：不猜 id，按下去再回头核对状态；找不到就把可见的东西列出来。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = document.createElement("style");
st.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
document.head.appendChild(st);
window.__errs = window.__errs || [];
window.addEventListener("error", (e) => window.__errs.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) =>
  window.__errs.push("unhandled: " + String((e.reason && e.reason.message) || e.reason)));
await sleep(900);

const state = (await import(new URL("./assets/modules/state.js", location.href).href)).state;
const chars = await import(new URL("./assets/modules/characters.js", location.href).href);
const shell = await import(new URL("./assets/modules/shell.js", location.href).href);

const out = {};
const visible = (el) => !!(el && el.offsetParent !== null);
const overlays = () => [...document.querySelectorAll('div[style*="position:fixed"], div[style*="position: fixed"]')];
const toasts = () => [...document.querySelectorAll(".toast")].map((t) => t.textContent.trim());

// ── ① 角色编辑弹窗 ─────────────────────────────────────
const charId = state.charList?.[0]?.id || "2d4512f6-e7c5-46b2-aab0-805149802cc1";
const before = await (await fetch(`/__api/characters/${charId}`)).json();
const beforeName = (before?.data || before)?.name;

await chars.openCharacterEditor?.(charId);
await sleep(700);

const form = document.getElementById("character-form");
out["① 角色表单可见"] = visible(form);
if (visible(form)) {
  const fields = [...form.querySelectorAll("input,textarea,select")]
    .filter((i) => i.type !== "hidden" && visible(i))
    .map((i) => `${i.id || i.name || "?"}=${String(i.value || "").slice(0, 14)}`);
  out["① 可见字段"] = fields.slice(0, 8);
  out["① 字段数"] = fields.length;

  // 改一个字段再存，核对后端（存完改回去）
  const nameEl = document.getElementById("f-name");
  out["① 名字框"] = nameEl ? nameEl.id : "(没找到 f-name)";
  if (nameEl) {
    nameEl.value = `${beforeName}·探针`;
    const saveBtn = [...document.querySelectorAll("button")]
      .filter((b) => b.offsetParent !== null)
      .find((b) => /保存|确定/.test(b.textContent || "") && !/取消/.test(b.textContent));
    out["① 点的是"] = saveBtn ? saveBtn.textContent.trim() : null;
    saveBtn?.click();
    await sleep(1000);
    const after = await (await fetch(`/__api/characters/${charId}`)).json();
    out["① 保存后名字"] = (after?.data || after)?.name;

    // 还原
    const back = await fetch(`/__api/characters/${charId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: beforeName })
    });
    out["① 还原"] = back.status;
  }
} else {
  out["① 可见按钮"] = [...document.querySelectorAll("button")].filter((b) => b.offsetParent !== null)
    .map((b) => `${b.id || "." + b.className}:${(b.textContent || "").trim().slice(0, 8)}`).slice(-12);
}

// ── ② 迁移 ─────────────────────────────────────────────
shell.openDrawer("migration");
await sleep(800);
const mig = document.getElementById("drawer-migration");
out["② 迁移面板"] = mig ? (mig.innerText || "").replace(/\s+/g, " ").trim().slice(0, 220) : "(找不到)";
out["② 迁移按钮"] = mig ? [...mig.querySelectorAll("button")].map((b) => b.textContent.trim()).slice(0, 10) : [];

// ── ③ 导入 ST ──────────────────────────────────────────
shell.openDrawer("settings");
await sleep(600);
document.getElementById("import-st-btn")?.click();
await sleep(700);
const imp = document.getElementById("import-modal");
out["③ 导入弹窗可见"] = visible(imp);
out["③ 导入弹窗内容"] = imp ? (imp.innerText || "").replace(/\s+/g, " ").trim().slice(0, 200) : null;
out["③ 有文件输入吗"] = !!document.getElementById("st-import-input");

// ── ④ 群聊：界面给了入口吗 / 引擎支持吗 ─────────────────
out["④ 界面里的群聊字样"] = [...document.querySelectorAll("button,div,span")]
  .filter((e) => /群聊|多角色|多人物/.test(e.textContent || "") && e.children.length === 0)
  .map((e) => e.textContent.trim().slice(0, 20)).slice(0, 5);
// 引擎侧：建一个多角色对话看它认不认
const convRes = await fetch("/__api/conversations", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ characterIds: [charId, charId] })
});
out["④ 多角色建对话状态"] = convRes.status;
out["④ 多角色建对话回话"] = (await convRes.text()).slice(0, 160);

out["toast"] = toasts().slice(-3);
out["页面报错"] = (window.__errs || []).slice(0, 5);
return out;
