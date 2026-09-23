// tools/assemble.mjs — 把恢复物组装回 App 目录，并报告缺口
//
// 策略：
//   1. write 的全文优先落盘（那是完整内容）
//   2. read 的片段落到 <文件>.read.txt 作参考，不冒充源码（有截断）
//   3. edit-log 应用于「write 已覆盖」的文件，把最终态推到最新
//   4. 扫 import 语句，报告指向不存在文件的断链

import fs from "node:fs";
import path from "node:path";

const APP = "W:/Games/Hanako/.hanako/apps/eleckoi-tavern";
const WRITES = "W:/Games/Hanako/Work/已分类/工作/代码/tavern-recovered";
const READS = "W:/Games/Hanako/Work/已分类/工作/代码/tavern-reads";
const EDIT_LOG = "W:/Games/Hanako/Work/已分类/工作/代码/tavern-edit-log.json";

// 一次性 patch 脚本：用后即删的，不该回到源码树
const TRANSIENT = /^(test\/)?(patch-|fix-|extract-|assemble|probe-)/;

let restored = 0, skippedTransient = 0, appliedEdits = 0, failedEdits = 0;

// ── 1. write 全文 ──
const manifest = JSON.parse(fs.readFileSync(path.join(WRITES, "_manifest.json"), "utf8"));
for (const m of manifest) {
  if (TRANSIENT.test(m.rel)) { skippedTransient++; continue; }
  const src = path.join(WRITES, m.rel);
  if (!fs.existsSync(src)) continue;
  const dest = path.join(APP, m.rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, fs.readFileSync(src, "utf8"));
  restored++;
}

// ── 2. read 片段（另存参考，不覆盖已有源码） ──
const readManifest = JSON.parse(fs.readFileSync(path.join(READS, "_manifest.json"), "utf8"));
let readRefs = 0;
for (const m of readManifest) {
  const safe = m.rel.replace(/[\\/]/g, "__") + ".read.txt";
  const src = path.join(READS, safe);
  if (!fs.existsSync(src)) continue;
  const dest = path.join(APP, "_recovery", m.rel.replace(/[\\/]/g, "__") + ".read.txt");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, fs.readFileSync(src, "utf8"));
  readRefs++;
}

// ── 3. edit 应用到已还原的文件 ──
const edits = JSON.parse(fs.readFileSync(EDIT_LOG, "utf8"));
for (const e of edits) {
  if (TRANSIENT.test(e.rel)) continue;
  const file = path.join(APP, e.rel);
  if (!fs.existsSync(file)) continue;
  let text = fs.readFileSync(file, "utf8");
  for (const ed of e.edits) {
    if (typeof ed?.oldText !== "string" || typeof ed?.newText !== "string") continue;
    if (text.includes(ed.oldText)) {
      text = text.replace(ed.oldText, ed.newText);
      appliedEdits++;
    } else {
      failedEdits++;
    }
  }
  fs.writeFileSync(file, text);
}

console.log(`\n组装完成`);
console.log(`  write 全文落盘: ${restored} 个`);
console.log(`  跳过一次性脚本: ${skippedTransient} 个`);
console.log(`  read 参考片段: ${readRefs} 个 → _recovery/`);
console.log(`  edit 应用成功: ${appliedEdits} 处`);
console.log(`  edit 未能应用（原文件缺失或已变）: ${failedEdits} 处`);

// ── 4. 断链扫描 ──
console.log(`\n断链扫描（import 指向不存在的文件）\n` + "─".repeat(60));
const missing = new Map();
function scan(abs) {
  let src; try { src = fs.readFileSync(abs, "utf8"); } catch { return; }
  for (const m of src.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
    let spec = m[1];
    let target = path.resolve(path.dirname(abs), spec);
    if (!/\.[a-z]+$/i.test(target)) target += ".js";
    if (!fs.existsSync(target)) {
      const rel = path.relative(APP, target).replace(/\\/g, "/");
      if (!missing.has(rel)) missing.set(rel, []);
      missing.get(rel).push(path.relative(APP, abs).replace(/\\/g, "/"));
    }
  }
}
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "_recovery") walk(p); }
    else if (/\.(js|mjs)$/.test(e.name)) scan(p);
  }
}
walk(APP);

if (missing.size === 0) console.log("  无断链");
else {
  for (const [target, users] of [...missing.entries()].sort()) {
    console.log(`  ❌ ${target}`);
    console.log(`      被引用: ${users.slice(0, 4).join(", ")}${users.length > 4 ? ` 等 ${users.length} 处` : ""}`);
  }
}

const files = [];
(function count(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== "_recovery" && e.name !== ".git") count(p); }
    else files.push(p);
  }
})(APP);
console.log(`\nApp 现有文件: ${files.length} 个`);
