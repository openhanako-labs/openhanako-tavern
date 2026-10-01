// lib/social/feed.js — 朋友圈（第 7 期）
//
// 独立轻实体（不寄生对话）：动态/评论的语义与对话流不同——
// 动态是"角色主动发布的状态"，评论是"围绕状态的短互动"，
// 塞进对话流会把两边的时间线语义都搞混。
//
// 存储：dataDir/social/feed.json（带锁原子写，与 presets/repo 同纪律）。
//
// 玩家点赞/评论 → AI 回应：回应走 LLM（由 routes 层调用，本文件只管存储与视图）。

import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, readJsonSafe, withLock } from "../atomic.js";

const SOCIAL_DIR = "social";
const FEED_FILE = "feed.json";
const MAX_POSTS = 200;         // 动态上限（旧的从尾部淘汰）
const MAX_COMMENTS = 50;       // 单条动态评论上限

function emptyFeed() {
  return { posts: [] };
}

export class FeedRepo {
  constructor(dataDir) {
    if (!dataDir) throw new Error("dataDir is required");
    this.dir = path.join(dataDir, SOCIAL_DIR);
    this.file = path.join(this.dir, FEED_FILE);
  }

  async init() {
    await ensureDir(this.dir);
    await withLock(this.file, async () => {
      const cur = await readJsonSafe(this.file, null);
      if (!cur) await fs.writeFile(this.file, JSON.stringify(emptyFeed(), null, 2), "utf8");
    });
    return this;
  }

  async _read() {
    const cur = await readJsonSafe(this.file, null);
    return cur && typeof cur === "object" && Array.isArray(cur.posts) ? cur : emptyFeed();
  }

  /** 动态列表（新的在前）。 */
  async list({ characterId = null, limit = 50 } = {}) {
    const feed = await this._read();
    let posts = feed.posts;
    if (characterId) posts = posts.filter(p => p.characterId === String(characterId));
    return posts.slice(0, limit);
  }

  /** 发一条动态。 */
  async addPost({ characterId, characterName, text }) {
    const t = String(text ?? "").trim();
    if (!t) throw new Error("动态内容为空");
    return withLock(this.file, async () => {
      const feed = await this._read();
      const post = {
        id: crypto.randomUUID(),
        characterId: String(characterId),
        characterName: String(characterName || ""),
        text: t.slice(0, 500),
        at: new Date().toISOString(),
        likes: [],
        comments: []
      };
      feed.posts.unshift(post);
      feed.posts = feed.posts.slice(0, MAX_POSTS);
      await fs.writeFile(this.file, JSON.stringify(feed, null, 2), "utf8");
      return post;
    });
  }

  /** 玩家点赞（再点取消）。 */
  async toggleLike(postId, userName = "玩家") {
    return withLock(this.file, async () => {
      const feed = await this._read();
      const post = feed.posts.find(p => p.id === String(postId));
      if (!post) throw new Error("动态不存在");
      const i = post.likes.indexOf(userName);
      if (i >= 0) post.likes.splice(i, 1);
      else post.likes.push(userName);
      await fs.writeFile(this.file, JSON.stringify(feed, null, 2), "utf8");
      return { id: post.id, likes: post.likes };
    });
  }

  /** 加评论（玩家或角色回应）。返回更新后的评论列表。 */
  async addComment(postId, { by, text, isCharacter = false }) {
    const t = String(text ?? "").trim();
    if (!t) throw new Error("评论内容为空");
    return withLock(this.file, async () => {
      const feed = await this._read();
      const post = feed.posts.find(p => p.id === String(postId));
      if (!post) throw new Error("动态不存在");
      post.comments = Array.isArray(post.comments) ? post.comments : [];
      post.comments.push({
        by: String(by || (isCharacter ? post.characterName : "玩家")),
        text: t.slice(0, 300),
        at: new Date().toISOString(),
        isCharacter: isCharacter === true
      });
      post.comments = post.comments.slice(-MAX_COMMENTS);
      await fs.writeFile(this.file, JSON.stringify(feed, null, 2), "utf8");
      return post.comments;
    });
  }

  /** 删一条动态。 */
  async removePost(postId) {
    return withLock(this.file, async () => {
      const feed = await this._read();
      const before = feed.posts.length;
      feed.posts = feed.posts.filter(p => p.id !== String(postId));
      await fs.writeFile(this.file, JSON.stringify(feed, null, 2), "utf8");
      return { removed: before - feed.posts.length };
    });
  }
}

import crypto from "node:crypto";

export default { FeedRepo };
