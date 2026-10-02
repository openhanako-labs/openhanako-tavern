// 直连测试：Edge 朗读合成一句中文，确认链路真实可通
import { edgeSynthesize } from "../lib/tts/edge.js";
import fs from "node:fs/promises";

const t0 = Date.now();
try {
  const r = await edgeSynthesize({
    config: { rate: "" },
    text: "夜色落在城墙上，我在这里守夜。",
    voice: "zh-CN-XiaoxiaoNeural"
  });
  const out = "W:/Games/Hanako/Work/.tmp/edge-test.mp3";
  await fs.writeFile(out, r.buffer);
  console.log(`OK ${r.mime} ${r.buffer.length} bytes in ${Date.now() - t0}ms -> ${out}`);
  // 带语速再跑一遍，确认 rate 透传不炸
  const r2 = await edgeSynthesize({ config: { rate: "-10%" }, text: "语速慢一档。", voice: "zh-CN-YunxiNeural" });
  console.log(`rate test OK ${r2.buffer.length} bytes`);
} catch (e) {
  console.error("FAIL:", e.message);
  process.exit(1);
}
