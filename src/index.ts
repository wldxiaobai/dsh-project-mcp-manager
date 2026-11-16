/**
 * dsh-project-mcp-manager —— 独立项目级 MCP 自动加载插件（宿主半区，无 UI）。
 *
 * 用法：在项目根创建 <projectRoot>/.dsh/mcp.yml（原生受管块，格式与
 * profile cordis.patch.yml 一致）或 .dsh/mcp.json（JSON 方言），在该项目
 * 开启 dsh 会话时自动装载其中的 MCP 服务器（经 @deepseek-ai/dsh-mcp-client），
 * 文件改动经 watch 热重载。
 *
 * 装载模型见 README 与 docs/guide/layers.md；查询面见 docs/guide/service.md；
 * 运行时行为见 registry.ts 的类注释。
 */
import { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { MCP_PLUGIN_NAME } from "./mcp-file.js";
import { PROFILE_ENV } from "./dsh-paths.js";
import { ProjectMcpRegistry, profileNameFromConfigPath } from "./registry.js";
import { bindProjectMcpService, PROJECT_MCP_SERVICE } from "./service.js";
import { resolveProjectTrustMode, type ProjectTrustMode } from "./trust.js";

export { bindProjectMcpService, PROJECT_MCP_SERVICE, PROJECT_MCP_UPDATED_EVENT, type ProjectMcpService } from "./service.js";
export type { FiberPhaseView, McpAddDraft, McpServerRuntimeView, McpWriteTarget, ProjectFileState, ProjectServerPhase, ProjectServerState, ProjectTrustState } from "./registry.js";
export type { McpLoadingMode, McpScopeInfo, McpServerView, McpTransport, ReconnectConfig, ToolFilter } from "./model.js";
export { projectKeyOf, serviceIdentityKeyOf } from "./model.js";
export type { PatchRow } from "./mcp-file.js";
export type { McpRowSource } from "./json-file.js";
export type { ContextCostLevel, McpContextCost, McpResultCost, McpResultServerCost, McpServerContextCost } from "./context-cost.js";
export {
  CODE_MODE_TOOL_NAME,
  CONTEXT_COST_ALERT_TOKENS,
  CONTEXT_COST_WARN_TOKENS,
  contextCostLevel,
  contextCostSignature,
  estimateContentTokens,
  estimateMessageTokens,
  estimateSchemaTokens,
  isCodeModeTools,
  mcpContextCost,
  mcpResultCost,
  mcpServerOfTool,
  resultCostSignature
} from "./context-cost.js";

export const name = "dsh-project-mcp-manager";
/** agents 为硬依赖：宿主启动早期插件行先于 agents 服务装载时，等待其就绪后再 apply，
 *  保证构造时的 liveAgents 补扫能看到已恢复/已存在的会话。 */
export const inject = ["tools", "agents"];

/** 显式指定 profile 名的环境变量（实现在 dsh-paths.ts，registry 的校验共用）。 */
export { PROFILE_ENV } from "./dsh-paths.js";
/** 覆盖项目层信任模式的环境变量（headless/CI；优先于插件 Config）。 */
export { PROJECT_TRUST_ENV } from "./trust.js";
export type { ProjectTrustMode } from "./trust.js";

/**
 * 插件配置（宿主 Loader 按此校验 bundle 行的 `config`）。
 *
 * `projectTrust` 缺省 `inherit`：与旧行为一致，总是读取项目层三个文件。
 * `allowlist` 时只读取 `$DSH_HOME/mcp-trust.json` 里记录的 workspace；未信任的
 * workspace 连配置文件都不读——`stdio` 行是可执行代码载体，这一步必须在读取前
 * 挡住，而不是读取后再决定装不装。环境变量 `DSH_MCP_PROJECT_TRUST` 优先于此值。
 */
export const Config = Schema.object({
  projectTrust: Schema.union(["inherit", "allowlist"]).default("inherit")
});

export interface PluginConfig {
  projectTrust?: ProjectTrustMode;
}

export function apply(ctx: Context, config: PluginConfig = {}) {
  const registry = new ProjectMcpRegistry(ctx as any, {
    projectTrust: resolveProjectTrustMode(config.projectTrust),
    /** 全局已装载 mcp-client 行的 serverName：从 loader include entry 的
     *  config.patches（dsh-app-boot 传入的已生效 patch 配置，含 bundle 层
     *  与 profile patch 层全部行）提取；loader.entries() 本身只暴露顶层
     *  include entry，子树行必须经 patches 展开。 */
    globalNames: async () => {
      try {
        const loader = (ctx as any).loader;
        if (loader === undefined || typeof loader.entries !== "function") return [];
        const names: string[] = [];
        for (const entry of loader.entries()) {
          const patches = entry?.config?.patches ?? entry?.options?.config?.patches;
          if (!Array.isArray(patches)) continue;
          for (const patch of patches) {
            const rows = Array.isArray(patch?.insert) ? patch.insert : [];
            for (const row of rows) {
              if (row?.name !== MCP_PLUGIN_NAME || row?.disabled === true) continue;
              const serverName = row?.config?.serverName;
              if (typeof serverName === "string" && serverName !== "") names.push(serverName);
            }
          }
        }
        return [...new Set(names)];
      } catch {
        return [];
      }
    },
    /** 当前 profile 名：`DSH_MCP_PROFILE` 优先；否则从 loader 根 include 的
     *  config.path（`<dshHome>/profiles/<name>/cordis.yml`）解析，再退回
     *  `ctx.baseUrl`（同目录）。解析不出返回 undefined → 不读 profile 用户层。 */
    liveWatchMs: 2000,
    activeProfile: async () => {
      const override = process.env[PROFILE_ENV];
      if (typeof override === "string" && override !== "") return override;
      try {
        const loader = (ctx as any).loader;
        if (loader !== undefined && typeof loader.entries === "function") {
          for (const entry of loader.entries()) {
            const resolved = profileNameFromConfigPath(entry?.config?.path ?? entry?.options?.config?.path);
            if (resolved !== undefined) return resolved;
          }
        }
      } catch {
        // 落到 baseUrl 兜底
      }
      return profileNameFromConfigPath((ctx as any).baseUrl);
    }
  });

  // 查询面经 cordis 服务暴露；registry 的装载/清理由其自身在构造时经
  // ctx.on / ctx.effect 注册，provide 同时钉住引用（fiber 卸载时注销服务）。
  ctx.provide(PROJECT_MCP_SERVICE, bindProjectMcpService(registry));
}
