# dsh-project-mcp-ui

Settings tab for [dsh-project-mcp-manager](https://github.com/wldxiaobai/dsh-project-mcp-manager). It lists every MCP server the loader can read, and writes only the managed `mcp.yml` for that scope.

Install both packages into the web profile:

```powershell
dsh plugin --profile web add dsh-project-mcp-manager@0.7.2 dsh-project-mcp-ui@0.7.2
```

The page is a Plugins settings tab. Disable the `mcp-project-ui` row to hide it; the loader keeps running. A headless profile does not need this package.
