/**
 * dsh-project-mcp-manager —— MCP 行运行时状态读取（工具计数与预算）。
 */
export const TOOL_BUDGET_WARN_ENV = "DSH_MCP_TOOL_BUDGET_WARN";
export const DEFAULT_TOOL_BUDGET_COUNT = 200;
export const DEFAULT_TOOL_BUDGET_BYTES = 256 * 1024;

/** `DSH_MCP_TOOL_BUDGET_WARN`：`工具数` 或 `工具数,字节数`；缺省 200 / 256KiB。 */
export function parseToolBudgetWarn(raw: string | undefined = process.env[TOOL_BUDGET_WARN_ENV]): { maxTools: number; maxBytes: number } {
  if (raw === undefined || raw.trim() === "") return { maxTools: DEFAULT_TOOL_BUDGET_COUNT, maxBytes: DEFAULT_TOOL_BUDGET_BYTES };
  const [countPart, bytesPart] = raw.split(",");
  const maxTools = Number.parseInt(countPart.trim(), 10);
  const maxBytes = bytesPart === undefined || bytesPart.trim() === "" ? DEFAULT_TOOL_BUDGET_BYTES : Number.parseInt(bytesPart.trim(), 10);
  return {
    maxTools: Number.isFinite(maxTools) && maxTools > 0 ? maxTools : DEFAULT_TOOL_BUDGET_COUNT,
    maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_TOOL_BUDGET_BYTES
  };
}

function schemaToolId(schema: any): string {
  return typeof schema?.name === "string" ? schema.name : typeof schema?.id === "string" ? schema.id : "";
}

/** 统计某 serverName 当前在全局工具层注册的工具数（前缀 mcp__<serverName>__）。 */
export function mcpToolCount(ctx: any, serverName: string): number {
  return mcpToolBudgetStats(ctx, serverName).tools;
}

/** 某生效名下已注册工具的数量与描述/schema 字节（只读，不裁剪）。 */
export function mcpToolBudgetStats(ctx: any, serverName: string): { tools: number; bytes: number } {
  const toolsLayer = ctx?.tools;
  if (toolsLayer === undefined || typeof toolsLayer.schemas !== "function") return { tools: 0, bytes: 0 };
  const prefix = `mcp__${serverName}__`;
  const schemas = toolsLayer.schemas();
  if (!Array.isArray(schemas)) return { tools: 0, bytes: 0 };
  let tools = 0;
  let bytes = 0;
  for (const schema of schemas) {
    const id = schemaToolId(schema);
    if (!id.startsWith(prefix)) continue;
    tools += 1;
    const desc = typeof schema?.description === "string" ? schema.description : "";
    const payload = schema?.inputSchema ?? schema?.parameters ?? schema;
    let extra = 0;
    try {
      extra = Buffer.byteLength(JSON.stringify(payload), "utf8");
    } catch {
      extra = 0;
    }
    bytes += Buffer.byteLength(id, "utf8") + Buffer.byteLength(desc, "utf8") + extra;
  }
  return { tools, bytes };
}
