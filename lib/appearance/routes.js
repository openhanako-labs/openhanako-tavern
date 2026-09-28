// lib/appearance/routes.js — 自定义背景图 HTTP 路由
//
// 6 个端点：
//   GET  /appearance                → 读配置
//   POST /appearance                → 改 veil / blur
//   POST /appearance/image          → 上传新图（multipart，字段 file）
//   POST /appearance/image/clear    → 清图
//   GET  /appearance/image          → 裸图字节，Content-Type 按扩展名
//   GET  /appearance/image.json     → base64 JSON（前端走这个，裸 <img> 不带鉴权 403）
//
// 前 4 个走 route() 包装，返回 { ok:true, data:config }；
// 裸图用 raw() 绕过 JSON 包装直接回二进制；
// image.json 走 route() 包装，返回 { ok:true, data:{ ext,mime,bytes,base64 } }。

import { route, notFound, raw } from '../respond.js';
import { AppearanceRepo } from './repo.js';
import { detectExt, mimeOf, MAX_IMAGE_BYTES } from './model.js';

/**
 * @param {object} app — Hono app 实例
 * @param {string} dataDir — App 数据目录
 */
export function registerAppearanceRoutes(app, dataDir) {
  if (!dataDir) throw new Error('dataDir is required');

  const repo = new AppearanceRepo(dataDir);
  // 启动时建目录；失败不阻断注册，运行时读取会再建。
  repo.init().catch(() => {});

  // ① 读配置
  app.get('/appearance', route(async () => {
    return repo.read();
  }));

  // ② 改 veil / blur。只合并用户明确提供的字段，未提供的保持原值。
  app.post('/appearance', route(async (c) => {
    const body = (await c.req.json().catch(() => ({}))) || {};
    const cur = await repo.read();
    const updates = {};
    if (body.veil !== undefined) updates.veil = body.veil;
    if (body.blur !== undefined) updates.blur = body.blur;
    return repo.write({
      ...cur,
      ...updates,
      updatedAt: new Date().toISOString()
    });
  }));

  // ③ 上传新图（multipart/form-data，字段名 file）
  app.post('/appearance/image', route(async (c) => {
    let form;
    try {
      form = await c.req.formData();
    } catch (e) {
      throw new Error('请求必须是 multipart/form-data');
    }
    const file = form.get('file');
    if (!file || typeof file.arrayBuffer !== 'function') {
      throw new Error('请求里没有 file 字段');
    }

    const buf = Buffer.from(await file.arrayBuffer());

    const ext = detectExt(file.type, file.name);
    if (!ext) {
      throw new Error('不支持的文件类型，只接受：png/jpg/jpeg/webp/gif');
    }
    if (buf.length === 0) {
      throw new Error('上传的文件为空');
    }
    if (buf.length > MAX_IMAGE_BYTES) {
      throw new Error('图太大了，换一张 12MB 以内的');
    }

    return repo.saveImage(buf, ext);
  }));

  // ④ 清图
  app.post('/appearance/image/clear', route(async () => {
    return repo.clearImage();
  }));

  // ⑤ 读图字节（裸流）。没有图 → 404。
  app.get('/appearance/image', route(async () => {
    const img = await repo.getImage();
    if (!img) throw notFound('没有背景图');
    return raw(img.buffer, {
      contentType: img.mime,
      headers: { 'Cache-Control': 'public, max-age=600' }
    });
  }));

  // ⑥ JSON 版：base64。给前端用——裸 <img src> 不会带鉴权，真机 403。
  //   与 /characters/:id/avatar.json 同一形状，前端 apiAvatarBlobUrl 那段逻辑可以复用。
  app.get('/appearance/image.json', route(async () => {
    const img = await repo.getImage();
    if (!img) throw notFound('没有背景图');
    // 与 /characters/:id/avatar.json 同一形状，前端 apiAvatarBlobUrl 的逻辑可以直接复用
    return {
      ok: true,
      ext: img.ext,
      mime: img.mime,
      bytes: img.buffer.length,
      base64: img.buffer.toString('base64')
    };
  }));
}
