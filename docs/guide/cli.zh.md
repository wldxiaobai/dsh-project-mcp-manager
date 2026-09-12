# CLI：`dsh-mcp`

[English](cli.md) | 中文

[← 返回 README](../README.zh.md) ｜ 相关：[配置格式](format.zh.md) · [配置来源与分层](layers.zh.md) · [`${VAR}` 展开](env-expansion.zh.md)

原生配置文件命令行管理（**只写** `.dsh/mcp.yml` 或 `.dsh/mcp.json`——从不写遗留的
`.mcp.json`；不连接运行中的 dsh 宿主，宿主经文件监听自动收敛）：

```powershell
dsh-mcp add gitlab npx -y @modelcontextprotocol/server-gitlab -e GITLAB_TOKEN=${GITLAB_TOKEN}
dsh-mcp add --transport http sentry https://mcp.sentry.dev/mcp -H "Authorization: Bearer ${SENTRY_TOKEN}"
dsh-mcp add --scope user shared node ./tools/shared.js        # 写 ~/.dsh/mcp.yml
dsh-mcp add --format json jsonproj node ./tools/p.js          # 写 <项目根>/.dsh/mcp.json
dsh-mcp add --scope profile --profile web shared node ./s.js   # 写 ~/.dsh/profiles/web/mcp.json
dsh-mcp list          # 全部来源层展示，带遮蔽标注
dsh-mcp get gitlab    # 优先层条目；密钥值只显示键名
dsh-mcp remove gitlab # 按优先序在 yml/json 中查找并删除；命中只读层时给出编辑指引
dsh-mcp status        # 层行数、名称与诊断摘要（不连接宿主）
```

作用域：`--scope project`（缺省，写最近 `.git` 祖先下的 `.dsh/mcp.yml`）、
`--scope user`（写 `~/.dsh/mcp.yml`）与 `--scope profile`（须配 `--profile <name>`，
写 `~/.dsh/profiles/<name>/mcp.json`，只支持 JSON）。
**写入格式**：`--format yml|json` 优先于环境变量 `DSH_MCP_CLI_FORMAT`（`yml`|`json`，
缺省 `yml`）；`--format json` 时 project/user 分别写 `.dsh/mcp.json` 与
`~/.dsh/mcp.json`。`add` 的 `cwd` 缺省随作用域而变：project 为 `"."`（项目根），
user/profile 为 `""`（宿主目录）；`-c` 显式覆盖。

**`status`** 读取六层来源文件与诊断文件（`<项目根>/.dsh/.mcp-diag.json` 与
`$DSH_HOME/.mcp-diag.json`）：打印每层行数与名称，再打印最近一次对账的
`summary`（已装载 / 跳过原因 / 不健康行）。不连接宿主内存；宿主从未对账
时文件不存在，命令会说明空态。`--scope project|user` 只过滤层列表，两份
诊断文件仍都会展示。

没有 `local` 作用域——`--scope local` 会报错并解释。`--transport` 接受
`stdio`（缺省）与 `http`；MCP SSE 端点传输（`sse`）拒绝并给出可执行出路
（把 `type` 改为 `"http"`，或删除 `type` 只留 `url`）。

**保留短名**：`-s`/`-t`/`-e`/`-H`/`-c`/`-h` 之外，v0.4.0 起 `-f`（`--format`）与
`-p`（`--profile`）也是本 CLI 的选项。这两个短名会连带吞掉下一个词元作为选项值：
要把它们传给被 spawn 的服务器命令，请写在 `--` 之后（`--` 之后全部按位置参数透传）。
其余以 `-` 开头的未知词元仍原样透传给服务器命令行。

**独占契约**：JSON 文件由本 CLI 独占（宿主插件永不写）。写入保留其他顶层键与键序、
解析失败拒绝覆盖、原子写；`${VAR}` 原样写入，凭据留在环境里（见
[`${VAR}` 展开](env-expansion.zh.md)）。yml 侧走受管块，begin/end 标记之外的内容
逐字节保留。
