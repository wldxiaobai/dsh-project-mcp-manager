/**
 * dsh-project-mcp-manager —— MCP 行运行时状态读取（工具计数）。
 */
/** 统计某 serverName 当前在全局工具层注册的工具数（前缀 mcp__<serverName>__）。 */
export function mcpToolCount(ctx: any, serverName: string): number {
  const tools = ctx?.tools;
  if (tools === undefined || typeof tools.schemas !== "function") return 0;
  const prefix = `mcp__${serverName}__`;
  const schemas = tools.schemas();
  return Array.isArray(schemas) ? schemas.filter((schema) => typeof schema?.name === "string" && schema.name.startsWith(prefix)).length : 0;
}
