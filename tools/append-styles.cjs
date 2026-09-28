// 向 characters.css 末尾追加一段样式。
// 该文件是 CRLF（151KB+），不能整文件重写。这里读字节、切 CRLF、追加、写回。
const fs = require("node:fs");

const path = "W:/Games/Hanako/.hanako/apps/eleckoi-tavern/ui/assets/characters.css";
const raw = fs.readFileSync(path);
const text = raw.toString("utf8");
const isCRLF = /\r\n/.test(text.slice(0, 1000));
if (!isCRLF) throw new Error("expected CRLF");

const normalized = text.replace(/\r\n/g, "\n");
if (normalized.includes("/* === 弹窗改造（2026-09-28）===")) {
  console.log("already appended, skip");
  process.exit(0);
}

const block = `
/* === 弹窗改造（2026-09-28）===
 * 一次改了：编辑弹窗 5 表单分段、AI 生成三阶段、小弹窗页脚统一、宿主左栏。
 * 都追加在末尾——不动前面 4800+ 行的原有规则。
 */

/* 通用：flex 内占位符（把右侧按钮组推向右边） */
.sp { flex: 1 1 auto; }

/* 编辑弹窗表单：分段 */
.form-sec { padding: 12px 0; }
.form-sec + .form-sec { border-top: 1px solid var(--border); }
.form-sec:first-child { padding-top: 0; }
.form-sec:last-child { padding-bottom: 0; }

.fs-head {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 0 6px;
  font-size: 12px; color: var(--fg-muted);
  letter-spacing: .02em;
  cursor: default;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  font-family: inherit;
}
.fs-head .fs-t { font-weight: 600; color: var(--fg); }
.fs-head .fs-h { color: var(--fg-muted); font-size: 11.5px; }
.fs-head .fs-n {
  margin-left: auto;
  padding: 2px 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 10.5px;
  color: var(--fg-muted);
}
.fs-head .fs-car {
  display: inline-block;
  transition: transform .15s ease-out;
  transform: rotate(90deg);
  font-size: 11px;
  color: var(--fg-muted);
}
.form-sec.collapsed .fs-head { cursor: pointer; }
.form-sec.collapsed .fs-head .fs-car { transform: rotate(0); }
.form-sec.collapsed .fs-body { display: none; }

/* 角色卡的头像与生成立绘 */
.portrait-row {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  margin-bottom: 12px;
}
.portrait-slot {
  flex: 0 0 60px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.portrait-btn {
  width: 100%;
  min-width: 60px;
  height: 60px;
  padding: 6px 4px;
  line-height: 1.2;
  font-size: 11px;
  color: var(--fg-muted);
  background: var(--surface-2, rgba(0,0,0,.03));
  border: 1px dashed var(--border-strong);
  border-radius: 8px;
  cursor: pointer;
}
.portrait-btn:hover { color: var(--accent); border-color: var(--accent); }
.pf { flex: 1; min-width: 0; }

/* 导出下拉（把 JSON 与 ST 合成一个入口） */
.export-wrap { position: relative; display: inline-block; }
.export-menu {
  position: absolute;
  right: 0;
  bottom: 100%;
  margin-bottom: 4px;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,.12);
  padding: 6px;
  min-width: 200px;
  z-index: 20;
}
.export-menu .em-lb {
  font-size: 10.5px;
  color: var(--fg-muted);
  padding: 4px 8px 6px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 4px;
}
.export-menu .em-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 7px 10px;
  border-radius: 6px;
  border: none;
  background: none;
  color: var(--fg);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
}
.export-menu .em-item:hover { background: var(--accent-soft, rgba(220,146,60,.12)); }

/* AI 生成：三阶段（idle / running / done） */
.gen-phase { animation: gp-fade .18s ease-out; }
@keyframes gp-fade { from { opacity: 0; } to { opacity: 1; } }

/* idle 阶段：整屏给那一个问题 */
.bigq { margin-bottom: 14px; }
.bigq .field input { font-size: 15px; padding: 10px 12px; }
.bigq-examples {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 6px;
  margin-bottom: 8px;
}
.bigq-examples b {
  font-weight: 400;
  font-size: 11.5px;
  padding: 3px 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--fg-muted);
  cursor: pointer;
  background: transparent;
}
.bigq-examples b:hover { color: var(--accent); border-color: var(--accent); }
.bigq-hint { margin-top: 4px; }

.gen-params {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  align-items: end;
}

/* running 阶段：进度条 + 分步日志 */
.gen-prog { margin-bottom: 14px; }
.gp-bar {
  height: 6px;
  background: var(--border);
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 8px;
}
.gp-bar > i {
  display: block;
  height: 100%;
  background: var(--accent);
  width: 0;
  transition: width .5s ease;
}
.gp-tx {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.gp-t1 { font-weight: 600; font-size: 14px; color: var(--fg); }
.gp-t2 { font-size: 12px; color: var(--fg-muted); flex: 1; min-width: 100px; }
.gp-n { font-size: 11.5px; color: var(--fg-muted); margin-left: auto; }

/* 分步日志：每一步都是「做了什么 + 花了多久」 */
.gen-log {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  overflow: hidden;
}
.glr {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}
.glr:last-child { border-bottom: none; }
.glr-dot {
  flex: 0 0 auto;
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--fg-muted);
  transform: translateY(-1px);
}
.glr.done .glr-dot { background: var(--success, #2ea043); }
.glr.bad .glr-dot { background: var(--danger, #d73a49); }
.glr-tx { flex: 1; color: var(--fg-dim); }
.glr.done .glr-tx { color: var(--fg); }
.glr-ms {
  flex: 0 0 auto;
  font-size: 11.5px;
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}

/* done 阶段：结果占屏 */
.gen-hint {
  margin-bottom: 10px;
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--surface-2, rgba(0,0,0,.03));
  font-size: 12px;
  color: var(--fg-muted);
}
.gen-hint:empty { display: none; }

/* 新对话：卡片点选（替掉原生 select multiple） */
.conv-picks {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 280px;
  overflow-y: auto;
  padding: 2px;
}
.conv-pick {
  display: grid;
  grid-template-columns: 34px 1fr auto 20px;
  gap: 10px;
  align-items: center;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  cursor: pointer;
  user-select: none;
}
.conv-pick:hover { border-color: var(--border-strong); }
.conv-pick.selected {
  border-color: var(--accent);
  background: var(--accent-soft, rgba(220,146,60,.08));
}
.conv-pick .cp-av {
  width: 34px; height: 34px;
  border-radius: 8px;
  background: var(--surface-2, rgba(0,0,0,.06));
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 600;
  color: var(--fg-muted);
}
.conv-pick.selected .cp-av {
  background: var(--accent);
  color: #fff;
}
.conv-pick .cp-nm {
  font-size: 13.5px;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conv-pick .cp-ct {
  font-size: 12px;
  color: var(--fg-muted);
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
}
.conv-pick .cp-ck {
  font-size: 14px;
  color: var(--accent);
  opacity: 0;
  transition: opacity .15s ease;
}
.conv-pick.selected .cp-ck { opacity: 1; }

/* persona-modal 的 hint 单独一行 */
.persona-hint-field { margin-bottom: 14px; }

/* 必填标记（与老版 label 直接写 <span class="req"> 对齐） */
.field label .req { color: var(--accent); margin-left: 2px; font-weight: 600; }

/* 宿主左栏 rail.html 的底部两行（页脚 2 + ⋯ 菜单）。
 * rail.html 自包含在宿主左栏里，字符集小、不能依赖 characters.css 里那些大弹窗的样式。
 * 这里只把新增的四五个类名收齐，不重复 rail.html 自己的 CSS（它有自己的 h2 / .item 规则）。 */
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

const out = normalized + block;
fs.writeFileSync(path, out.replace(/\n/g, "\r\n"));
console.log("appended:", block.length, "chars");
