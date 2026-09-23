// test/check-macro-twin.mjs — 宏引擎双胞胎镜像必须逐字节一致（常驻）
//
// 浏览器只可达 /ui/ 暴露域，服务端用 lib/ 的那份——两份分家是被迫的，
// 但"两个真源"是危险的。这个测试把它降级成"一个真源 + 一个被监控的镜像"：
// 任何一份改了没同步，这里就红。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const APP = path.resolve(import.meta.dirname, "..");
const A = path.join(APP, "lib/macros/index.js");
const B = path.join(APP, "ui/assets/lib/macros.js");

const hash = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex").slice(0, 16);

const ha = hash(A), hb = hash(B);
const same = ha === hb;

console.log(`  lib/macros/index.js    ${ha}`);
console.log(`  ui/assets/lib/macros.js ${hb}`);

if (same) {
  console.log("✅ 双胞胎一致");
  process.exit(0);
}
console.log("❌ 两份宏引擎已经分家——改了 A 记得同步 B（或反之）");
process.exit(1);
