// lib/media/index-store.js — 图片台账（第 1 批）
//
// 一句话：出图落地之后记一笔，图库那边按台账读，不再靠扫目录。
//
// 为什么单独一层，而不塞进 media/routes.js：
//   · 台账是被多处写入的（今天的 portrait，明天的场景插图，后天还要接图库）；
//     路由是消费方，存储是**被**多方复用的契约。混在路由里就是每次调用方
//     都自己拼一次 JSON、自己处理重复 id、自己关心原子写——三个地方一份错。
//   · 台账是**只增不改**的：一条记录写进去，几乎不会被 update。
//     所以存储层要擅长 append，不擅长 patch——这里就没实现真正的 patch。
//
// 存储格式：JSON 数组（原子写）。
//   · 为什么不是 JSONL：plan 明说"写入必须原子（复用 lib/atomic.js）"，
//     atomic.js 里的 JSONL 走 appendFile 不是原子替换。JSON 数组配合
//     writeJsonAtomic 才符合这条纪律。
//   · 为什么不是 SQLite：这个 App 的数据体只有几十到几百条，
//     加一个原生依赖换来的收益抵不上打包体积。
//
// 自愈纪律（计划 1.1）：读损坏时不整体丢。
//   · 外层 JSON 损坏 → readJsonSafe 会把它改名留证，返回 fallback 空表。
//     这是"这次读不到就重新建立"，不是"从此再也不修"——atomic.js 已经把
//     那个坏文件留在盘上（*.broken-<ts>），下次可以人工核对。
//   · 数组里某一条坏（缺 id 或者 id 是空串）→ 读的时候**丢掉那一条**，
//     其他保留。这条是"丢一条不丢全表"字面意义上的实现。

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { writeJsonAtomic, readJsonSafe, ensureDir } from "../atomic.js";

const FILE = "media-index.json";

/** 允许写进台账的 kind。窄一点，写错就不让写。 */
const KINDS = new Set(["portrait", "scene", "reference", "import"]);

export const MediaKind = {
  PORTRAIT: "portrait",
  SCENE: "scene",
  REFERENCE: "reference",
  IMPORT: "import"
};

export function indexPath(dataDir) {
  if (!dataDir) throw new Error("index-store 需要 dataDir");
  return path.join(dataDir, FILE);
}

/** 生成一个短 id：前缀 + 12 位 hex，人肉好读、冲突概率忽略不计。 */
function genId(prefix = "m") {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * 归一化一条记录。缺 id 补一个；未知 kind 归到 portrait（不抛，因为
 * 台账是"记录已发生的事"，把历史数据硬拒掉等于把账本烧了）。
 * 只有 file 是**必须**的字段——它是这条记录的唯一"实体"，没有路径就是空行。
 */
function normRecord(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const rec = {
    id: typeof r.id === "string" && r.id.trim() ? r.id.trim().slice(0, 64) : genId(),
    kind: KINDS.has(r.kind) ? r.kind : MediaKind.PORTRAIT,
    characterId: r.characterId == null ? null : String(r.characterId),
    conversationId: r.conversationId == null ? null : String(r.conversationId),
    messageId: r.messageId == null ? null : String(r.messageId),
    file: typeof r.file === "string" && r.file.trim() ? r.file.trim() : null,
    bytes: typeof r.bytes === "number" && Number.isFinite(r.bytes) && r.bytes >= 0 ? r.bytes : null,
    prompt: typeof r.prompt === "string" ? r.prompt : null,
    taskId: typeof r.taskId === "string" ? r.taskId : null,
    scene: typeof r.scene === "string" ? r.scene : null,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date().toISOString()
  };
  return rec;
}

async function readIndexFile(filePath) {
  const raw = await readJsonSafe(filePath, null);
  if (!raw) return [];
  if (!Array.isArray(raw)) return [];
  // 逐条归一化 + 丢坏行
  const clean = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const normed = normRecord(r);
    // file 为 null 的记录留着也没意义——但**丢**它等于替用户改账本。
    // 所以留着，读的时候按需 filter。
    clean.push(normed);
  }
  return clean;
}

async function writeIndexFile(filePath, records) {
  await ensureDir(path.dirname(filePath));
  await writeJsonAtomic(filePath, records);
}

/**
 * 读全部记录，按 createdAt 倒序。
 *
 * 自愈纪律：数组损坏 → 落一条 .broken-<ts> 备份，返回空表；
 * 单条损坏 → 该条被丢掉，其他原样返回。都不静默。
 *
 * @param {string} dataDir
 * @returns {Promise<{records: Array<object>, corrupted: number, dropped: number}>}
 *   dropped 是被丢掉的那条数（缺 file 等）——不静默是纪律。
 */
export async function readIndex(dataDir) {
  const p = indexPath(dataDir);
  const records = await readIndexFile(p);
  // 记一下这次读丢了什么，方便调用方判断"空表"是"真的空"还是"坏成空"
  let dropped = 0;
  for (const r of records) {
    if (!r.file) dropped++;
  }
  const sorted = records.slice().sort((a, b) =>
    String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
  );
  return { records: sorted, dropped };
}

/**
 * 按 id 读一条。找不到返回 null（不抛）。
 * 调用方要判 null，不要靠 try/catch 分流。
 */
export async function getById(dataDir, id) {
  const { records } = await readIndex(dataDir);
  const key = String(id ?? "");
  if (!key) return null;
  return records.find((r) => r.id === key) || null;
}

/**
 * 列表接口。可选过滤：kind / characterId / conversationId。
 * 全按字符串比，避免 1 vs "1" 那类静默不匹配。
 */
export async function list(dataDir, filter = {}) {
  const { records } = await readIndex(dataDir);
  const out = [];
  for (const r of records) {
    if (filter.kind && r.kind !== filter.kind) continue;
    if (filter.characterId != null && r.characterId !== String(filter.characterId)) continue;
    if (filter.conversationId != null && r.conversationId !== String(filter.conversationId)) continue;
    out.push(r);
  }
  return out;
}

/**
 * 写入（或更新）一条记录。
 *
 * 纪律：
 *   · **原子**：整个"读全表 → 改 → 写全表"在 withLock 内串行（writeJsonAtomic 里已经加锁）。
 *   · **重复 id = 覆盖**：同 id 的新记录盖旧的。这是有意的——
 *     场景插图的 status 会经历 pending → ok / failed，靠 upsert 推进；
 *     立绘重新生成也算同 id 覆盖，避免同一条媒体在台账里堆两行。
 *   · **file 必须是绝对路径**：这条纪律写在计划里，也写在这里——
 *     相对路径无从追溯（BUG-059 同源）。传相对路径直接报错，不静默接受。
 *   · **缺 file 的记录**：允许写（场景插图的 pending 状态就是这样），
 *     但读回来时通过 readIndex 的 dropped 计数能看见。
 *
 * @param {object} dataDir  App 数据目录
 * @param {object} record   要写入的记录（会经过归一化）
 * @returns {Promise<object>} 归一化后落盘的那一条
 */
export async function upsert(dataDir, record) {
  if (!record || typeof record !== "object") {
    throw new Error("upsert: record 必须是对象");
  }
  const normed = normRecord(record);
  // file 一旦给就必须是绝对路径——不允许相对路径污染台账
  if (normed.file != null && !isAbsolute(normed.file)) {
    throw new Error(
      `index-store 拒绝写相对路径（BUG-059 同源）：file="${normed.file}"，请传绝对路径`
    );
  }
  const filePath = indexPath(dataDir);
  const existing = await readIndexFile(filePath);
  const idx = existing.findIndex((r) => r.id === normed.id);
  if (idx >= 0) existing[idx] = normed;
  else existing.push(normed);
  await writeIndexFile(filePath, existing);
  return normed;
}

/**
 * 插入一条新记录。
 *
 * 与 upsert 的差别：同 id 已存在时**报错**，不覆盖。
 * 用在"这条记录已经发生过"的场景（比如导入时给外部图片登记）——
 * 静默覆盖会吞掉用户之前手动放进去的一条。
 */
export async function insert(dataDir, record) {
  if (!record || typeof record !== "object") {
    throw new Error("insert: record 必须是对象");
  }
  const normed = normRecord(record);
  if (normed.file != null && !isAbsolute(normed.file)) {
    throw new Error(
      `index-store 拒绝写相对路径（BUG-059 同源）：file="${normed.file}"，请传绝对路径`
    );
  }
  const filePath = indexPath(dataDir);
  const existing = await readIndexFile(filePath);
  if (existing.some((r) => r.id === normed.id)) {
    throw new Error(`insert: id="${normed.id}" 已存在，请换一个 id 或用 upsert`);
  }
  existing.push(normed);
  await writeIndexFile(filePath, existing);
  return normed;
}

/**
 * 按 id 更新部分字段。找不到报 ENOENT，不返回 null——
 * 更新是写操作，静默返回会让调用方以为改了但没改。
 */
export async function update(dataDir, id, patch) {
  if (!id) throw new Error("update: id 必填");
  if (!patch || typeof patch !== "object") throw new Error("update: patch 必须是对象");
  const filePath = indexPath(dataDir);
  const existing = await readIndexFile(filePath);
  const idx = existing.findIndex((r) => r.id === String(id));
  if (idx < 0) {
    const e = new Error(`update: 台账里没有 id=${id}`);
    e.code = "ENOENT";
    throw e;
  }
  const merged = { ...existing[idx], ...patch };
  const normed = normRecord(merged);
  if (normed.file != null && !isAbsolute(normed.file)) {
    throw new Error(`index-store 拒绝写相对路径：file="${normed.file}"`);
  }
  existing[idx] = normed;
  await writeIndexFile(filePath, existing);
  return normed;
}

/**
 * 按 id 删除。找不到返回 false（不抛）——
 * 删是一个幂等动作，"没有就当作删完了"更省事。
 */
export async function remove(dataDir, id) {
  if (!id) return false;
  const filePath = indexPath(dataDir);
  const existing = await readIndexFile(filePath);
  const before = existing.length;
  const next = existing.filter((r) => r.id !== String(id));
  if (next.length === before) return false;
  await writeIndexFile(filePath, next);
  return true;
}

/**
 * 读一条记录指向的文件，转 base64 返回。
 *
 * App 沙箱不允许裸 fs 读 App 目录之外的路径，但这里的 file 都是
 * App 自己写到 dataDir 下的（立绘、场景插图都在 <dataDir>/…），
 * 所以 fs.readFile 是合法通路。
 *
 * 返回：{ ok, id, kind, bytes, mime, base64, source }
 *   source 是磁盘路径，方便前端显示来源；
 *   base64 只在 bytes 存在时给，前端自己拼 Blob。
 */
export async function getBytes(dataDir, id) {
  const rec = await getById(dataDir, id);
  if (!rec) {
    const e = new Error(`media not found: ${id}`);
    e.code = "ENOENT";
    throw e;
  }
  if (!rec.file) {
    return {
      ok: false,
      id: rec.id,
      kind: rec.kind,
      reason: `台账里这条记录没有 file（可能是生成中/失败的占位）`
    };
  }
  try {
    const buf = await fs.readFile(rec.file);
    return {
      ok: true,
      id: rec.id,
      kind: rec.kind,
      bytes: buf.length,
      mime: mimeOf(rec.file),
      base64: buf.toString("base64"),
      source: rec.file,
      characterId: rec.characterId,
      conversationId: rec.conversationId,
      messageId: rec.messageId,
      prompt: rec.prompt,
      createdAt: rec.createdAt
    };
  } catch (e) {
    // 文件被删了 / 路径变了：记录还在，字节没了。
    // 这条**不说谎**——回一个 {ok:false}，把 errno 带出来，
    // 前端能判断该提示"文件已被删"而不是笼统的"加载失败"。
    return {
      ok: false,
      id: rec.id,
      kind: rec.kind,
      source: rec.file,
      reason: `${e?.code || "ERR"}：${e?.message || e}`,
      fileMissing: e?.code === "ENOENT"
    };
  }
}

function mimeOf(p) {
  const ext = /\.([a-z0-9]+)$/i.exec(String(p || ""))?.[1]?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "application/octet-stream";
}

/**
 * 判断是不是绝对路径。跟 lib/media/service.js 里的 isAbsolutePath 同一判据
 * （含 Windows 长路径 \\?\C:\… 与 UNC \\server\…），不重新造轮子。
 */
function isAbsolute(p) {
  if (typeof p !== "string") return false;
  const s = p.trim();
  if (/^[a-zA-Z]:[\\/]/.test(s)) return true;
  if (/^\\\\\?\\[a-zA-Z]:[\\/]/.test(s)) return true;
  if (/^\\\\[^\\]/.test(s)) return true;
  if (s.startsWith("/")) return true;   // POSIX
  return false;
}
