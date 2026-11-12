import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseDiagDocument } from "../../lib/registry.js";
import { projectDiagFile } from "../../lib/dsh-paths.js";
import { byCodeUnit } from "../../lib/model.js";

export function createReporter(label) {
  let passed = 0;
  return {
    pass(name) {
      passed += 1;
      console.log("PASS  " + name);
    },
    report() {
      console.log("\n" + passed + " passed, 0 failed");
      console.log("ALL " + label + " TESTS PASSED");
    }
  };
}

export const diagFile = (dshHome, projectRoot) => projectDiagFile(dshHome, projectRoot);
export const legacyDiagFile = (projectRoot) => join(projectRoot, ".dsh", ".mcp-diag.json");

export async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readDiag(dshHome, projectRoot) {
  return parseDiagDocument(JSON.parse(await readFile(diagFile(dshHome, projectRoot), "utf8"))).events;
}

export async function readDiagSummary(dshHome, projectRoot) {
  return parseDiagDocument(JSON.parse(await readFile(diagFile(dshHome, projectRoot), "utf8"))).summary;
}

/** 串行轮询直到谓词成立或超时；每轮检查依赖上一轮状态，不能并行。 */
export async function waitUntil(predicate, { timeoutMs = 5000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const poll = async () => {
    if (Date.now() >= deadline) return false;
    if (await predicate()) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs));
    return poll();
  };
  return poll();
}

/** 轮询 diag 直到谓词成立：事件驱动用例里对账链可能仍在落盘（不能用固定 sleep）。 */
export async function waitForDiag(dshHome, projectRoot, predicate, timeoutMs = 5000) {
  return waitUntil(async () => {
    try {
      return predicate(await readDiag(dshHome, projectRoot));
    } catch {
      // diag 尚不存在或正被半读到截断 JSON：视为「暂不满足」，继续轮询。
      return false;
    }
  }, { timeoutMs, intervalMs: 150 });
}

/** Windows 上 chokidar 关闭后目录句柄可能仍短暂占用：rm 带退避重试。 */
export async function rmRetry(path, attempt = 0) {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    if (attempt >= 19) throw error;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    return rmRetry(path, attempt + 1);
  }
}

/** 读某个 Lazy fixture 的 trace；每个标签一份，避免多个子进程并发写同一文件。 */
export async function readTraceLines(path) {
  try {
    return (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

/** 轮询 trace 直到谓词成立：等子进程真正退出，不用固定 sleep。
 * 每次检查与退避有先后依赖，不能预先并发启动各轮检查。
 */
export async function waitForTrace(path, predicate, timeoutMs = 5000) {
  return waitUntil(async () => predicate(await readTraceLines(path)), { timeoutMs, intervalMs: 100 });
}

export const stdioRow = (name, command = "node") => ({
  id: "panel-mcp-" + name,
  name: "@deepseek-ai/dsh-mcp-client",
  config: { serverName: name, transport: "stdio", command, args: ["srv-" + name + ".js"], env: {}, cwd: "sub", toolCallTimeoutMs: 60000, failOnStartupError: false, reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 } }
});

/** 最小假宿主 ctx：记录 plugin 装载与 restrict 调用；effect 收集清理器；on 记录监听器供 emit 触发。 */
export function fakeCtx() {
  const mounts = [];
  const disposals = [];
  const restrictions = [];
  const agents = [];
  const disposers = [];
  const schemas = []; // 全局工具注册表（测试按需 push 工具名）
  const handlers = new Map(); // 事件名 → 监听器数组（emit 用）
  const ctx = {
    mounts,
    disposals,
    restrictions,
    agentsList: agents,
    disposers,
    schemas,
    handlers,
    provided: {},
    on(name, callback) {
      const list = handlers.get(name) ?? [];
      list.push(callback);
      handlers.set(name, list);
      return () => {
        const index = list.indexOf(callback);
        if (index >= 0) list.splice(index, 1);
      };
    },
    /** 触发已注册的宿主事件（mock 需要；真实宿主由 dsh 派发）。 */
    emit(name, ...args) {
      for (const callback of handlers.get(name) ?? []) callback(...args);
    },
    provide(name, value) {
      this.provided[name] = value;
      return () => {
        delete this.provided[name];
      };
    },
    effect(callback) {
      if (typeof callback === "function") disposers.push(callback);
    },
    logger: { warn() {}, error() {}, info() {} },
    tools: {
      schemas: () => schemas
    },
    holdFibers: false,
    held: [],
    holdDispose: false,
    releaseDispose: [],
    plugin(_plugin, config) {
      let release;
      const fiber = new Promise((resolve) => {
        release = resolve;
      });
      fiber.config = config;
      fiber.dispose = async () => {
        disposals.push(config.serverName);
        if (ctx.holdDispose) {
          await new Promise((resolveDispose) => {
            ctx.releaseDispose.push(resolveDispose);
          });
        }
      };
      mounts.push(config);
      if (ctx.holdFibers) ctx.held.push(release);
      else queueMicrotask(release);
      return fiber;
    },
    get agents() {
      return {
        list: () => agents,
        isOwnedBy: () => false
      };
    }
  };
  return ctx;
}

export function fakeAgent(id, cwd) {
  const denies = [];
  return {
    id,
    session: { header: { cwd } },
    ctx: {
      tools: {
        restrict({ deny }) {
          const denyNames = [...deny];
          denyNames.sort(byCodeUnit);
          denies.push(denyNames);
          return () => {};
        }
      }
    },
    denies
  };
}