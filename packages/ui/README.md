# dsh-project-mcp-ui

Settings tab for [dsh-project-mcp-manager](https://github.com/wldxiaobai/dsh-project-mcp-manager). It lists the servers the loader will run, and writes only the managed `mcp.yml` for that scope. A same-name copy in another file stays as a note on that card. A non-yml row with a different name but the same command and arguments, or the same URL, is left off the list. Add MCP opens a form and writes the row; MCP config stays beside it and opens the file for anything the form does not cover.

Install both packages into the web profile:

```powershell
dsh plugin --profile web add dsh-project-mcp-manager@0.7.2 dsh-project-mcp-ui@0.7.2
```

The page is a Plugins settings tab. Disable the `mcp-project-ui` row to hide it; the loader keeps running. A headless profile does not need this package.
