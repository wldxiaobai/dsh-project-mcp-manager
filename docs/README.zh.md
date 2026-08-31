# dsh-project-mcp-manager

[English](../README.md) | 中文

项目级 MCP 自动加载插件：在项目根 `<projectRoot>/.dsh/mcp.yml` 写入 MCP
服务器配置，在该项目开启 dsh 会话时自动装载（经官方
`@deepseek-ai/dsh-mcp-client`），文件改动热重载到运行中的 dsh 进程，并按
会话 cwd 控制工具可见性。无 UI，仅具备核心功能。

## 安装（挂载到 profile）

插件通过 **bundle patch** 挂载：把包加入 `dsh.profile.bundles` 后，dsh 启动时
按顺序合成每个 bundle 的 patch（`dsh.bundle.patch` 指向的 `cordis.patch.yml`）
作为插件行。

**前置：安装 dsh 本体**（尚未安装 dsh 的用户）：

```powershell
npm install -g @deepseek-ai/dsh        # npm 官方包
npm install -g deepseek-ai/dsh         # 或从 GitHub 源码安装
```

**方式一：dsh 插件命令（推荐）**——`dsh plugin` 在 profile 目录内转发 pnpm，
负责安装/升级依赖：

```powershell
# 安装最新版（web profile 示例；headless 等其他 profile 替换名字即可）
dsh plugin --profile web add dsh-project-mcp-manager@latest

# 安装指定版本（版本号可先 npm view dsh-project-mcp-manager versions 查看）
dsh plugin --profile web add dsh-project-mcp-manager@0.1.0
```

**方式二：直接 pnpm 安装**（与方式一等价）：

```powershell
# dshHome 默认为 %USERPROFILE%\.dsh（设置了 DSH_HOME 则用其值）
cd $env:USERPROFILE\.dsh\profiles\web
pnpm add dsh-project-mcp-manager@latest
```

**方式三：本地开发安装**（junction 实时同步源码，改代码即生效）：

```powershell
cd $env:USERPROFILE\.dsh\profiles\web
pnpm add link:<你的 dsh-mcp-project 源码目录>   # 例如 D:\dev\dsh-mcp-project
```

**升级/锁定版本**：重跑方式一的 `add` 命令并带上目标版本后缀——`@latest`
升级到最新，`@0.1.0` 锁定到指定版本。

## 构建与测试

```powershell
npm install
npm run build     # tsc → lib/
npm test          # node 直跑 test/ 下五个 .mjs（model / mcp-file / cc-file / registry / cli）
```

## 配置格式

`<projectRoot>/.dsh/mcp.yml`，格式与 profile `cordis.patch.yml` 的受管块
一致（begin/end 标记之间的 YAML insert 列表），每行一个 MCP 服务器：

```yaml
# >>> dsh-project-mcp-manager:mcp:begin
- insert:
    - id: panel-mcp-gitlab
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: gitlab
        transport: stdio
        command: npx
        args: ['-y', '@modelcontextprotocol/server-gitlab']
        cwd: .            # 相对项目根解析
        toolCallTimeoutMs: 60000
        failOnStartupError: false
        reconnect:
          enabled: true
          initialDelayMs: 500
          maxDelayMs: 30000
          maxAttempts: 10
# <<< dsh-project-mcp-manager:mcp:end
```

`transport` 支持 `stdio`（command/args/env/cwd）与 `streamable-http`
（url/headers）。行加 `disabled: true` 即停用。标记之外的内容逐字节保留。

**与原生 cordis 方言的差异**：`!!js` 标签（profile 的 `cordis.patch.yml` 由
Loader 求值的 js-yaml 表达式，如官方 README 示例 `env: { TOKEN: !!js
process.env.GITHUB_TOKEN }`）在项目文件里**不支持**——受管块内出现未解析
标签会使该文件整体报错跳过（写入 `.dsh/.mcp-diag.json` 并打日志），不会把
表达式当字面量字符串静默装载。`env`/`headers` 的值 otherwise 是字面量，仅
`${VAR}` 引用会在装载时做串内插值（见下文「${VAR} 展开」）；`disabled` 只能是
`true`/`false`。反之项目文件是超集语法：`env`/`headers` 允许 `KEY: null`
表示删除该键（装载时被剔除），这在官方 mcp-client 校验里会被拒绝——把这类
行原样挪回 `cordis.patch.yml` 会装载失败。

## Claude Code 兼容层（只读）

为顺应 CC 用户习惯，插件会**装载**以下两个 CC 配置位置，但从不写入它们：

- `<projectRoot>/.mcp.json` —— CC 的 project 层文件（`{ "mcpServers": { … } }`）。
- `~/.claude.json` —— 只读取**顶层 `mcpServers`** 子树（严格 allowlist：
  该文件是 CC 的整体状态库，其中的 oauth 凭据、项目历史、UI 状态一律不读入
  配置、不写、不打日志、不在任何输出里回显）。

边界与限制：

- **没有 local 作用域**。CC 的 `claude mcp add` 默认写进 `~/.claude.json` 的
  `projects.<cwd>.mcpServers`（local 层），本插件不读取该层；请用
  `dsh-mcp add --scope user` 或项目文件。
- `type: "sse"` 条目按条目报错跳过——装载后端（`dsh-mcp-client`）只支持
  `stdio` 与 `streamable-http`。CC 的 `type: "http"` 与显式
  `type: "streamable-http"` 都映射为 `streamable-http`；缺省 `type` 时，
  只带 `url` 不带 `command` 的条目按 http 处理，其余视为 stdio。
- stdio 的 `cwd`：项目层行的空 `cwd` 解析为项目根；用户层行
  （`~/.dsh/mcp.yml` 与 `~/.claude.json`）解析为 dsh 宿主的工作目录——
  用户层 MCP 是一份共享服务器，不是每个项目根各一份。
- 未知 CC 键容忍忽略；`enabled: false` 静默跳过该条目（不记诊断，也不占名）。
- 原生 yml 里 `disabled: true` 的行仍**占名遮蔽**下层同名行：下层副本一并
  不装载——禁用意味着"这个名字不许跑"，而不是"让位给 CC 副本"。CC 侧的
  `enabled: false` 没有占位效果。
- 坏文件/坏条目不影响其他服务器，且**按源隔离**：`.mcp.json` 坏了不会卸掉
  同项目的 yml 行（反之亦然）；条目错误写入 `.dsh/.mcp-diag.json` 与宿主
  日志（诊断从不带文件内容）。只有 `.mcp.json`、没用过原生 yml 的项目，
  一旦有可报内容也会创建 `.dsh/` 目录。
- CC 每次会话都会重写 `~/.claude.json`；watcher 会对该文件做
  `mcpServers` 子树的规范化哈希门控——子树没变就不触发对账。
- 逃生门：在 dsh 宿主环境设置 `DSH_MCP_IGNORE_CLAUDE_JSON=1` 可完全禁用对
  `~/.claude.json` 的读取与监听。

**影子优先序**（同名服务器先到先得，被遮蔽方写入
`.dsh/.mcp-diag.json` 的 `shadowedByYml` / `shadowedByProject`）：

1. `<projectRoot>/.dsh/mcp.yml`（原生格式，面板/CLI 管理）
2. `<projectRoot>/.mcp.json`（CC project 层）
3. `~/.dsh/mcp.yml`（原生用户层，见 CLI）
4. `~/.claude.json` 顶层 `mcpServers`（CC user 层）

用户层行适用于所有已知项目，因此「某项目与用户层同名」（或两个项目同名）
会走常规的生效名冲突改名规则（见工作原理）。

## `${VAR}` 展开

以上任一来源中，`command`、`args[*]`、`env[*]`、`url`、`headers[*]` 里的
`${VAR}` 引用（正则 `\$\{[A-Za-z_][A-Za-z0-9_]*\}`，允许出现在字符串任意
位置）在装载时刻从 dsh 宿主进程环境做**串内插值**——与 Claude Code 同语义，
`"Authorization": "Bearer ${TOKEN}"` 这类写法可用。变量未设置**或为空串**时
该行跳过装载，诊断记 `env-missing` 并只带变量名（绝不带值）；需要保留字面
`${NAME}` 的写法目前不可表达。展开后的输入会再过一遍装载 schema 复验，产出
非法配置（如 `${GATEWAY}/mcp` 拼出非 URL）时以 `env-invalid` 跳过，不把坏值
递给装载后端。快照/行视图里装载失败的行显示具体跳过原因（`env-missing` /
`env-invalid` 等），不再是恒 `pending`。插件任何写路径都不落盘展开后的值；
CLI 写入时 `${VAR}` 原样保留——配置可以进 git，凭据留在环境里。

## CLI：`dsh-mcp`

CC 风格的原生文件命令行管理（**只写** `.dsh/mcp.yml`——从不写
`.mcp.json` / `~/.claude.json`；不连接运行中的 dsh 宿主，宿主经文件监听自动
收敛）：

```powershell
dsh-mcp add gitlab npx -y @modelcontextprotocol/server-gitlab -e GITLAB_TOKEN=${GITLAB_TOKEN}
dsh-mcp add --transport http sentry https://mcp.sentry.dev/mcp -H "Authorization: Bearer ${SENTRY_TOKEN}"
dsh-mcp add --scope user shared node ./tools/shared.js   # 写 ~/.dsh/mcp.yml
dsh-mcp list          # 四个来源全展示，带遮蔽标注
dsh-mcp get gitlab    # 优先层条目；密钥值只显示键名
dsh-mcp remove gitlab # 只动原生 yml；命中只读层时给出编辑指引
```

作用域：`--scope project`（缺省，写最近 `.git` 祖先下的
`.dsh/mcp.yml`）与 `--scope user`（写 `~/.dsh/mcp.yml`，装载进每个项目）。
`add` 的 `cwd` 缺省随作用域而变：project 为 `"."`（项目根），user 为 `""`
（宿主目录）；`-c` 显式覆盖。
没有 `local` 作用域——`--scope local` 会报错并解释。`--transport` 接受
`stdio`（缺省）与 `http`；`sse` 拒绝（后端不支持）。

## 工作原理

- **项目发现**：在线 agent 会话的 `session.header.cwd` + dsh 进程启动目录 →
  向上找最近的含 `.git` 的祖先目录作为项目根（无 `.git` 时退回目录本身）。
- **装载**：每个 `(项目, serverName)` 在宿主 ctx 上装载一个
  `@deepseek-ai/dsh-mcp-client` 实例（`ctx.plugin`），注册进全局工具层。
  同一项目内多会话共享同一连接。
- **热重载**：chokidar 监听各项目根（depth 2，忽略 node_modules/.git/.hg/
  .svn），`.dsh/mcp.yml` 或 `.mcp.json` 的增删改经 150ms 防抖触发全量对账：
  新增行装载、删除行卸载、配置变化重装。另有独立 watcher 监听用户层：
  `~/.dsh` 目录（新建的 `~/.dsh/mcp.yml` 也能被发现）与 `~/.claude.json`
  单文件——不监听家目录整体——事件先过文件 stat 快路径，再走上文哈希门。
- **生效名**：原始 `serverName` 在整个目录（全局行 + 全部项目行；每个项目的
  行集合含遮蔽后幸存的用户层行）中唯一时
  保持原名；冲突时双方都改为 `p<sha256(项目根)前6位>_<原名>`（截断 32 字符，
  确定性、与装载顺序无关），避免 `dsh-mcp-client` 按进程根的 serverName
  预留冲突。全局行（profile `cordis.patch.yml` / bundle 层已装载的
  mcp-client 行）参与占用判定但不改名。模型可见的工具名由生效服务器名与
     MCP 工具自身的名字拼成 `mcp__<生效名>__<工具名>`，与文件里写的 `serverName` 可能不同。
- **会话可见性**：agent 创建时按其会话 cwd 解析项目，对该 agent 应用
  `tools.restrict({ deny })`，deny 掉除本会话项目外的全部项目服务器；会话
  无 cwd 时回退 owner 项目（子代理），再回退 dsh 进程 cwd 所在项目。会话
  销毁时释放。

## 安全边界

`.dsh/mcp.yml` 中的 `stdio` 行（以及经兼容层装载的 `.mcp.json` 行）会在 dsh
宿主进程内 spawn 其 `command`——项目文件是**可执行代码载体**，只应在可信项目
中添加。装载失败/配置无效行仅告警跳过，不影响其他服务器。`~/.claude.json`
之所以按严格 allowlist 只读，正是因为该文件还存放凭据：其中未使用的部分
不会被读出、写入任何文件，也不会在 CLI 或诊断输出里出现。
