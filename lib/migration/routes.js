// lib/migration/routes.js — 迁移工具 HTTP 路由

import fs from "node:fs/promises";
import path from "node:path";
import { route, notFound } from "../respond.js";
import { ensureDir } from "../atomic.js";
import { MigrationExporter } from "./export.js";
import { MigrationImporter } from "./import.js";

/** 文件名安全校验（防路径穿越）。 */
function assertSafeFilename(filename) {
  if (!filename || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    throw new Error("Invalid filename");
  }
  return filename;
}

export function registerMigrationRoutes(app, dataDir) {
  const exporter = new MigrationExporter(dataDir);
  const importer = new MigrationImporter(dataDir);
  const exportDir = path.join(dataDir, "exports");

  // 确保导出目录存在（不阻塞注册）
  ensureDir(exportDir).catch(() => {});

  // 导出完整数据
  app.post("/migration/export", route(async (c) => {
    const { format = "json" } = await c.req.json().catch(() => ({}));
    const data = await exporter.exportAll();

    if (format !== "json") {
      return data;
    }

    const filename = `export-${Date.now()}.json`;
    const filePath = path.join(exportDir, filename);
    await ensureDir(exportDir);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");

    return {
      filename,
      path: filePath,
      characters: data.characters.length,
      conversations: data.conversations.length,
      variables: data.variables.length,
      settings: data.settings.length
    };
  }));

  // 预览导入文件
  app.post("/migration/preview", route(async (c) => {
    const { filePath, content } = await c.req.json();

    if (!filePath && !content) {
      throw new Error("filePath or content is required");
    }

    if (content) {
      return importer.previewData(JSON.parse(content));
    }
    return importer.preview(filePath);
  }));

  // 导入数据
  app.post("/migration/import", route(async (c) => {
    const { filePath, content, skipExisting = false } = await c.req.json();

    if (!filePath && !content) {
      throw new Error("filePath or content is required");
    }

    if (content) {
      return importer.importData(JSON.parse(content), { skipExisting });
    }
    return importer.importFrom(filePath, { skipExisting });
  }));

  // 获取单个导出文件
  app.get("/migration/exports/:filename", route(async (c) => {
    const filename = assertSafeFilename(c.req.param("filename"));
    const filePath = path.join(exportDir, filename);
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch (e) {
      if (e?.code === "ENOENT") throw notFound("Export file not found");
      throw e;
    }
  }));

  // 列出导出文件
  app.get("/migration/exports", route(async () => {
    let files;
    try {
      files = await fs.readdir(exportDir);
    } catch (e) {
      if (e?.code === "ENOENT") return [];
      throw e;
    }

    const out = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const stat = await fs.stat(path.join(exportDir, f));
      out.push({
        filename: f,
        path: path.join(exportDir, f),
        size: stat.size,
        modified: stat.mtime.toISOString()
      });
    }
    return out.sort((a, b) => b.modified.localeCompare(a.modified));
  }));

  // 删除导出文件
  app.delete("/migration/exports/:filename", route(async (c) => {
    const filename = assertSafeFilename(c.req.param("filename"));
    await fs.rm(path.join(exportDir, filename), { force: true });
    return true;
  }));

  // 健康检查
  app.get("/migration/health", route(async () => {
    let exists = false;
    try {
      await fs.access(exportDir);
      exists = true;
    } catch { /* 不存在 */ }

    return { dataDir, exportDir, exportDirExists: exists };
  }));
}
