// lib/media/tool.js — 给 Agent 用的「把画好的图放回角色卡」
//
// 名字说明：这个工具叫 tavern_apply_avatar，不叫 tavern_set_avatar。
// 改名不是审美——是绕宿主的一个 bug：
//   服务器的工具表按 handleId 存、**按名字取第一条**；App 每次重载拿到新一代
//   handleId，而上一代的执行器已随卸载消失，但服务器从未被告知（App 宿主是被重启的，
//   不走 ToolsDispose 登出）。于是“按名字取第一条”拿到的是**上一代那个没人接的编号**，
//   报 `no tool executor for hXX`，重启也治不好（只是又造一代新编号，旧条目仍排前面）。
//   换个名字，新名字下只有当前这一代，取第一条就是活的。
//   （这条在 2026-09-25 实测：h13/h14 就是那两个卡死的旧名字。）
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
      inputSchema: {
        type: "object",
        properties: {
          characterId: { type: "string", description: "角色卡 id" },
          path: { type: "string", description: "图片的本地绝对路径（例如 ComfyUI 的输出文件）" }
        },
        required: ["characterId", "path"]
      },
      handler: guard(async (args) => {
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
        } catch {
          throw new Error(`读不到这个文件：${file}`);
        }
        if (!stat.isFile()) throw new Error(`这不是一个文件：${file}`);
        if (stat.size === 0) throw new Error("文件是空的");
        if (stat.size > MAX_BYTES) {
          throw new Error(`文件太大（${Math.round(stat.size / 1024 / 1024)} MB > ${MAX_BYTES / 1024 / 1024} MB）`);
        }

        const buf = await fs.readFile(file);
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
