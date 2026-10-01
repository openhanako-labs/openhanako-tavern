// test/regression-background.mjs — AI 背景图生成（第 4 期，mock 不真调）
// node test/regression-background.mjs

import { buildBackgroundPrompt, checkNoPerson, guessSceneText, generateBackground, BACKGROUND_DEFAULTS } from "../lib/illustration/background.js";
import { AppearanceRepo } from "../lib/appearance/repo.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  ✅ " + label); }
  else { fail++; console.log("  ❌ " + label); }
}

// ── 提示词构造 ──
{
  const { systemPrompt, userPrompt } = buildBackgroundPrompt("北境哨塔，夜，暴雨");
  ok(systemPrompt.includes("禁止出现任何人物"), "systemPrompt 含禁人物约束");
  ok(systemPrompt.includes("只描述"), "systemPrompt 含只描述环境约束");
  ok(userPrompt === "北境哨塔，夜，暴雨", "userPrompt 是场景原文");
  const clip = buildBackgroundPrompt("x", { style: "clip" });
  ok(clip.systemPrompt.includes("CLIP"), "clip 风格切换");
}

// ── 人物标记词校验 ──
{
  ok(checkNoPerson("stone tower, night, rain").length === 0, "纯环境通过");
  ok(checkNoPerson("stone tower, a girl standing").includes("girl"), "girl 被拒");
  ok(checkNoPerson("人物特写").length > 0, "中文人物词被拒");
  ok(checkNoPerson("human silhouette").length > 0, "silhouette 被拒");
}

// ── 场景文本猜测 ──
{
  const conv = { messages: [
    { role: "user", content: "我环顾四周" },
    { role: "assistant", content: "正文", story: { found: true, story: { scene: "北境哨塔 · 夜 · 雨" }, dialogue: [] } }
  ] };
  ok(guessSceneText(conv) === "北境哨塔 · 夜 · 雨", "剧情卡场景行优先");
  const conv2 = { messages: [
    { role: "assistant", content: "正文", story: { found: true, story: null, dialogue: [{ isNarration: true, text: "雨点敲在结界上。" }] } }
  ] };
  ok(guessSceneText(conv2) === "雨点敲在结界上。", "退化到旁白");
  ok(guessSceneText({ messages: [] }) === null, "空对话 null");
}

// ── generateBackground host 路（mock）──
{
  const pngBytes = Buffer.from("89504e47", "hex");
  const sdk = {};
  const llm = {
    calls: 0,
    async generate() {
      this.calls++;
      // 第一次带人物（拒收），第二次干净（重试逻辑）
      return { content: this.calls === 1 ? "tower, a girl" : "stone tower, night, heavy rain" };
    }
  };
  const resolveTarget = async () => ({});
  const host = {
    async generateImageRaw(_sdk, { prompt }) {
      if (!prompt.includes("wide shot")) throw new Error("提示词没带宽画幅后缀");
      if (prompt.includes("girl")) throw new Error("人物渗漏到出图！");
      return { batchId: "b1" };
    },
    async readProductBytes(_sdk, _raw, _o) { return { ok: true, bytes: pngBytes, mime: "image/png" }; }
  };
  const r = await generateBackground({ sdk, llm, resolveTarget, sceneText: "北境哨塔", config: {}, host });
  ok(r.via === "host", "host 路 via");
  ok(r.bytes.equals(pngBytes), "出图字节回传");
  ok(r.prompt.includes("stone tower, night") && r.prompt.includes("wide shot"), "最终提示词 = 干净提示词 + 宽画幅");
  ok(llm.calls === 2, "首检含人物 → 重试一次");
}

// ── 重试仍含人物 → 报错不花钱 ──
{
  const llm = { async generate() { return { content: "a man in the tower" }; } };
  let threw = false;
  try {
    await generateBackground({ sdk: {}, llm, resolveTarget: async () => ({}), sceneText: "x", config: {}, host: { async generateImageRaw() { throw new Error("不该出图"); } } });
  } catch (e) { threw = e.message.includes("人物"); }
  ok(threw, "重试仍含人物 → 报错且不出图");
}

// ── applyBackground：AppearanceRepo round-trip ──
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eleckoi-bg-"));
  const repo = new AppearanceRepo(dir);
  await repo.init();
  const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001080600000" + "01f15c4890000000a49444154789c6360000002000154a24f0000000049454e44ae426082", "hex");
  const r = await repo.saveImage(png, "png");
  ok(!!r.image, "saveImage 返回配置含 image");
  const cfg = await repo.read();
  ok(cfg.image === r.image, "read 回读一致");
  const img = await repo.getImage();
  ok(img && img.buffer.equals(png), "getImage 回读字节一致（buffer 形状）");
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 默认配置 ──
ok(BACKGROUND_DEFAULTS.enabled === false, "默认关（花钱动作）");

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
