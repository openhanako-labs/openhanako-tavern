// lib/settings/routes.js — 设定库 HTTP 路由
//
// 统一用 route() 包装：业务函数只写逻辑，响应形状与错误处理由框架统一。

import { route, notFound } from "../respond.js";
import { getActiveSettings, injectSettings, shouldTrigger } from "./model.js";
import { stWorldBookToSettings, characterBookToSettings } from "./import.js";
import { settingsToStWorldBook } from "./export.js";
import { guessCategory } from "./autocat.js";

export function registerSettingRoutes(app, settingRepo, conversationRepo, categoryStore = null, characterRepo = null) {
  // 列出所有设定。
  //   ?characterId=xxx → 该角色条目 + 全局条目（UI 分级展示用）
  //   ?scope=global    → 只看全局条目
  app.get("/settings", route(async (c) => {
    const characterId = (c.req.query("characterId") || "").trim();
    const scope = (c.req.query("scope") || "").trim();

    if (scope === "global") {
      const all = await settingRepo.list();
      return all.filter(s => !s.characterId);
    }
    if (characterId) {
      return settingRepo.listForCharacter(characterId);
    }
    return settingRepo.list();
  }));

  /*
   * 导出为 SillyTavern 世界书。
   *
   * 与 /settings/import-st 对称的另一半：进得来、出得去，才叫兼容。
   * 在此之前世界书是**只进不出**的——导进来看看可以，想拿回老酒馆用就不行。
   *
   * 挑条目的判据和列表页一致（本卡的 + 全局的）。不一致的话，
   *「屏幕上看到的」和「导出去的」会变成两批东西，而两边都不报错。
   *
   * 位置在 /settings/:id 之前：那条是通配，放在它后面这条会被当成一个 id。
   */
  app.get("/settings/export-st", route(async (c) => {
    const characterId = (c.req.query("characterId") || "").trim();
    const scope = (c.req.query("scope") || "").trim();

    const all = await settingRepo.list();
    let picked;
    if (scope === "global") {
      picked = all.filter(s => !s.characterId);
    } else if (characterId) {
      picked = all.filter(s => !s.characterId || String(s.characterId) === characterId);
    } else {
      picked = all;
    }

    const name = (c.req.query("name") || "").trim();
    const worldBook = settingsToStWorldBook(picked, name ? { name } : {});
    return { worldBook, total: picked.length, format: "sillytavern" };
  }));

  /*
   * 类目表 CRUD。单独一组路由，而不是把字段塞进 /settings/:id：
   *   1. 类目表有自己的生命周期（新建 / 并 / 改 / 删），与单条设定 CRUD 正交
   *   2.「并到」要连锁改 settings.json，两步原子，不宜拆开给 UI 拼
   *   3. UI 类目弹层会一次列全，GET 直接返数组最简洁
   *
   * 位置在 /settings/:id **之前**——Hono 的路由按注册顺序匹配，
   * `:id` 是通配符，放后头 /settings/categories 就被当成 id="categories" 吞掉了。
   */
  if (categoryStore) {
    // 列出所有类目 + 每个的条目数。弹层里的「角色 · 12」就靠这个数。
    app.get("/settings/categories", route(async () => {
      const names = await categoryStore.list();
      const items = [];
      for (const n of names) items.push({ name: n, count: await categoryStore.count(n) });
      // 未分类也需要一个数——弹层里一眼看到「未分类还有 N 条」
      const all = await settingRepo.list();
      const uncategorized = all.filter(s => !String(s?.category || "").trim()).length;
      return { items, uncategorized };
    }));

    app.post("/settings/categories/add", route(async (c) => {
      const { name } = await c.req.json();
      await categoryStore.add(name);
      return categoryStore.list();
    }));

    app.post("/settings/categories/rename", route(async (c) => {
      const { from, to } = await c.req.json();
      return categoryStore.rename(from, to);
    }));

    app.post("/settings/categories/merge", route(async (c) => {
      const { from, to } = await c.req.json();
      return categoryStore.merge(from, to);
    }));

    app.post("/settings/categories/remove", route(async (c) => {
      const { name } = await c.req.json();
      return categoryStore.remove(name);
    }));
  }

  /*
   * 同场角色候选：为角色抽屉的「同场角色」块供数据。
   *
   * 为什么放在 /settings/:id **之前**：路由匹配按顺序走，
   * :id 是通配符，一旦先注册「cast-candidates」这条会被当成一个 id
   * 去查设定表——查不到就 404，而它本来是个列表接口。
   *
   * 返回形状：
   *   self   —— 当前对话的主角（不在可选项里，只是一条事实）
   *   books  —— 别的世界书，只列标了 category="角色" 的条目；空书不返回
   *
   * 数据现状（2026-09-27）：真库 106 条 category 全空/不存在，
   * 所以 books 会返回 []——这是预期的空态，不是 bug。
   * 前端会显示解释性文案而不是空白或报错。
   */
  app.get("/settings/cast-candidates", route(async (c) => {
    const characterId = String(c.req.query("characterId") || "").trim();
    if (!characterId) throw notFound("characterId is required");

    // 主角本身：不在候选名单里，只是 UI 顶上一条事实陈述
    const selfCard = characterRepo
      ? await characterRepo.get(characterId).catch(() => null)
      : null;
    if (!selfCard) throw notFound(`Character not found: ${characterId}`);
    const self = {
      characterId,
      name: String(selfCard.name || "（无名称）").trim()
    };

    const all = settingRepo ? await settingRepo.list() : [];
    // 按 world book（characterId）分组
    const byBook = new Map();
    for (const s of all) {
      const bookId = String(s.characterId || "").trim();
      if (!bookId) continue;                     // 全局条目：不进任何组
      if (bookId === characterId) continue;      // 自己那本：不列
      if (!byBook.has(bookId)) byBook.set(bookId, []);
      byBook.get(bookId).push(s);
    }

    // 每本只取 category === "角色" 的条目；没有角色条目的书不返回
    const books = [];
    for (const [bookId, entries] of byBook) {
      const chars = entries
        .filter(s => String(s.category || "").trim() === "角色")
        .map(s => ({
          id: s.id,
          name: String(s.name || s.comment || "").trim() || "（无名称）",
          description: String(s.description || "").trim()
        }));
      if (chars.length === 0) continue;
      const bookCard = characterRepo
        ? await characterRepo.getSummary(bookId).catch(() => null)
        : null;
      if (!bookCard) continue;                    // 书已经被删：不列
      books.push({
        characterId: bookId,
        name: String(bookCard.name || "（无名称）").trim(),
        characters: chars
      });
    }

    return { self, books };
  }));

  // 获取设定详情
  app.get("/settings/:id", route(async (c) => {
    const setting = await settingRepo.get(c.req.param("id"));
    if (!setting) throw notFound("Setting not found");
    return setting;
  }));

  // 创建设定
  app.post("/settings", route(async (c) => {
    return settingRepo.create(await c.req.json());
  }));

  // 更新设定
  app.put("/settings/:id", route(async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    return settingRepo.update(id, body);
  }));

  // 删除设定
  app.delete("/settings/:id", route(async (c) => {
    await settingRepo.delete(c.req.param("id"));
    return true;
  }));

  // 启用/禁用设定
  app.put("/settings/:id/toggle", route(async (c) => {
    const id = c.req.param("id");
    const { enabled } = await c.req.json();
    return settingRepo.toggle(id, enabled);
  }));

  // 批量导入设定
  app.post("/settings/import", route(async (c) => {
    const { settings } = await c.req.json();
    if (!Array.isArray(settings)) {
      throw new Error("settings array is required");
    }
    return settingRepo.importSettings(settings);
  }));

  // 获取活跃设定（基于上下文）
  app.post("/settings/active", route(async (c) => {
    const { text, variables, characterId, characterName, characterTags } = await c.req.json();
    const context = { text: text || "" };
    return settingRepo.getActive(context, variables, characterId
      ? { characterId, characterName, characterTags }
      : null);
  }));

  /*
   * 自动分类：对全库跑一遍启发式（lib/settings/autocat.js），
   * 只写回高置信的三类（组织 / 系统 / 地点），其余留空。
   *
   * 为什么做成 POST 而不是自动跑：
   *   106 条里猜错的条目用户要花一小时改。启发式不是判据，是初判——
   *   什么时候跑由用户控（点了「自动分类」按钮），而不是他不知道的时候。
   *
   * 默认只写**空串位**：用户已经手填过的类目不该被启发式覆盖。
   */
  app.post("/settings/autocategorize", route(async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const onlyEmpty = body?.onlyEmpty !== false; // 默认 true
    const all = await settingRepo.list();
    let filled = 0, skipped = 0;
    for (const s of all) {
      const cur = String(s.category || "").trim();
      const guess = guessCategory(s);
      if (!guess) { skipped++; continue; }
      if (onlyEmpty && cur) { skipped++; continue; }
      if (cur === guess) { skipped++; continue; }
      await settingRepo.update(s.id, { category: guess });
      filled++;
    }
    return { filled, skipped, total: all.length };
  }));

  // 测试设定触发
  app.post("/settings/test", route(async (c) => {
    const { text, variables, settingId } = await c.req.json();
    const context = { text: text || "" };

    if (settingId) {
      const setting = await settingRepo.get(settingId);
      if (!setting) throw notFound("Setting not found");
      return { triggered: shouldTrigger(setting, context) };
    }

    const all = await settingRepo.list();
    const active = getActiveSettings(all, context, variables);
    return { active: active.map(s => ({ id: s.id, name: s.name })) };
  }));

  // 注入设定到系统提示
  app.post("/settings/inject", route(async (c) => {
    const { systemPrompt, text, variables } = await c.req.json();
    const context = { text: text || "" };
    const active = await settingRepo.getActive(context, variables);
    return {
      result: injectSettings(systemPrompt || "", active),
      activeCount: active.length
    };
  }));

  // 导入 SillyTavern 世界书
  app.post("/settings/import-st", route(async (c) => {
    const { worldBook } = await c.req.json();

    const settings = stWorldBookToSettings(worldBook, { source: "sillytavern" });
    if (settings.length === 0) {
      throw new Error("No importable entries found in world book");
    }

    const result = await settingRepo.importSettings(settings);
    return { ...result, format: "sillytavern", total: settings.length };
  }));

  // 导入角色卡内嵌的 character_book（ST 卡的设定就存在这里）
  app.post("/settings/import-character-book", route(async (c) => {
    const { characterBook, characterId, replace = false } = await c.req.json();

    const settings = characterBookToSettings(characterBook, { source: "character_book" });
    if (settings.length === 0) {
      return { added: 0, skipped: [], removed: 0, total: 0, note: "该角色卡未内嵌世界书" };
    }

    // 有角色归属时走 importCharacterBook：先清旧再导，重复导入不堆重复条目。
    if (characterId && replace) {
      const result = await settingRepo.importCharacterBook(characterId, settings);
      return { ...result, format: "character_book", total: settings.length };
    }

    if (characterId) {
      for (const s of settings) s.characterId = characterId;
    }

    const result = await settingRepo.importSettings(settings);
    return { ...result, removed: 0, format: "character_book", total: settings.length };
  }));
}
