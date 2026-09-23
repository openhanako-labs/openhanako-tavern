// lib/characters/png.js — PNG tEXt chunk 读写
//
// 支持在 PNG 图片中嵌入角色卡数据（SillyTavern 格式）。
// 使用 tEXt chunk 存储 JSON 数据。

import fs from "node:fs/promises";

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

    try {
      return { keyword, value: JSON.parse(text) };
    } catch {
      return { keyword, value: text };
    }
  } else if (type === "zTXt") {
    // 格式：keyword\0compression_method\compressed_data
    const nullIdx = data.indexOf(0);
    if (nullIdx === -1) return null;

    const keyword = data.toString("utf8", 0, nullIdx);
    // compression_method 通常是 0
    const compressed = data.slice(nullIdx + 2);

    try {
      const zlib = require("node:zlib");
      const text = zlib.inflateSync(compressed).toString("utf8");
      return { keyword, value: JSON.parse(text) };
    } catch {
      return null;
    }
  } else if (type === "iTXt") {
    // 格式复杂，暂不支持
    return null;
  }

  return null;
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
