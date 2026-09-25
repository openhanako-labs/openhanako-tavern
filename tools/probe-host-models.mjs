// tools/probe-host-models.mjs —— 读宿主的模型清单，找 embedding 模型与它的端点
//
// 为什么默认打码：这些文件里有 API key。**任何形似 key 的字段一律打成 ***，
// 需要明文时显式加 --show-secrets（默认不开）。
//
// 要找的两件事：
//   ① 列表里有没有 embedding 模型（App 的注释里说第一项就是 BAAI/bge-m3）
//   ② 它的 provider 指向哪个 base URL —— 这决定了 Python 那边够不够得着

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SHOW = process.argv.includes("--show-secrets");
const HOME = path.join(os.homedir(), ".hanako");

const SECRET_RE = /(key|token|secret|auth|password|credential)/i;
const EMBED_RE = /(embed|embedding|rerank|bge-|bge\/|m3|gte|e5-|text-embedding)/i;

/** 递归找一个对象的潜在端点字段（优先 baseUrl / apiBase / url）。 */
const URL_RE = /(base_?url|api_?base|endpoint|url|host)/i;

function redactValue(k, v) {
  if (typeof v === "string" && SECRET_RE.test(k)) {
    return SHOW ? v : `***（${v.length} 字符，已打码）`;
  }
  return v;
}

function walk(node, visit, trail = []) {
  if (node === null || typeof node !== "object") return;
  visit(node, trail);
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === "object") walk(v, visit, [...trail, k]);
  }
}

function pick(obj, keys) {
  const out = {};
  for (const k of Object.keys(obj)) {
    if (keys.some((p) => p.test(k))) out[k] = redactValue(k, obj[k]);
  }
  return out;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

const modelsPath = path.join(HOME, "models.json");
const catalogPath = path.join(HOME, "provider-catalog.json");
const models = readJson(modelsPath);
const catalog = readJson(catalogPath);

console.log("=== ① 模型清单里带 embed 字样的条目 ===");
let found = 0;
walk(models, (node) => {
  const label = String(node.id ?? node.model ?? node.name ?? "");
  const blob = JSON.stringify(node).slice(0, 400);
  if (!EMBED_RE.test(label) && !EMBED_RE.test(blob)) return;
  found++;
  if (found > 14) return;
  console.log(`  · ${label || "(无名)"}`);
  const bits = pick(node, [/^id$/i, /^name$/i, /^model$/i, /provider/i, /^type$/i, /capab/i, URL_RE]);
  for (const [k, v] of Object.entries(bits)) console.log(`      ${k} = ${typeof v === "string" ? v.slice(0, 120) : JSON.stringify(v).slice(0, 160)}`);
});
if (found === 0) console.log("  （没找到——也许字段名不同，或者 embedding 在别处）");

console.log("\n=== ② provider / 端点 ===");
const prov = catalog ?? models;
walk(prov, (node) => {
  const bits = pick(node, [/^id$/i, /^name$/i, /^provider$/i, URL_RE]);
  const keys = Object.keys(bits);
  if (keys.some((k) => URL_RE.test(k)) && keys.length >= 1) {
    const line = keys.map((k) => `${k}=${String(bits[k]).slice(0, 90)}`).join("  ");
    if (/http/.test(line)) console.log(`  · ${line}`);
  }
});

console.log("\n=== ③ 文件在哪 ===");
for (const p of [modelsPath, catalogPath]) {
  console.log(`  ${fs.existsSync(p) ? "✓" : "✗"} ${p}  ${fs.existsSync(p) ? Math.round(fs.statSync(p).size / 1024) + "KB" : ""}`);
}
if (!SHOW) console.log("\n（key 类字段已打码；要看明文加 --show-secrets）");
