// 追加 rail footer 与 naked class 的样式。
// 前一次追加（弹窗改造）已把主块塞进 CSS 末尾，这里只补 rail.html 引入的
// 几个裸类：.foot / .more / .moremenu / .mnote，以及 .field label .req。
const fs = require("node:fs");

const path = "W:/Games/Hanako/.hanako/apps/eleckoi-tavern/ui/assets/characters.css";
const text = fs.readFileSync(path, "utf8");
if (text.includes("/* === rail footer 补样式 ===")) {
  console.log("already appended, skip");
  process.exit(0);
}
const isCRLF = /\r\n/.test(text.slice(0, 1000));

const block = `
/* === rail footer 补样式（2026-09-28）===
 * 上一段「弹窗改造」把 .sp / .form-sec / .portrait-row / .export-wrap / .gen-phase / .conv-picks /
 * .persona-hint-field 都补齐了。这里补 rail.html 与 label 里剩下几个裸类，避免测试报「写了没接线」。
 */

.field label .req { color: var(--accent); margin-left: 2px; font-weight: 600; }

.foot { display: flex; gap: 6px; padding: 8px 4px 0; }
.foot button {
  flex: 1;
  padding: 7px 6px;
  border-radius: 6px;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--fg);
  font-family: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.foot button.primary {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
.foot button.primary:hover { opacity: .9; }
.foot button:hover:not(.primary) { border-color: var(--accent); color: var(--accent); }
.foot .more { flex: 0 0 auto; width: 30px; padding: 7px 0; font-size: 14px; line-height: 1; }

.moremenu {
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--surface);
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 4px;
  box-shadow: 0 4px 12px rgba(0,0,0,.08);
}
.moremenu button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
  border: none;
  background: none;
  border-radius: 6px;
  color: var(--fg);
  font-family: inherit;
  font-size: 12.5px;
  cursor: pointer;
  text-align: left;
}
.moremenu button:hover { background: var(--accent-soft); color: var(--accent); }
.mnote { font-size: 11px; color: var(--fg-muted); opacity: .8; }
`;

const normalized = text.replace(/\r\n/g, "\n");
const out = normalized + block;
fs.writeFileSync(path, out.replace(/\n/g, isCRLF ? "\r\n" : "\n"));
console.log("appended:", block.length, "chars");
