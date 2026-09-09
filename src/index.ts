/**
 * dsh-project-mcp-manager —— 独立项目级 MCP 自动加载插件（宿主半区，无 UI）。
 *
 * 用法：在项目根创建 <projectRoot>/.dsh/mcp.yml（格式与 profile
 * cordis.patch.yml 的受管块一致），在该项目开启 dsh 会话时自动装载其中的
 * MCP 服务器（经 @deepseek-ai/dsh-mcp-client），文件改动经 watch 热重载。
 *
 * 装载模型见 README 与 docs/configuration-layers.md；运行时行为见 registry.ts
 * 的类注释。
 */
import { Context } from "@deepseek-ai/cordis";
import { MCP_PLUGIN_NAME } from "./mcp-file.js";
import { ProjectMcpRegistry, profileNameFromConfigPath } from "./registry.js";

export const name = "dsh-project-mcp-manager";
/** agents 为硬依赖：宿主启动早期插件行先于 agents 服务装载时，等待其就绪后再 apply，
 *  保证构造时的 liveAgents 补扫能看到已恢复/已存在的会话。 */
export const inject = ["tools", "agents"];

/** 显式指定 profile 名的环境变量（覆盖自动解析；CLI/无 profile 启动场景用）。 */
export const PROFILE_ENV = "DSH_MCP_PROFILE";

export function apply(ctx: Context) {
  const registry = new ProjectMcpRegistry(ctx as any, {
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

  // registry 的装载/清理全部由其自身在构造时经 ctx.on / ctx.effect 注册，
  // 此处只需保持引用存活（apply 作用域 + registry 内部 fiber 持有）。
  void registry;
}
