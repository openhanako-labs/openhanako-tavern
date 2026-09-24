// 一次性：删页内侧栏（aside 22-74 + sidebar-expand 78-79，行号从大到小）
import fs from "node:fs";
const F = "W:/Games/Hanako/.hanako/apps/eleckoi-tavern/ui/characters.html";
const lines = fs.readFileSync(F, "utf8").split(/\r?\n/);

// 验证锚点（0-based: aside 21..73, expand 77..78）
if (!/<aside id="sidebar"/.test(lines[21]) || !/<\/aside>/.test(lines[73])) {
  console.log("锚点失配：", JSON.stringify(lines[21]), JSON.stringify(lines[73]));
  process.exit(1);
}
if (!/sidebar-expand/.test(lines[78] || "")) {
  console.log("expand 锚点失配：", JSON.stringify(lines[77]), JSON.stringify(lines[78]));
  process.exit(1);
}

lines.splice(77, 2);          // 78-79: 注释 + expand 按钮
lines.splice(21, 74 - 21);    // 22-74: aside 整块（此时行号未受前删影响，77>74）

fs.writeFileSync(F, lines.join("\n"));
console.log(`删侧栏完成，剩 ${lines.length} 行`);
