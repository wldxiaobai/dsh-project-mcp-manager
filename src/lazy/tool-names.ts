/** Shared identifiers only: importing these must not load the MCP SDK or registry. */
export const LAZY_TOOL_NAMES = ["mcp_search", "mcp_describe", "mcp_call"] as const;

/** Not a valid serverName, so the shared proxy group cannot collide with a server. */
export const LAZY_PROXY_GROUP_NAME = "[lazy proxies]";
