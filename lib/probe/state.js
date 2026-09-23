// lib/probe/state.js — 探针状态记录器
//
// 从 index.js 剥离。职责：记录宿主能力探测结果，供诊断工具与 /probe 路由读取。
// 注意：这是 M0 遗留的探针能力，保留作为诊断手段，但不再与业务逻辑混在入口文件里。

import fs from "node:fs/promises";
import path from "node:path";

export const APP_ID = "eleckoi-tavern";
export const PROBE_STATE_FILE = "probe-state.json";

const MAX_EVENTS = 200;

function createInitialState() {
  return {
    app: APP_ID,
    loadedAt: null,
    defineAppEntered: false,
    sdkKeys: [],
    dataDir: null,
    dataDirExists: null,
    dataDirWritable: null,
    dataDirTestFile: null,
    grantState: null,
    capabilityList: null,
    modelsAvailable: null,
    sessionsAvailable: null,
    agentsAvailable: null,
    busAvailable: null,
    inputStatusAvailable: null,
    loggerAvailable: null,
    characters: null,
    conversations: null,
    variables: null,
    settings: null,
    tools: null,
    migration: null,
    llm: null,
    errors: [],
    events: []
  };
}

export class ProbeState {
  constructor() {
    this.data = createInitialState();
  }

  get state() {
    return this.data;
  }

  now() {
    return new Date().toISOString();
  }

  record(event, detail) {
    this.data.events.push({ t: this.now(), event, detail });
    if (this.data.events.length > MAX_EVENTS) this.data.events.shift();
  }

  /** 执行并捕获异常，失败时记入 errors 并返回 undefined。 */
  async safe(fn, name) {
    try {
      return await fn();
    } catch (e) {
      this.data.errors.push({
        t: this.now(),
        name,
        message: e?.message || String(e),
        code: e?.code
      });
      return undefined;
    }
  }

  /** 同步版本的 safe（用于非 Promise 场景）。 */
  safeSync(fn, name) {
    try {
      return fn();
    } catch (e) {
      this.data.errors.push({
        t: this.now(),
        name,
        message: e?.message || String(e),
        code: e?.code
      });
      return undefined;
    }
  }

  /** 紧凑视图（给工具返回，避免 JSON 过大）。 */
  compact() {
    const d = this.data;
    return {
      app: d.app,
      loadedAt: d.loadedAt,
      dataDir: d.dataDir,
      dataDirWritable: d.dataDirWritable,
      modelsAvailable: d.modelsAvailable,
      sessionsAvailable: d.sessionsAvailable,
      characters: d.characters,
      conversations: d.conversations,
      variables: d.variables,
      settings: d.settings,
      tools: d.tools,
      migration: d.migration,
      llm: d.llm,
      errors: d.errors.slice(-5)
    };
  }

  /** 安全序列化（处理循环引用）。 */
  toJson(verbose = false) {
    const payload = verbose ? this.data : this.compact();
    try {
      const seen = new WeakSet();
      return JSON.stringify(payload, (k, v) => {
        if (v && typeof v === "object") {
          if (seen.has(v)) return "[circular]";
          seen.add(v);
        }
        return v;
      }, 2);
    } catch (e) {
      return `serialize failed: ${e?.message || e}`;
    }
  }

  /** 落盘到 dataDir/probe-state.json。 */
  async persist(dataDir) {
    if (!dataDir) return false;
    const statePath = path.join(dataDir, PROBE_STATE_FILE);
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(statePath, JSON.stringify(this.data, null, 2), "utf8");
    return true;
  }
}

/** 创建探针工具（注册到 sdk.tools）。 */
export function createProbeTool(probe) {
  return {
    name: "eleckoi_tavern_probe",
    description: "报告宿主能力与系统状态",
    parameters: {
      type: "object",
      properties: {
        verbose: { type: "boolean", description: "是否返回完整事件日志", default: false }
      }
    },
    execute: async (args) => {
      const verbose = !!args?.verbose;
      return {
        content: [{
          type: "text",
          text: `ElecKoi Tavern state (verbose=${verbose})\n${probe.toJson(verbose)}`
        }]
      };
    }
  };
}
