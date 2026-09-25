// lib/characters/routes.js — 角色卡 HTTP 路由
//
// 统一用 route() 包装；头像与 PNG 导出用 raw() 返回二进制。

import { route, raw, notFound } from "../respond.js";
import { detectCardFormat, normalizeCard } from "./formats.js";
import { characterBookToSettings } from "../settings/import.js";

export function registerCharacterRoutes(app, repo, transfer, settingRepo = null) {
  // 列出角色卡
  app.get("/characters", route(async (c) => {
    const list = await repo.list();

    // 支持筛选：q（关键词）、tag（标签）、sort（排序）
    const q = (c.req.query("q") || "").trim().toLowerCase();
    const tag = (c.req.query("tag") || "").trim().toLowerCase();
    const sort = c.req.query("sort") || "updated";

    let out = list;

    if (q) {
      // 列表只有摘要，需要读详情才能搜描述/标签
      const detailed = [];
      for (const item of list) {
        const card = await repo.get(item.id);
        if (!card) continue;
        const hay = [card.name, card.description, card.creator, ...(card.tags || [])]
          .filter(Boolean).join(" ").toLowerCase();
        if (hay.includes(q)) detailed.push({ ...item, tags: card.tags || [], description: card.description });
      }
      out = detailed;
    }

    if (tag) {
      const withTags = [];
      for (const item of out) {
        const card = item.tags ? item : await repo.get(item.id);
        const tags = (card?.tags || []).map(t => String(t).toLowerCase());
        if (tags.includes(tag)) withTags.push({ ...item, tags: card?.tags || [] });
      }
      out = withTags;
    }

    // 排序
    if (sort === "name") {
      out = [...out].sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "zh"));
    } else if (sort === "created") {
      out = [...out].sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    } else {
      out = [...out].sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    }

    // 列表里带上「有没有世界书」。
    //
    // 为什么在这里补：索引里存的是**摘要**（没有 character_book），
    // 所以列表天生看不出哪张卡带书——而用户的原话是“打开角色卡，**对应**世界书”，
    // 第一眼就缺在这里。
    //
    // 代价：按 id 各读一次详情。酒馆的卡通常几十张，一次列表几十次本地读可以接受；
    // 真到几百张时应该把 has_book 写进索引（那时再说，现在不为想象中的规模加复杂度）。
    out = await Promise.all(
      out.map(async (item) => {
        const card = await repo.get(item.id).catch(() => null);
        return { ...item, has_book: !!card?.character_book };
      })
    );

    return out;
  }));

  // 列出所有已用标签（供筛选 UI）
  app.get("/characters/tags", route(async () => {
    const list = await repo.list();
    const counts = new Map();
    for (const item of list) {
      const card = await repo.get(item.id);
      for (const t of (card?.tags || [])) {
        const key = String(t);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }));

  // 获取角色卡详情
  app.get("/characters/:id", route(async (c) => {
    const card = await repo.get(c.req.param("id"));
    if (!card) throw notFound("Character not found");
    // has_avatar：面板要决定“画头像还是画首字母”。
    // 代价是一次头像目录查询（跟列表里补 has_book 同一条理由——
    // 该显示什么不该由前端去猜文件名哪种扩展名）。
    let has_avatar = false;
    try {
      has_avatar = !!(await transfer.readAvatar(card.id));
    } catch { /* 读不到就当没有 */ }
    return { ...card, has_avatar };
  }));

  // 创建角色卡
  app.post("/characters", route(async (c) => {
    const body = await c.req.json();
    return repo.create(body.card || body);
  }));

  // 更新角色卡
  app.put("/characters/:id", route(async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    return repo.update(id, body);
  }));

  // 删除角色卡
  app.delete("/characters/:id", route(async (c) => {
    await repo.delete(c.req.param("id"));
    return true;
  }));

  // 批量删除
  app.post("/characters/batch-delete", route(async (c) => {
    const { ids } = await c.req.json();
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new Error("ids array is required");
    }
    return repo.deleteBatch(ids);
  }));

  // 获取角色头像
  app.get("/characters/:id/avatar", route(async (c) => {
    const id = c.req.param("id");
    const avatar = await transfer.readAvatar(id);
    if (!avatar) throw notFound("No avatar");

    const mime = avatar.ext === "png" ? "image/png"
      : avatar.ext === "webp" ? "image/webp"
      : avatar.ext === "gif" ? "image/gif"
      : "image/jpeg";

    return raw(avatar.buffer, {
      contentType: mime,
      headers: { "Cache-Control": "public, max-age=60" }
    });
  }));

  // 头像的 JSON 版：给“必须带着鉴权取图”的前端用。
  //
  // 为什么需要它：<img src="…/characters/<id>/avatar"> 这条路在真机上被 403 拦下——
  // 请求里连 /_surface/<票据>/ 那一段都没有，而 <img> 不会自己带鉴权。
  // 而 App 的 JSON 通道是通的（同一个 apiFetch 别的调用都在跑），
  // 所以把字节 base64 化走它。这样不依赖宿主 fetch 返回什么形状。
  app.get("/characters/:id/avatar.json", route(async (c) => {
    const id = c.req.param("id");
    const avatar = await transfer.readAvatar(id);
    if (!avatar) throw notFound("No avatar");

    const mime = avatar.ext === "png" ? "image/png"
      : avatar.ext === "webp" ? "image/webp"
      : avatar.ext === "gif" ? "image/gif"
      : "image/jpeg";

    return { ok: true, ext: avatar.ext, mime, bytes: avatar.buffer.length, base64: avatar.buffer.toString("base64") };
  }));

  // 准备导入（文件路径）
  app.post("/characters/import/prepare", route(async (c) => {
    const { files } = await c.req.json();
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error("files array is required");
    }
    return transfer.prepareImport(files);
  }));

  // 解析上传的文件内容（前端 FormData / JSON base64）
  app.post("/characters/import/parse", route(async (c) => {
    const files = await extractUploadFiles(c);
    if (files.length === 0) {
      throw new Error("No files found in request");
    }

    const results = [];
    for (const file of files) {
      try {
        const isPng = transfer.isPng(file.buffer);
        const card = await transfer.parseCard(file.buffer, isPng);
        const format = detectCardFormat(card);
        const normalized = normalizeCard(card);

        results.push({
          name: file.name,
          importable: true,
          format,
          card: normalized,
          // 图片卡：把原图一并带回，供 commit 阶段落盘为头像
          avatarBase64: isPng ? file.buffer.toString("base64") : null,
          avatarExt: isPng ? "png" : null,
          preview: {
            name: normalized.name || "（无名称）",
            description: normalized.description?.slice(0, 100) || "（无描述）",
            has_book: !!normalized.character_book,
            has_alternate_greetings: (normalized.alternate_greetings?.length || 0) > 0
          }
        });
      } catch (e) {
        results.push({ name: file.name, importable: false, error: e.message });
      }
    }

    return results;
  }));

  // 提交导入（支持携带头像数据 + 自动导入卡内世界书）
  app.post("/characters/import/commit", route(async (c) => {
    const body = await c.req.json();
    const { token, items, importCharacterBook = true } = body;

    // 优先走前端回传的 items（含头像 base64）
    if (Array.isArray(items) && items.length > 0) {
      const results = [];
      for (const item of items) {
        try {
          const saved = await repo.create(item.card || item);

          if (item.avatarBase64) {
            await transfer.saveAvatar(
              saved.id,
              Buffer.from(item.avatarBase64, "base64"),
              item.avatarExt || "png"
            );
          }

          // 卡内世界书 → 设定库（不做这一步，卡的一半设定就丢了）。
          // 走 importCharacterBook：改卡再导不会在库里堆出一串重复条目。
          let bookResult = null;
          if (importCharacterBook && settingRepo && saved.character_book) {
            const settings = characterBookToSettings(saved.character_book, {
              source: "character_book"
            });
            if (settings.length > 0) {
              bookResult = await settingRepo.importCharacterBook(saved.id, settings);
            }
          }

          results.push({ name: item.name, success: true, id: saved.id, characterBook: bookResult });
        } catch (e) {
          results.push({ name: item.name, success: false, error: e.message });
        }
      }
      return results;
    }

    if (!token) throw new Error("token or items is required");
    return transfer.commitImport(token);
  }));

  // 取消导入
  app.post("/characters/import/discard", route(async (c) => {
    const { token } = await c.req.json();
    if (!token) throw new Error("token is required");
    transfer.discardImport(token);
    return true;
  }));

  // 给已存在的角色卡补导卡内世界书。
  //
  // 场景：建卡时 settingRepo 还没接上（旧数据）、或当时关掉了
  // "importCharacterBook"，之后想补——之前只能手工逐条重建。
  // replace=true 时先清掉该角色旧条目再导，改卡重导不堆重复。
  app.post("/characters/:id/import-book", route(async (c) => {
    const id = c.req.param("id");
    if (!settingRepo) throw new Error("设定库未就绪");

    const card = await repo.get(id);
    if (!card) throw notFound("Character not found");
    if (!card.character_book) {
      return { added: 0, removed: 0, skipped: [], total: 0, note: "该角色卡未内嵌世界书" };
    }

    const body = await c.req.json().catch(() => ({}));
    const settings = characterBookToSettings(card.character_book, {
      source: "character_book"
    });
    if (settings.length === 0) {
      return { added: 0, removed: 0, skipped: [], total: 0, note: "世界书为空" };
    }

    if (body.replace) {
      const r = await settingRepo.importCharacterBook(id, settings);
      return { ...r, format: "character_book", total: settings.length };
    }

    for (const s of settings) s.characterId = id;
    const r = await settingRepo.importSettings(settings);
    return { ...r, removed: 0, format: "character_book", total: settings.length };
  }));

  // 导出角色卡（json / st-v2 / st-v3 / png）
  app.get("/characters/:id/export/:format", route(async (c) => {
    const id = c.req.param("id");
    const format = c.req.param("format");
    const content = await transfer.exportCard(id, format);

    if (format === "json" || format === "st-v2" || format === "st-v3") {
      return JSON.parse(content);
    }

    // PNG：返回二进制
    return raw(content, { contentType: "image/png" });
  }));
}

/** 从请求中提取上传的文件（支持 multipart 与 JSON base64）。 */
async function extractUploadFiles(c) {
  const contentType = c.req.header("Content-Type") || "";
  const files = [];

  if (contentType.includes("application/json")) {
    const body = await c.req.json();
    for (const f of (body.files || [])) {
      if (f?.data) {
        files.push({ name: f.name || `file-${Date.now()}`, buffer: Buffer.from(f.data, "base64") });
      }
    }
    return files;
  }

  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    for (const [, value] of formData.entries()) {
      if (value && typeof value.arrayBuffer === "function") {
        const buffer = Buffer.from(await value.arrayBuffer());
        files.push({ name: value.name || `file-${Date.now()}`, buffer });
        continue;
      }
      if (typeof value === "string" && value.length > 100 && !value.includes("{")) {
        try {
          files.push({ name: `file-${Date.now()}`, buffer: Buffer.from(value, "base64") });
        } catch { /* 不是 base64，跳过 */ }
      }
    }
  }

  return files;
}
