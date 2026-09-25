// lib/media/tool.js — 给 Agent 用的「把画好的图放回角色卡」
//
// 两个键名都错过一次（2026-09-25），都是一类的：**没照着活得好的邻居抄形状**。
//
//   1. `execute` 写成了 `handler` → 宿主拿到 undefined 执行器
//      → `toolExecutors.set(handleId, undefined)` → 报 `no tool executor for hXX`。
//      阴险处：**工具在目录里照样列得出来**（name/description 都注册成功），只是永远调不动。
//   2. `parameters` 写成了 `inputSchema` → 宿主兵底成空 schema
//      → **参数对模型完全不可见**，而且一声不响。
//
// 对照：同仓 `lib/probe/tools.js`、`lib/embed/tool.js` 用的是 `parameters` +
// `execute`，它们一直好用。写新工具组时先看一眼那份形状，比读文档快。
//
// 为什么需要它：出图这条路有两条腿。
//   宿主媒体面（sdk.media）由 App 自己调，产物由 App 自己落盘——这条已经通了。
//   但"用别的 App 出图"（比如本机 ComfyUI）那条，产物是**我这边**生成的：
//   我有 comfyui 工具、有 media_generate-image，能拿到本地图片文件，
//   却没有任何办法把它写进某张角色卡——App 的头像只能由 App 自己写。
//   这个工具就是那道缺口。
//
// 接口刻意收**本地路径**而不是收提示词：
//   收提示词就等于让 App 去猜用哪个引擎、哪套参数出图，而那是调用方的事；
//   收路径则责任清楚——画什么、用什么画、画成什么样，都是递文件的人负责。
//   这与 tavern_draft_card 收 material 不收关键词是同一条理由。

import fs from "node:fs/promises";
import { isAbsolutePath } from "./service.js";

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

/** 头像文件大小上限。真立绘一两 MB，12 MB 已经宽得不像话——
 *  但比"默默接受一个 80 MB 的文件塞进卡目录"好。 */
const MAX_BYTES = 12 * 1024 * 1024;

const EXT_RE = /\.([a-z0-9]+)$/i;

/**
 * @param {{characterRepo: object|null, transfer: object|null}} deps
 */
export function createMediaTools({ characterRepo = null, transfer = null } = {}) {
  return [
    {
      name: "tavern_apply_avatar",
      description: [
        "把**本地已有的图片文件**设为某张角色卡的头像。",
        "用法：先用别的引擎画好（例如本机 ComfyUI 的 comfyui 工具，或 media_generate-image），",
        "拿到本地文件路径，再调这里写进卡。",
        "选它而不是让 App 自己出图：出什么图由调用方负责，这里只负责落盘。",
        "路径必须是绝对路径；扩展名不在 png/webp/gif/jpg/jpeg 里会被当成 png。"
      ].join(""),
      parameters: {
        type: "object",
        properties: {
          characterId: { type: "string", description: "角色卡 id" },
          path: { type: "string", description: "图片的本地绝对路径（例如 ComfyUI 的输出文件）" }
        },
        required: ["characterId", "path"]
      },
      execute: guard(async (args) => {
        const id = String(args.characterId || "").trim();
        const file = String(args.path || "").trim();
        if (!id) throw new Error("characterId is required");
        if (!file) throw new Error("path is required");
        if (!characterRepo) throw new Error("角色仓储未就绪");
        if (!transfer) throw new Error("角色转移层未就绪");

        if (!isAbsolutePath(file)) {
          throw new Error(`path 必须是本地绝对路径（收到的是「${file.slice(0, 120)}」）`);
        }

        const card = await characterRepo.get(id);
        if (!card) throw new Error(`Character not found: ${id}`);

        let stat;
        try {
          stat = await fs.stat(file);
        } catch (e) {
          // 别吞原因：含糊的“读不到”就是债。这条报错文案本身曾经把
          // “文件不在”和“没权限”蒙在同一句话里，排查时白跑了一轮。
          const why = e?.code || e?.name || String(e);
          throw new Error(`读不到这个文件（${why}）：${file}`);
        }
        if (!stat.isFile()) throw new Error(`这不是一个文件：${file}`);
        if (stat.size === 0) throw new Error("文件是空的");
        if (stat.size > MAX_BYTES) {
          throw new Error(`文件太大（${Math.round(stat.size / 1024 / 1024)} MB > ${MAX_BYTES / 1024 / 1024} MB）`);
        }

        let buf;
        try {
          buf = await fs.readFile(file);
        } catch (e) {
          const why = e?.code || e?.name || String(e);
          throw new Error(`文件读得进来，内容读不出来（${why}）：${file}`);
        }
        const saved = await transfer.saveAvatar(id, buf, EXT_RE.exec(file)?.[1] || "png");
        const ext = (EXT_RE.exec(saved)?.[1] || "png").toLowerCase();

        return {
          ok: true,
          characterId: id,
          name: card.name || "",
          file: saved,
          avatarExt: ext,
          bytes: buf.length,
          source: file
        };
      })
    }
  ];
}
