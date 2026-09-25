// lib/tts/routes.js — 语音合成的 HTTP 面
//
// 四个口子，各自只做一件事：
//   GET  /tts/providers  有哪些水龙头可选、默认是哪家（给设置面板画选项）
//   GET  /tts/config     当前配置（**密钥只回有没有，不回原文**）
//   PUT  /tts/config     改配置（空串 = 清空那一条）
//   POST /tts/speak      要一段声音（落盘 → 回一个能播的地址）
//   GET  /tts/audio/:n   把那段声音发出去
//
// 为什么 speak 要先落盘再回地址，而不是直接把音频字节回给前端：
// 消息流里的"朗读"按钮、以后可能的"整场播放"，都要能拿到一个稳定的 URL；
// 直接把字节塞进 JSON（base64）会让响应体积翻三分之一，还得在前端再做一次解码。

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { route, notFound, raw } from "../respond.js";
import { readConfig, writeConfig, mergeConfig, publicConfig } from "./config.js";
import { synthesize, TEXT_MAX } from "./service.js";
import { PROVIDERS, DEFAULT_PROVIDER } from "./providers.js";

/** 只允许我们自己写出来的名字。音频路由直接映射到磁盘路径，这是那道门。 */
const NAME_RE = /^[a-z0-9-]{6,64}\.(mp3|wav|ogg|webm)$/i;

const MIME_BY_EXT = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  webm: "audio/webm"
};

export function registerTtsRoutes(app, { sdk = null, dataDir = null } = {}) {
  const outDir = dataDir ? path.join(dataDir, "generated", "tts") : null;

  const needDataDir = () => {
    if (!outDir) throw new Error("语音合成未就绪（App 数据目录不可用）");
    return outDir;
  };

  app.get("/tts/providers", route(async () => ({
    default: DEFAULT_PROVIDER,
    textMax: TEXT_MAX,
    providers: PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      hint: p.hint,
      needsKey: p.needsKey,
      needsRegion: p.needsRegion,
      defaultVoice: p.defaultVoice,
      defaultBaseUrl: p.defaultBaseUrl || "",
      voices: p.voices
    }))
  })));

  app.get("/tts/config", route(async () => {
    needDataDir();
    return publicConfig(await readConfig(dataDir));
  }));

  app.put("/tts/config", route(async (c) => {
    needDataDir();
    const patch = (await c.req.json().catch(() => ({}))) || {};
    const prev = await readConfig(dataDir);
    const next = mergeConfig(prev, patch);
    await writeConfig(dataDir, next);
    // 回的是**公开形状**：密钥不进响应体
    return publicConfig(next);
  }));

  app.post("/tts/speak", route(async (c) => {
    const out = needDataDir();
    const body = (await c.req.json().catch(() => ({}))) || {};
    const text = String(body.text ?? "").trim();
    if (!text) throw new Error("text is required");

    const cfg = await readConfig(dataDir);
    const r = await synthesize({ config: cfg, text, sdk });

    await fs.mkdir(out, { recursive: true });
    const name = `${crypto.randomUUID()}.${r.ext}`;
    await fs.writeFile(path.join(out, name), r.buffer);

    return {
      ok: true,
      name,
      url: `tts/audio/${name}`,
      mime: r.mime,
      bytes: r.buffer.length,
      provider: r.provider,
      voice: r.voice,
      chars: r.chars,
      // 超长被截断时要说出来——否则用户以为后半段被吞了
      ...(r.truncated ? { truncated: r.truncated, note: `文本超过 ${TEXT_MAX} 字，只读了前 ${TEXT_MAX} 字` } : {})
    };
  }));

  app.get("/tts/audio/:name", route(async (c) => {
    const out = needDataDir();
    const name = String(c.req.param("name") || "");
    if (!NAME_RE.test(name)) throw notFound("No such audio");

    let buf;
    try {
      buf = await fs.readFile(path.join(out, name));
    } catch {
      throw notFound("No such audio");
    }
    const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    return raw(buf, {
      contentType: MIME_BY_EXT[ext] || "audio/mpeg",
      headers: { "Cache-Control": "private, max-age=300" }
    });
  }));
}
