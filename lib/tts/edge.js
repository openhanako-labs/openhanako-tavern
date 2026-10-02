// lib/tts/edge.js — 第三根管子：Edge 朗读（免费、无凭据）
//
// ## 为什么它不走 HTTP 那条路
//
// edge-tts 复用的是 Edge 浏览器"大声朗读"的接口：一条 WebSocket，
// 出场要自带 Sec-MS-GEC token（微软 2024 年加的门禁）。它不是 REST，
// buildRequest + fetch 那套形状套不上去——所以在 synthesize() 里单独分流。
// 协议细节（token 生成、WSS 地址）由 msedge-tts 包扛：微软哪天改门禁，
// 升级那个包就是修，不用动这里以及任何上层。
//
// ## 用户要做什么：什么都不填
//
// 没有账号、没有 key、没有地址。选 provider + 选声音就是全部配置——
// 这也是它和另外两根管子的本质区别：那两根是"用户灌水"，这根是"自带水井"。
//
// ## 稳定性预期（写进 hint 的话，这里不再重复）
//
// 免费接口没有 SLA。最常见的两种死法都翻译成了人话：
//   · 403 —— token 门禁变了（或本机系统时钟偏差太大），等包更新或换供应商
//   · 连不上 —— 网络到不了微软（代理/防火墙）

import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

const FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;

function who(e) {
  return e?.cause?.code || e?.cause?.message || e?.code || e?.message || String(e);
}

/**
 * 用 Edge 朗读接口合成一段语音。返回音频字节；落盘是路由的事。
 *
 * @param {{config: object, text: string, voice?: string}} args
 * @returns {Promise<{buffer: Buffer, mime: string, ext: string, voice: string}>}
 */
export async function edgeSynthesize({ config, text, voice = "" }) {
  const v = String(voice || "").trim() || "zh-CN-XiaoxiaoNeural";

  let tts;
  try {
    tts = new MsEdgeTTS();
    await tts.setMetadata(v, FORMAT);
  } catch (e) {
    const detail = who(e);
    throw new Error(
      /403/.test(detail)
        ? `Edge 朗读被拒（403）：token 门禁可能变了（本机系统时钟偏差太大也会这样），等 msedge-tts 包更新或换回其他供应商`
        : `Edge 朗读连不上（${detail}）——检查网络能不能到微软；免费接口没有 SLA，失灵时换回其他供应商即可`
    );
  }

  // 语速：配置里的 "-10%" / "+20%" 与包的 ProsodyOptions.rate 同一种 SSML 写法，直接透传
  const rate = String(config?.rate || "").trim();
  const opts = rate ? { rate } : undefined;

  try {
    // toStream 是同步返回：拿到 Readable 后自己收尾
    const { audioStream } = tts.toStream(text, opts);
    const chunks = [];
    for await (const chunk of audioStream) chunks.push(Buffer.from(chunk));
    const buffer = Buffer.concat(chunks);
    if (!buffer.length) throw new Error("回了 0 字节——不是成功");
    return { buffer, mime: "audio/mpeg", ext: "mp3", voice: v };
  } catch (e) {
    throw new Error(`Edge 合成失败（${who(e)}）：声音名 ${v} 可能不存在，或文本里有无法朗读的内容`);
  } finally {
    try { tts.close(); } catch { /* 已断的 socket 关不掉不是错 */ }
  }
}
