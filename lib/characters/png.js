// lib/characters/png.js — PNG tEXt chunk 读写
//
// 支持在 PNG 图片中嵌入角色卡数据（SillyTavern 格式）。
// 使用 tEXt chunk 存储 JSON 数据。

import fs from "node:fs/promises";
import zlib from "node:zlib";

// PNG 签名
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// CRC32 表（预计算）
const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

/**
 * 计算 CRC32 校验和
 * @param {Buffer} data - 输入数据
 * @returns {number} CRC32 值
 */
export function crc32(data) {
  let crc = -1;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ data[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/**
 * 从 PNG buffer 中读取 tEXt chunk 数据
 * @param {Buffer} buffer - PNG 文件 buffer
 * @returns {object} 包含 chara/comment 等字段的数据
 */
export function readPngText(buffer) {
  if (!buffer || buffer.length < 8) {
    throw new Error("Invalid PNG buffer (too short)");
  }

  if (!buffer.slice(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Not a valid PNG file (bad signature)");
  }

  const result = {};
  let offset = 8;

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) break;

    const length = buffer.readUInt32BE(offset);
    if (offset + 12 + length > buffer.length) break;

    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const data = buffer.slice(dataStart, dataStart + length);
    const crc = buffer.readUInt32BE(dataStart + length);

    // 处理文本类 chunk
    if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
      try {
        const parsed = parseTextChunk(type, data);
        if (parsed) {
          result[parsed.keyword] = parsed.value;
        }
      } catch (e) {
        // 忽略解析错误
      }
    }

    offset += 12 + length;
  }

  return result;
}

/**
 * 解析单个文本 chunk
 */
function parseTextChunk(type, data) {
  if (type === "tEXt") {
    // 格式：keyword\0text
    const nullIdx = data.indexOf(0);
    if (nullIdx === -1) return null;

    const keyword = data.toString("utf8", 0, nullIdx);
    const text = data.toString("utf8", nullIdx + 1);

    return { keyword, value: decodeTextValue(text) };
  } else if (type === "zTXt") {
    // 格式：keyword\0compression_method\compressed_data
    const nullIdx = data.indexOf(0);
    if (nullIdx === -1) return null;

    const keyword = data.toString("utf8", 0, nullIdx);
    // compression_method 通常是 0
    const compressed = data.slice(nullIdx + 2);

    try {
      const text = zlib.inflateSync(compressed).toString("utf8");
      return { keyword, value: decodeTextValue(text) };
    } catch {
      return null;
    }
  } else if (type === "iTXt") {
    // 格式：keyword\0 compressionFlag compressionMethod languageTag\0 translatedKeyword\0 text
    // 它是 tEXt 的国际版（多语言标签 + 可选压缩），SillyTavern 生态里也有卡用。
    const z1 = data.indexOf(0);
    if (z1 === -1) return null;
    const keyword = data.toString("utf8", 0, z1);

    const flag = data[z1 + 1];
    const method = data[z1 + 2];
    if (method !== 0) return null; // 只认 method 0（zlib）

    let p = z1 + 3;
    const z2 = data.indexOf(0, p); // language tag 结束
    if (z2 === -1) return null;
    const z3 = data.indexOf(0, z2 + 1); // translated keyword 结束
    if (z3 === -1) return null;

    let text = data.slice(z3 + 1);
    if (flag === 1) {
      try {
        text = zlib.inflateSync(text);
      } catch {
        return null;
      }
    }
    return { keyword, value: decodeTextValue(text.toString("utf8")) };
  }

  return null;
}

/**
 * 解出一个文本 chunk 的值。
 *
 * 两种写法都要认：
 * - 本 App 自己导出的是裸 JSON，能直接 parse；
 * - SillyTavern 的图片卡把同一份 JSON 又 base64 了一层（btoa）。以前这里
 *   只试 JSON.parse，失败就把整串 base64 原样当值返回——于是它的 chara
 *   成了一个字符串，被当作"卡"往下走，最终报的是 "name is required"。
 *   导入 ST 卡必然踩这一脚，而错误指向的却是字段。
 *
 * @param {string} text - chunk 里的原始文本
 * @returns {any} 解析出的值；不是 JSON 就返回原文
 */
function decodeTextValue(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") return "";

  try {
    return JSON.parse(trimmed);
  } catch {
    // 不是裸 JSON，往下试 base64
  }

  // 只对"确实像 base64"的串解码。没有这层判断，一句普通文本也会被
  // Buffer 静默解出乱码（非法字符被丢弃），base64 只是兜底不是默认。
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) && trimmed.length % 4 === 0) {
    try {
      const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();
      return JSON.parse(decoded);
    } catch {
      // 解出来不是 JSON，说明它本来就是一段普通文本
    }
  }

  return trimmed;
}

/**
 * 向 PNG buffer 写入 tEXt chunk（替换或追加）
 * @param {Buffer} buffer - 原始 PNG buffer
 * @param {object} data - 要写入的数据（JSON 对象）
 * @returns {Buffer} 新的 PNG buffer
 */
export async function writePngText(buffer, data) {
  if (!buffer || buffer.length < 8) {
    throw new Error("Invalid PNG buffer");
  }

  if (!buffer.slice(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Not a valid PNG file");
  }

  if (data === null || data === undefined) {
    // 删除所有文本 chunk
    return removeTextChunks(buffer);
  }

  // ST 可能传 {chara: card}，也可能直接传 card。解包一次，
  // 否则读出来会是 {chara: {chara: card}}，name 就读不到了。
  const payload = (data && typeof data === "object" && !Array.isArray(data)
    && Object.prototype.hasOwnProperty.call(data, "chara")
    && data.chara && typeof data.chara === "object")
    ? data.chara
    : data;

  const json = JSON.stringify(payload);
  const newChunks = [];
  const chunksToKeep = [];

  let offset = 8;
  let iendOffset = -1;

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) break;

    const length = buffer.readUInt32BE(offset);
    if (offset + 12 + length > buffer.length) break;

    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const chunkEnd = offset + 12 + length;

    // 跳过文本类 chunk（稍后重建）
    if (type !== "tEXt" && type !== "zTXt" && type !== "iTXt") {
      chunksToKeep.push(buffer.slice(offset, chunkEnd));

      if (type === "IEND") {
        iendOffset = chunksToKeep.length - 1;
      }
    }

    offset = chunkEnd;
  }

  if (iendOffset === -1) {
    throw new Error("PNG IEND chunk not found");
  }

  // 创建新的 tEXt chunk
  const keyword = Buffer.from("chara", "utf8");
  const nullByte = Buffer.alloc(1);
  const textData = Buffer.from(json, "utf8");
  const chunkData = Buffer.concat([keyword, nullByte, textData]);

  const chunkLength = Buffer.alloc(4);
  chunkLength.writeUInt32BE(chunkData.length, 0);

  const chunkType = Buffer.from("tEXt", "ascii");

  const chunkCrc = Buffer.alloc(4);
  chunkCrc.writeUInt32BE(crc32(Buffer.concat([chunkType, chunkData])), 0);

  const newChunk = Buffer.concat([chunkLength, chunkType, chunkData, chunkCrc]);
  newChunks.push(newChunk);

  // 在 IEND 前插入新 chunk。
  // 注意：PNG 的 8 字节签名不是 chunk，必须显式拼回去 ——
  // 只拼 chunks 会丢签名，写出的文件就不是合法 PNG 了。
  const finalChunks = [
    PNG_SIGNATURE,
    ...chunksToKeep.slice(0, iendOffset),
    ...newChunks,
    ...chunksToKeep.slice(iendOffset)
  ];
  return Buffer.concat(finalChunks);
}

/**
 * 移除所有文本类 chunk
 */
function removeTextChunks(buffer) {
  const chunksToKeep = [];
  let offset = 8;

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) break;

    const length = buffer.readUInt32BE(offset);
    if (offset + 12 + length > buffer.length) break;

    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const chunkEnd = offset + 12 + length;

    if (type !== "tEXt" && type !== "zTXt" && type !== "iTXt") {
      chunksToKeep.push(buffer.slice(offset, chunkEnd));
    }

    offset = chunkEnd;
  }

  return Buffer.concat(chunksToKeep);
}

/**
 * 从文件读取 PNG 角色卡
 * @param {string} filePath - PNG 文件路径
 * @returns {object} 角色卡数据
 */
export async function readPngCard(filePath) {
  const buffer = await fs.readFile(filePath);
  return readPngText(buffer);
}
