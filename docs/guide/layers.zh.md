# 配置来源与分层（六层）

[English](layers.md) | 中文

[← 返回 README](../README.zh.md) ｜ 相关：[配置格式](format.zh.md) · [`${VAR}` 展开](env-expansion.zh.md) · [CLI `dsh-mcp`](cli.zh.md)

插件读取六个来源，按**先到先得**合并。前三层属于**项目层**（按项目装载、按会话
隔离），后三层属于**用户层**（宿主级**全局装载**）：

| 序 | 来源 | 路径 | 语义 |
|---|---|---|---|
| 1 | `dsh-project` | `<projectRoot>/.dsh/mcp.yml` | 项目层（原生受管块，CLI 默认写入） |
| 2 | `dsh-project-json` | `<projectRoot>/.dsh/mcp.json` | 项目层（JSON 方言） |
| 3 | `cc-project` | `<projectRoot>/.mcp.json` | 项目层，**遗留只读**（Claude Code 项目文件） |
| 4 | `dsh-profile-user` | `~/.dsh/profiles/<当前 profile>/mcp.json` | **全局**（能解析出运行中的 profile 名时） |
| 5 | `dsh-user-yml` | `~/.dsh/mcp.yml` | **全局**（原生用户层） |
| 6 | `dsh-user` | `~/.dsh/mcp.json` | **全局**（JSON 用户层） |

第 4 层是动态层：profile 名在运行时解析，插件里不硬编码任何 profile 名。第
1/2 层与 JSON 用户层的文件写法见 [配置格式](format.zh.md)。

**全局装载 vs 项目装载**：

- 项目层行：每个项目各挂一个 `mcp-client` 实例，经 `tools.restrict({ deny })` 只对
  该项目 cwd 的会话可见。
- 用户层行：**宿主级只挂一条连接**，与项目数量无关，对所有会话可见；不再按项目
  fan-out。空 `cwd` 继承宿主工作目录（项目层空 `cwd` = 项目根）。
- **项目侧压制**：某个项目的自身行（同名、归一化同名或同服务身份）遮蔽了某条用户层
  行时，**该项目的会话**会 deny 掉那条全局服务器的工具，其他项目照常可见；全局实例
  仍然只有一条。
- 与 profile patch 行里的全局 mcp-client 服务器同名时，用户层行**跳过**并在快照里记
  `skipReason: "name-taken"`（不改名，避免 `serverName` 预留冲突）。

**影子优先序**——按上表 1→6 先到先得合并，后到行与已收录行命中**三把键中的任何
一把**即被遮蔽：精确 `serverName`；*归一化名称*（转小写去掉非字母数字后相同
——`unityMCP` 与 `unity-mcp` 就是一台服务器的两种写法）；*服务身份*
（`stdio` 取 command + args，Windows 下路径大小写不敏感；`streamable-http`
取 url）。command/url 为空的行不注册身份键——`node a.js` 与 `node b.js` 是
不同服务、绝不互杀——而 `disabled` 占位行三键全占、自身不装载。身份比对用的
是**文件里的原始字符串，发生在 `${VAR}` 展开之前**，且 `env`、`headers`、
`cwd` **不参与**身份键：同一命令行、仅 env 不同的两台真不同服务器仍会被去重
（只留高优先级一条），同一台服务器一条写 `${VAR}`、一条写字面量则**不**互认。
误剔时的处置：给被剔行改名（归一化后不同）或调整命令与参数。被遮蔽方写入
`.dsh/.mcp-diag.json`（`shadowedByYml` / `shadowedByProject` /
`shadowedIdentity`），身份/归一名去重剔除的每行还会在宿主日志告警「跳过重复
服务定义」。用户层行的诊断写入 `~/.dsh/.mcp-diag.json`。

项目层同名行与用户层行撞名时，项目行按生效名规则改为 `p<hash>_<名>`，全局行保持
原名；该项目的会话同时 deny 掉全局那条的工具（项目侧压制）。

## 遗留 Claude Code 层（只读）

- `<projectRoot>/.mcp.json` 仍被读取（层 3，低优先级），CC 用户无需迁移；设
  `DSH_MCP_IGNORE_MCP_JSON=1` 可整层停用。
- `~/.claude.json` **不再读取**（v0.4.0 起）：那是 Claude 的用户态单体文件，混存
  凭据与项目历史。请把其中的服务器迁移到 `~/.dsh/mcp.json` 或
  `~/.dsh/profiles/<name>/mcp.json`。旧开关 `DSH_MCP_READ_CLAUDE_USER` 与
  `DSH_MCP_IGNORE_CLAUDE_JSON` 已移除（设置它们不再有任何效果）。
- **没有 local 作用域**。CC 的 `claude mcp add` 默认写进 `~/.claude.json` 的
  `projects.<cwd>.mcpServers`（local 层），本插件不读取该层；请用
  `dsh-mcp add --scope user` 或项目文件。
- `type: "sse"` 条目是 **MCP SSE 端点传输**，按条目报错跳过并给出可执行诊断——
  装载后端（`dsh-mcp-client`）只支持 `stdio` 与 `streamable-http`。服务端已
  支持 Streamable HTTP 时把 `type` 改为 `"http"`；或删除 `type` 只留 `url`
  （本插件按 streamable-http 推断）。没有隐式回退。CC 的 `type: "http"` 与显式
  `type: "streamable-http"` 都映射为 `streamable-http`；缺省 `type` 时，
  只带 `url` 不带 `command` 的条目按 http 处理，其余视为 stdio。
- 坏文件/坏条目不影响其他服务器，且**按源隔离**：`.mcp.json` 坏了不会卸掉
  同项目的 yml 行（反之亦然）；条目错误写入 `.dsh/.mcp-diag.json` 与宿主
  日志（诊断从不带文件内容）。
- `enabled: false` 静默跳过、**不占名**（生态通行写法）；`disabled: true` **占住
  影子键但不装载**——禁用意味着"这个名字不许跑"，而不是"让位给别的副本"。
  该口径自 v0.4.0 起对全部 JSON 来源统一（含遗留 `.mcp.json`；此前遗留层的
  `disabled: true` 是静默跳过、不占名）。要把某台服务器在所有层压住，请在
  `.dsh/mcp.yml` 留一条 `disabled: true` 占位行。
- 自 v0.4.0 起，遗留层与 DSH JSON 层走同一个读取器，因此还有两处行为变化：
  条目里显式写的 `cwd` 现在**生效**（旧实现一律强制为项目根，仅缺省或空串时
  才落到项目根）；DSH 透传键 `toolCallTimeoutMs`/`failOnStartupError`/`reconnect`
  在遗留文件里也**生效**（旧实现忽略）。两者都只在条目显式给出时改变行为。
