// test/regression-appearance.mjs — 自定义背景图模块回归
//
// 反证说明（改坏必红）：
//   ① model.normalizeAppearance 夹取范围写错（如 veil 上限写成 1.0）
//      → 夹取测试直接红
//   ② model.detectExt 白名单漏掉某个类型（如忘了 gif）
//      → detectExt 测试红
//   ③ repo.saveImage 没删旧图（只覆盖 config 不清盘）
//      → 目录里多文件测试红
//   ④ repo.clearImage 没把 image 置 null
//      → 清图后 config.image === null 测试红
//   ⑤ routes GET /appearance/image 没有图时没抛 404
//      → 无图 404 测试红
//   ⑥ routes POST /appearance/image 对超大文件没拦
//      → 超 12 MB 拒绝测试红
//   ⑦ 首次读 config（文件不存在）没返回默认值
//      → 首次读测试红
//   ⑧ POST /appearance 用户没提供 veil 时误用默认值覆盖原值
//      → 部分更新保留原值测试红

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const {
  normalizeAppearance, detectExt, mimeOf, newImageFilename,
  DEFAULTS, LIMITS, ALLOWED_EXTS, MAX_IMAGE_BYTES
} = await import('../lib/appearance/model.js');
const { AppearanceRepo } = await import('../lib/appearance/repo.js');
const { registerAppearanceRoutes } = await import('../lib/appearance/routes.js');

// ── 微型 Hono mock：捕获 handler 调用，记录 c.json / c.body ──
class MockApp {
  constructor() { this.handlers = {}; }
  _reg(m, p, h) { this.handlers[`${m} ${p}`] = h; }
  get(p, h)    { this._reg('GET',    p, h); }
  post(p, h)   { this._reg('POST',   p, h); }
  put(p, h)    { this._reg('PUT',    p, h); }
  delete(p, h) { this._reg('DELETE', p, h); }
  _get(m, p)   { return this.handlers[`${m} ${p}`]; }
}

function makeContext(opts = {}) {
  const req = {
    json: async () => opts.json || {},
    formData: async () => opts.formData,
    header: (n) => opts.headers?.[n] || null,
    query:  (k) => opts.query?.[k] || '',
    param:  (k) => opts.params?.[k] || '',
  };
  return {
    req,
    _result: null,
    json(data, status) {
      this._result = { kind: 'json', data, status: status || 200 };
      return this._result;
    },
    body(body, status, headers) {
      this._result = { kind: 'body', body, status: status || 200, headers: headers || {} };
      return this._result;
    }
  };
}

let pass = 0;
const failed = [];
async function okAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed.push(name);
    console.error(`  ❌ ${name}\n     ${e?.stack?.split('\n').slice(0, 3).join('\n     ') || e}`);
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tavern-appearance-'));
const dataDir = path.join(tmp, 'data');
await fs.mkdir(dataDir, { recursive: true });
const appearanceDir = path.join(dataDir, 'appearance');

// ══════════════════════════════════════════════════════════════════════
// Model 层：纯函数
// ══════════════════════════════════════════════════════════════════════

await okAsync('①a 空输入返回默认值（veil=0.78, blur=0, image=null）', () => {
  const r = normalizeAppearance({});
  assert.equal(r.veil, 0.78);
  assert.equal(r.blur, 0);
  assert.equal(r.image, null);
  assert.equal(typeof r.updatedAt, 'string');
  assert.ok(r.updatedAt.length > 0);
});

await okAsync('①b veil 低于下限 0.75 → 夹到 0.75', () => {
  assert.equal(normalizeAppearance({ veil: 0.1 }).veil, 0.75);
  assert.equal(normalizeAppearance({ veil: -1 }).veil, 0.75);
  assert.equal(normalizeAppearance({ veil: 0.7 }).veil, 0.75);
});

await okAsync('①c veil 高于上限 0.99 → 夹到 0.99', () => {
  assert.equal(normalizeAppearance({ veil: 1.5 }).veil, 0.99);
  assert.equal(normalizeAppearance({ veil: 100 }).veil, 0.99);
  assert.equal(normalizeAppearance({ veil: 1.0 }).veil, 0.99);
});

await okAsync('①d veil 在范围内保持原值', () => {
  assert.equal(normalizeAppearance({ veil: 0.75 }).veil, 0.75);
  assert.equal(normalizeAppearance({ veil: 0.75 }).veil, 0.75);
  assert.equal(normalizeAppearance({ veil: 0.99 }).veil, 0.99);
});

await okAsync('①e blur 负数 → 0；过大 → 24；小数四舍五入', () => {
  assert.equal(normalizeAppearance({ blur: -5 }).blur, 0);
  assert.equal(normalizeAppearance({ blur: 100 }).blur, 24);
  assert.equal(normalizeAppearance({ blur: 3.5 }).blur, 4);
  assert.equal(normalizeAppearance({ blur: 3.4 }).blur, 3);
  assert.equal(normalizeAppearance({ blur: 0 }).blur, 0);
  assert.equal(normalizeAppearance({ blur: 24 }).blur, 24);
});

await okAsync('①f veil/blur 非数字 → 用默认值', () => {
  assert.equal(normalizeAppearance({ veil: 'abc' }).veil, 0.78);
  assert.equal(normalizeAppearance({ blur: null }).blur, 0);
  assert.equal(normalizeAppearance({ veil: NaN }).veil, 0.78);
  assert.equal(normalizeAppearance({ blur: Infinity }).blur, 0);
});

await okAsync('①g image 空串/空白 → null；合法串保留并 trim', () => {
  assert.equal(normalizeAppearance({ image: '' }).image, null);
  assert.equal(normalizeAppearance({ image: '   ' }).image, null);
  assert.equal(normalizeAppearance({ image: null }).image, null);
  assert.equal(normalizeAppearance({ image: '  bg-123.png  ' }).image, 'bg-123.png');
});

await okAsync('①h updatedAt 合法串保留，非法/缺省 → 新时间戳', () => {
  const iso = '2026-01-01T00:00:00.000Z';
  assert.equal(normalizeAppearance({ updatedAt: iso }).updatedAt, iso);
  const fresh = normalizeAppearance({ updatedAt: '' }).updatedAt;
  assert.ok(fresh !== '', '空串应被替换为新时间戳');
  assert.ok(fresh !== iso, '不是同一个值');
});

// ── detectExt ──
await okAsync('②a content-type 优先于文件名', () => {
  assert.equal(detectExt('image/png',  'photo.jpg'), 'png');
  assert.equal(detectExt('image/jpeg', 'photo.png'), 'jpeg');
  assert.equal(detectExt('image/webp', 'photo.gif'), 'webp');
  assert.equal(detectExt('image/gif',  'photo.webp'), 'gif');
});

await okAsync('②b content-type 缺失 → 退回文件名', () => {
  assert.equal(detectExt('', 'photo.png'),  'png');
  assert.equal(detectExt(null, 'photo.jpg'), 'jpg');
  assert.equal(detectExt(undefined, 'photo.webp'), 'webp');
  assert.equal(detectExt('', 'photo.gif'), 'gif');
  assert.equal(detectExt('', 'photo.jpeg'), 'jpeg');
});

await okAsync('②c 不支持的类型（txt/svg/exe/bmp）→ null', () => {
  assert.equal(detectExt('text/plain', 'photo.txt'), null);
  assert.equal(detectExt('image/svg+xml', 'photo.svg'), null);
  assert.equal(detectExt('', 'photo.exe'), null);
  assert.equal(detectExt('', 'photo.bmp'), null);
  assert.equal(detectExt('', 'noext'), null);
  assert.equal(detectExt('', 'photo.tar.gz'), null);
});

await okAsync('②d content-type 带 charset 也能解析', () => {
  assert.equal(detectExt('image/png; charset=utf-8', 'x'), 'png');
});

await okAsync('②e content-type 大小写不敏感', () => {
  assert.equal(detectExt('IMAGE/PNG', 'x'), 'png');
  assert.equal(detectExt('Image/Jpeg', 'x'), 'jpeg');
});

// ── mimeOf / newImageFilename / 常量 ──
await okAsync('③ mimeOf 映射正确', () => {
  assert.equal(mimeOf('png'),  'image/png');
  assert.equal(mimeOf('jpg'),  'image/jpeg');
  assert.equal(mimeOf('jpeg'), 'image/jpeg');
  assert.equal(mimeOf('webp'), 'image/webp');
  assert.equal(mimeOf('gif'),  'image/gif');
  assert.equal(mimeOf('exe'),  'application/octet-stream');
});

await okAsync('④ newImageFilename 格式：bg-<digits>.<ext>', () => {
  assert.match(newImageFilename('png'), /^bg-\d+\.png$/);
  assert.match(newImageFilename('webp'), /^bg-\d+\.webp$/);
});

await okAsync('⑤ MAX_IMAGE_BYTES = 12 MB', () => {
  assert.equal(MAX_IMAGE_BYTES, 12 * 1024 * 1024);
});

await okAsync('⑤b 常量与模型契约一致', () => {
  assert.equal(DEFAULTS.veil, 0.78);
  assert.equal(DEFAULTS.blur, 0);
  assert.deepEqual(LIMITS.veil, [0.75, 0.99]);
  assert.deepEqual(LIMITS.blur, [0, 24]);
  for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif']) {
    assert.ok(ALLOWED_EXTS.has(ext), `白名单应包含 ${ext}`);
  }
});

// ══════════════════════════════════════════════════════════════════════
// Repo 层：落盘
// ══════════════════════════════════════════════════════════════════════

await okAsync('⑥ 首次读（config 不存在）→ 默认值', async () => {
  const repo = new AppearanceRepo(dataDir);
  await repo.init();
  const cfg = await repo.read();
  assert.equal(cfg.veil, 0.78);
  assert.equal(cfg.blur, 0);
  assert.equal(cfg.image, null);
});

await okAsync('⑦ write 后 read 能读回（含夹取）', async () => {
  const repo = new AppearanceRepo(dataDir);
  await repo.init();
  await repo.write({ veil: 0.75, blur: 8 });
  const r = await repo.read();
  assert.equal(r.veil, 0.75);
  assert.equal(r.blur, 8);
  // 夹取
  await repo.write({ veil: 0.1, blur: 100 });
  const r2 = await repo.read();
  assert.equal(r2.veil, 0.75);
  assert.equal(r2.blur, 24);
});

await okAsync('⑧ saveImage 写入文件并更新 config.image', async () => {
  // 先清空
  await fs.rm(appearanceDir, { recursive: true, force: true });
  const repo = new AppearanceRepo(dataDir);
  await repo.init();
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const cfg = await repo.saveImage(png, 'png');
  assert.ok(cfg.image, 'config.image 应被设置');
  assert.match(cfg.image, /^bg-\d+\.png$/);
  const stat = await fs.stat(path.join(appearanceDir, cfg.image));
  assert.equal(stat.size, png.length);
  // 读回字节
  const img = await repo.getImage();
  assert.deepEqual(img.buffer, png);
  assert.equal(img.ext, 'png');
  assert.equal(img.mime, 'image/png');
});

await okAsync('⑨ saveImage 换图时删旧文件（不留孤儿）', async () => {
  await fs.rm(appearanceDir, { recursive: true, force: true });
  const repo = new AppearanceRepo(dataDir);
  await repo.init();
  const cfg1 = await repo.saveImage(Buffer.from('aaaa'), 'png');
  const cfg2 = await repo.saveImage(Buffer.from('bbbb'), 'webp');
  assert.notEqual(cfg1.image, cfg2.image, '两次上传应是不同文件名');
  // 旧文件应被删
  let oldStillThere = false;
  try { await fs.stat(path.join(appearanceDir, cfg1.image)); oldStillThere = true; } catch {}
  assert.equal(oldStillThere, false, '旧图应被删除');
  // 目录里只有 1 张图
  const files = await fs.readdir(appearanceDir);
  const images = files.filter((f) => /^bg-\d+\./.test(f));
  assert.equal(images.length, 1, `目录里应只有 1 张图，实际 ${images.length}：${images.join(', ')}`);
  assert.equal(cfg2.image, images[0]);
});

await okAsync('⑩ saveImage 拒绝非白名单扩展名', async () => {
  const repo = new AppearanceRepo(dataDir);
  await repo.init();
  await assert.rejects(
    () => repo.saveImage(Buffer.from('x'), 'txt'),
    /不支持的扩展名/
  );
  await assert.rejects(
    () => repo.saveImage(Buffer.from('x'), 'exe'),
    /不支持的扩展名/
  );
});

await okAsync('⑪ saveImage 拒绝空文件', async () => {
  const repo = new AppearanceRepo(dataDir);
  await repo.init();
  await assert.rejects(
    () => repo.saveImage(Buffer.alloc(0), 'png'),
    /为空/
  );
});

await okAsync('⑫ saveImage 拒绝超 12 MB 的文件', async () => {
  const repo = new AppearanceRepo(dataDir);
  await repo.init();
  const big = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  await assert.rejects(
    () => repo.saveImage(big, 'png'),
    /图太大了|12MB/
  );
});

await okAsync('⑬ clearImage 删文件并置 image:null', async () => {
  await fs.rm(appearanceDir, { recursive: true, force: true });
  const repo = new AppearanceRepo(dataDir);
  await repo.init();
  const cfg1 = await repo.saveImage(Buffer.from('xyz'), 'png');
  assert.ok(cfg1.image);
  const cfg2 = await repo.clearImage();
  assert.equal(cfg2.image, null);
  let stillThere = false;
  try { await fs.stat(path.join(appearanceDir, cfg1.image)); stillThere = true; } catch {}
  assert.equal(stillThere, false, '清图后文件应被删');
});

await okAsync('⑭ clearImage 幂等（没有图也不报错）', async () => {
  await fs.rm(appearanceDir, { recursive: true, force: true });
  const repo = new AppearanceRepo(dataDir);
  await repo.init();
  const cfg = await repo.clearImage();
  assert.equal(cfg.image, null);
});

await okAsync('⑮ getImage 无图 → null；文件被外部删了也 → null', async () => {
  await fs.rm(appearanceDir, { recursive: true, force: true });
  const repo = new AppearanceRepo(dataDir);
  await repo.init();
  assert.equal(await repo.getImage(), null, '没图 → null');
  // 制造一个"config 有 image 但文件不在"的状态
  const cfg = await repo.saveImage(Buffer.from('qq'), 'png');
  await fs.rm(path.join(appearanceDir, cfg.image), { force: true });
  assert.equal(await repo.getImage(), null, '文件被外部删了 → 当作无图，不 500');
});

// ══════════════════════════════════════════════════════════════════════
// Routes 层：HTTP 契约
// ══════════════════════════════════════════════════════════════════════

async function freshApp() {
  await fs.rm(appearanceDir, { recursive: true, force: true });
  const app = new MockApp();
  registerAppearanceRoutes(app, dataDir);
  return app;
}

await okAsync('⑯ 6 个端点全部注册', async () => {
  const app = await freshApp();
  for (const key of [
    'GET /appearance',
    'POST /appearance',
    'POST /appearance/image',
    'POST /appearance/image/clear',
    'GET /appearance/image',
    'GET /appearance/image.json'
  ]) {
    assert.equal(typeof app._get(key.split(' ')[0], key.split(' ')[1]), 'function', `缺 ${key}`);
  }
});

await okAsync('⑰ GET /appearance 返回默认配置（无图时 image:null）', async () => {
  const app = await freshApp();
  const c = makeContext();
  await app._get('GET', '/appearance')(c);
  assert.equal(c._result.kind, 'json');
  assert.equal(c._result.status, 200);
  assert.equal(c._result.data.ok, true);
  assert.equal(c._result.data.data.veil, 0.78);
  assert.equal(c._result.data.data.blur, 0);
  assert.equal(c._result.data.data.image, null);
});

await okAsync('⑱ POST /appearance 全量更新 veil+blur', async () => {
  const app = await freshApp();
  const c = makeContext({ json: { veil: 0.75, blur: 12 } });
  await app._get('POST', '/appearance')(c);
  assert.equal(c._result.data.ok, true);
  assert.equal(c._result.data.data.veil, 0.75);
  assert.equal(c._result.data.data.blur, 12);
  assert.equal(c._result.data.data.image, null);
});

await okAsync('⑲ POST /appearance 部分更新：只给 veil 时 blur 保持原值', async () => {
  const app = await freshApp();
  await app._get('POST', '/appearance')(makeContext({ json: { veil: 0.8, blur: 10 } }));
  const c = makeContext({ json: { veil: 0.9 } });
  await app._get('POST', '/appearance')(c);
  assert.equal(c._result.data.data.veil, 0.9, 'veil 应更新');
  assert.equal(c._result.data.data.blur, 10, 'blur 应保留上一次的值（不是被默认值覆盖）');
});

await okAsync('⑳ POST /appearance 归一化：veil 超上限被夹，blur 负数被夹', async () => {
  const app = await freshApp();
  const c = makeContext({ json: { veil: 1.5, blur: -3 } });
  await app._get('POST', '/appearance')(c);
  assert.equal(c._result.data.data.veil, 0.99);
  assert.equal(c._result.data.data.blur, 0);
});

await okAsync('㉑ POST /appearance/image 上传成功，image 为新文件名', async () => {
  const app = await freshApp();
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const file = {
    name: 'upload.png',
    type: 'image/png',
    arrayBuffer: async () => png,
  };
  const formData = { get: (k) => (k === 'file' ? file : null) };
  const c = makeContext({ formData });
  await app._get('POST', '/appearance/image')(c);
  assert.equal(c._result.data.ok, true);
  assert.ok(c._result.data.data.image, 'image 应被设置');
  assert.match(c._result.data.data.image, /^bg-\d+\.png$/);
  // 文件确实落盘
  const stat = await fs.stat(path.join(appearanceDir, c._result.data.data.image));
  assert.ok(stat.size > 0);
});

await okAsync('㉒ POST /appearance/image 换图删旧（目录只留一张）', async () => {
  const app = await freshApp();
  const file1 = {
    name: 'a.png', type: 'image/png',
    arrayBuffer: async () => Buffer.from('aaaa'),
  };
  await app._get('POST', '/appearance/image')(makeContext({ formData: { get: (k) => (k === 'file' ? file1 : null) } }));
  const file2 = {
    name: 'b.webp', type: 'image/webp',
    arrayBuffer: async () => Buffer.from('bbbb'),
  };
  await app._get('POST', '/appearance/image')(makeContext({ formData: { get: (k) => (k === 'file' ? file2 : null) } }));
  const files = (await fs.readdir(appearanceDir)).filter((f) => /^bg-\d+\./.test(f));
  assert.equal(files.length, 1, `换图后目录里应只有 1 张，实际 ${files.length}`);
});

await okAsync('㉓ POST /appearance/image 拒绝不支持的扩展名（走 filename 兜底也拒绝）', async () => {
  const app = await freshApp();
  const file = {
    name: 'malicious.txt', type: 'text/plain',
    arrayBuffer: async () => Buffer.from('hello'),
  };
  const c = makeContext({ formData: { get: (k) => (k === 'file' ? file : null) } });
  await app._get('POST', '/appearance/image')(c);
  assert.equal(c._result.data.ok, false);
  assert.match(c._result.data.error, /不支持的文件类型|只接受/);
});

await okAsync('㉔ POST /appearance/image 拒绝超 12 MB（人话报错）', async () => {
  const app = await freshApp();
  const big = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  const file = {
    name: 'big.png', type: 'image/png',
    arrayBuffer: async () => big,
  };
  const c = makeContext({ formData: { get: (k) => (k === 'file' ? file : null) } });
  await app._get('POST', '/appearance/image')(c);
  assert.equal(c._result.data.ok, false);
  assert.match(c._result.data.error, /图太大了|12MB/);
});

await okAsync('㉕ POST /appearance/image 缺 file 字段 → 报错', async () => {
  const app = await freshApp();
  const c = makeContext({ formData: { get: () => null } });
  await app._get('POST', '/appearance/image')(c);
  assert.equal(c._result.data.ok, false);
  assert.match(c._result.data.error, /file 字段/);
});

await okAsync('㉖ GET /appearance/image 有图时回 200 + 正确 Content-Type', async () => {
  const app = await freshApp();
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const file = { name: 'x.png', type: 'image/png', arrayBuffer: async () => png };
  await app._get('POST', '/appearance/image')(makeContext({ formData: { get: (k) => (k === 'file' ? file : null) } }));
  const c = makeContext();
  await app._get('GET', '/appearance/image')(c);
  assert.equal(c._result.kind, 'body');
  assert.equal(c._result.status, 200);
  assert.equal(c._result.headers['Content-Type'], 'image/png');
  assert.deepEqual(c._result.body, png);
});

await okAsync('㉗ GET /appearance/image 无图 → 404', async () => {
  const app = await freshApp();
  const c = makeContext();
  await app._get('GET', '/appearance/image')(c);
  assert.equal(c._result.kind, 'json');
  assert.equal(c._result.status, 404, '无图应返回 404');
  assert.equal(c._result.data.ok, false);
  assert.match(c._result.data.error, /没有背景图/);
});

await okAsync('㉘ POST /appearance/image/clear 清图后 image:null', async () => {
  const app = await freshApp();
  // 先上传一张
  const file = { name: 'x.png', type: 'image/png', arrayBuffer: async () => Buffer.from('abc') };
  await app._get('POST', '/appearance/image')(makeContext({ formData: { get: (k) => (k === 'file' ? file : null) } }));
  // 清图
  const c = makeContext();
  await app._get('POST', '/appearance/image/clear')(c);
  assert.equal(c._result.data.ok, true);
  assert.equal(c._result.data.data.image, null, '清图后 image 应为 null');
  // 再读一次确认磁盘一致
  const c2 = makeContext();
  await app._get('GET', '/appearance')(c2);
  assert.equal(c2._result.data.data.image, null);
});

await okAsync('㉙ GET /appearance/image 在 clear 后返回 404', async () => {
  const app = await freshApp();
  const file = { name: 'x.png', type: 'image/png', arrayBuffer: async () => Buffer.from('abc') };
  await app._get('POST', '/appearance/image')(makeContext({ formData: { get: (k) => (k === 'file' ? file : null) } }));
  await app._get('POST', '/appearance/image/clear')(makeContext());
  const c = makeContext();
  await app._get('GET', '/appearance/image')(c);
  assert.equal(c._result.status, 404);
  assert.equal(c._result.data.ok, false);
});

// ── image.json：base64 通道（前端走这个，不走裸流）──

await okAsync('㉚ GET /appearance/image.json 有图时回 base64（与 avatar.json 同形状）', async () => {
  const app = await freshApp();
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const file = { name: 'x.png', type: 'image/png', arrayBuffer: async () => png };
  await app._get('POST', '/appearance/image')(makeContext({ formData: { get: (k) => (k === 'file' ? file : null) } }));
  const c = makeContext();
  await app._get('GET', '/appearance/image.json')(c);
  assert.equal(c._result.kind, 'json');
  assert.equal(c._result.status, 200);
  assert.equal(c._result.data.ok, true);
  const d = c._result.data.data;
  // 与 /characters/:id/avatar.json 同形状：ok / ext / mime / bytes / base64
  assert.equal(d.ok, true);
  assert.equal(d.mime, 'image/png');
  assert.equal(d.ext, 'png');
  assert.equal(d.bytes, png.length);
  assert.equal(d.base64, png.toString('base64'));
  // 前端 atob 回来的字节与上传的一致
  assert.deepEqual(Buffer.from(d.base64, 'base64'), png);
});

await okAsync('㉛ GET /appearance/image.json 无图时 404', async () => {
  const app = await freshApp();
  const c = makeContext();
  await app._get('GET', '/appearance/image.json')(c);
  assert.equal(c._result.status, 404);
  assert.equal(c._result.data.ok, false);
});

// 清理
await fs.rm(tmp, { recursive: true, force: true });

console.log('');
if (failed.length) {
  console.error(`❌ 外观模块：${pass} 过 / ${failed.length} 败`);
  for (const f of failed) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✅ 外观模块：${pass} 过 / 0 败`);
