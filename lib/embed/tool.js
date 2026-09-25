// lib/embed/tool.js — 给 Agent 用的 embedding 工具（也是实验台的那座桥）
//
// 为什么要走工具而不是 HTTP：宿主把 App 的 HTTP 面锁在鉴权之后，
// 但**工具不用**——工具本来就是给我（Agent）调的。
// 所以"用宿主的模型算向量"这件事，从工具这条路走最短。
//
// 返回值刻意**不含完整向量**：一次 18 条 × 1024 维能把上下文撑爆。
// 想要完整的就传 `file`，它会把向量写到 App 数据目录里，回一个路径给我。
// 摘要里给几个指纹数字，够判断"这不是空数组"。

import fs from "node:fs/promises";
import path from "node:path";

import { embed, status } from "./service.js";

function text(s) {
  return { content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] };
}

function guard(fn) {
  return async (args) => {
    try {
      return text(await fn(args || {}));
    } catch (e) {
      return text(`Error: ${e?.message || String(e)}`);
    }
  };
}

/** 只取几位小数当指纹——用来确认"真的算出来了"，不泄露整条向量。 */
function fingerprint(v, n = 4) {
  return v.slice(0, n).map((x) => Number(Number(x).toFixed(4)));
}

export function createEmbedTools({ sdk, dataDir }) {
  const bus = () => sdk?.bus;

  return [
    {
      name: "tavern_embed_status",
      description:
        "检查这个 App 能不能用宿主里的 embedding 模型（只查不动手：找模型 → 取凭据）。" +
        "用来分辨「没授权 / 没模型 / 端点不通」这三种失败。",
      parameters: { type: "object", properties: {} },
      execute: guard(() => status(bus()))
    },
    {
      name: "tavern_embed",
      description:
        "用宿主自己的 embedding 模型把文本算成向量（凭据由宿主现场发，不经手任何人）。" +
        "默认只回摘要与指纹；给 file 就把完整向量写成 JSON 落到 App 数据目录，回文件路径。",
      parameters: {
        type: "object",
        properties: {
          texts: {
            type: "array",
            items: { type: "string" },
            description: "要算的文本列表"
          },
          model: {
            type: "string",
            description: "想用的模型名（可选；不给就用宿主目录里第一个 embedding 模型，例如 BAAI/bge-m3）"
          },
          file: {
            type: "string",
            description: "把完整向量写到 App 数据目录下的这个文件名（可选）。只许文件名，不许带路径。"
          }
        },
        required: ["texts"]
      },
      execute: guard(async (args) => {
        const texts = Array.isArray(args.texts) ? args.texts : [];
        if (texts.length === 0) {
          throw new Error("texts 为空——没有要算的文本");
        }

        const r = await embed(bus(), texts, { model: args.model || null });

        const summary = {
          providerId: r.providerId,
          model: r.model,
          dimension: r.dimension,
          count: r.vectors.length,
          candidates: r.candidates,
          // 前两条的前 4 维：看得出"不是空的、也不是全零"
          fingerprint: r.vectors.slice(0, 2).map((v) => fingerprint(v))
        };

        if (args.file) {
          // 只许文件名：不然工具就成了"往任意路径写东西"的口子。
          const name = path.basename(String(args.file));
          const dest = path.join(dataDir, name);
          const payload = {
            model: r.model,
            providerId: r.providerId,
            dimension: r.dimension,
            createdAt: new Date().toISOString(),
            items: texts.map((t, i) => ({ text: t, vector: r.vectors[i] }))
          };
          await fs.mkdir(dataDir, { recursive: true });
          await fs.writeFile(dest, JSON.stringify(payload), "utf8");
          summary.file = dest;
          summary.bytes = Buffer.byteLength(JSON.stringify(payload));
        } else {
          summary.note = "完整向量没回传（会撑爆上下文）。要文件就再调一次，带上 file 参数。";
        }

        return summary;
      })
    }
  ];
}
