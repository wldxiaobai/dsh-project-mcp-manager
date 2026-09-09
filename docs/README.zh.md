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
dsh plugin --profile web add dsh-project-mcp-manager@0.2.0
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

> **dsh ≥ 0.1.2 注意**：插件是否生效取决于 profile 的 `dsh.profile.bundles`，
> 而单纯 `pnpm add link:` **不会**把包写进 bundles。方式一/方式二会自动补齐；
> 若你手写了 pnpm 命令，请再跑一次任意 `dsh plugin --profile web list`（或
> `--dump-config` 检查合成结果里有没有 `dsh-project-mcp-manager` 行）触发
> bundle reconcile。

**升级/锁定版本**：重跑方式一的 `add` 命令并带上目标版本后缀——`@latest`
升级到最新，`@0.2.0` 锁定到指定版本。

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

## 配置来源与分层（六层）

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

**JSON 方言**与生态一致（Cursor / Claude Code 的 `mcpServers` 写法）：

```json
{
  "mcpServers": {
    "gitlab": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-gitlab"],
                "env": { "GITLAB_TOKEN": "${GITLAB_TOKEN}" }, "cwd": "." },
    "sentry": { "url": "https://mcp.sentry.dev/mcp",
                "headers": { "Authorization": "Bearer ${SENTRY_TOKEN}" } }
  }
}
```

- `command`/`args`/`env`/`cwd` 为 stdio；`url`/`headers` 为 streamable-http；
  可选 `type`（`stdio`|`http`|`streamable-http`；`sse` 逐条拒绝）、DSH 透传键
  `toolCallTimeoutMs`/`failOnStartupError`/`reconnect`、`enabled: false`
  （静默跳过、不占名）与 `disabled: true`（占名但不装载）。
- 未知键容忍忽略；名字须匹配 `[A-Za-z0-9_-]{1,32}`；坏条目逐条报错、不影响其余。
- **JSON 文件由 `dsh-mcp` CLI 独占**：写入保留其他顶层键与键序，但 JSON 没有注释，
  排版与注释不被保留。插件本身**只读**，宿主永不写这些文件。
- `${VAR}` 与其他来源同语义（装载时展开，见下文）。

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

### 遗留 Claude Code 层（只读）

- `<projectRoot>/.mcp.json` 仍被读取（层 3，低优先级），CC 用户无需迁移；设
  `DSH_MCP_IGNORE_MCP_JSON=1` 可整层停用。
- `~/.claude.json` **不再读取**（v0.4.0 起）：那是 Claude 的用户态单体文件，混存
  凭据与项目历史。请把其中的服务器迁移到 `~/.dsh/mcp.json` 或
  `~/.dsh/profiles/<name>/mcp.json`。旧开关 `DSH_MCP_READ_CLAUDE_USER` 与
  `DSH_MCP_IGNORE_CLAUDE_JSON` 已移除（设置它们不再有任何效果）。
- **没有 local 作用域**。CC 的 `claude mcp add` 默认写进 `~/.claude.json` 的
  `projects.<cwd>.mcpServers`（local 层），本插件不读取该层；请用
  `dsh-mcp add --scope user` 或项目文件。
- `type: "sse"` 条目按条目报错跳过——装载后端（`dsh-mcp-client`）只支持
  `stdio` 与 `streamable-http`。CC 的 `type: "http"` 与显式
  `type: "streamable-http"` 都映射为 `streamable-http`；缺省 `type` 时，
  只带 `url` 不带 `command` 的条目按 http 处理，其余视为 stdio。
- 坏文件/坏条目不影响其他服务器，且**按源隔离**：`.mcp.json` 坏了不会卸掉
  同项目的 yml 行（反之亦然）；条目错误写入 `.dsh/.mcp-diag.json` 与宿主
  日志（诊断从不带文件内容）。
- CC 侧的 `enabled: false` 与 `disabled: true` 都静默跳过、**不占名**；原生 yml/json
  里的 `disabled: true` 仍**占住影子键**（禁用意味着"这个名字不许跑"，而不是
  "让位给别的副本"）。要把某台服务器在所有层压住，请在 `.dsh/mcp.yml` 留一条
  `disabled: true` 占位行。

## `${VAR}` 展开

以上任一来源中，`command`、`args[*]`、`env[*]`、`cwd`、`url`、`headers[*]` 里的
`${VAR}` 引用（正则 `\$\{[A-Za-z_][A-Za-z0-9_]*\}`，允许出现在字符串任意
位置）在装载时刻从 dsh 宿主进程环境做**串内插值**——与 Claude Code 同语义，
`"Authorization": "Bearer ${TOKEN}"` 这类写法可用。变量未设置**或为空串**时
该行跳过装载，诊断记 `env-missing` 并只带变量名（绝不带值）；需要保留字面
`${NAME}` 的写法目前不可表达。含引用的 `url` 在装载前的 schema 校验里任意
位置都放行（包括 host 段，如 `https://${HOST}/mcp`）——合法性只在展开后判定：
展开结果会再过一遍装载 schema 复验，产出非法配置（如 `${GATEWAY}/mcp` 拼出
非 URL）时以 `env-invalid` 跳过，不把坏值递给装载后端。快照/行视图里
`fiberPhase` 保持装载生命周期枚举（未挂上的行是 `pending`），跳过原因走独立
的 `skipReason` 字段（`env-missing` / `env-invalid` / `config-invalid` /
`plugin-throw`）。插件任何写路径都不落盘展开后的值；
CLI 写入时 `${VAR}` 原样保留——配置可以进 git，凭据留在环境里。

## CLI：`dsh-mcp`

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
```

作用域：`--scope project`（缺省，写最近 `.git` 祖先下的 `.dsh/mcp.yml`）、
`--scope user`（写 `~/.dsh/mcp.yml`）与 `--scope profile`（须配 `--profile <name>`，
写 `~/.dsh/profiles/<name>/mcp.json`，只支持 JSON）。
**写入格式**：`--format yml|json` 优先于环境变量 `DSH_MCP_CLI_FORMAT`（`yml`|`json`，
缺省 `yml`）；`--format json` 时 project/user 分别写 `.dsh/mcp.json` 与
`~/.dsh/mcp.json`。`add` 的 `cwd` 缺省随作用域而变：project 为 `"."`（项目根），
user/profile 为 `""`（宿主目录）；`-c` 显式覆盖。
没有 `local` 作用域——`--scope local` 会报错并解释。`--transport` 接受
`stdio`（缺省）与 `http`；`sse` 拒绝（后端不支持）。

## 工作原理

- **项目发现**：在线 agent 会话的 `session.header.cwd` + dsh 进程启动目录 →
  向上找最近的含 `.git` 的祖先目录作为项目根（无 `.git` 时退回目录本身）。
- **装载**：项目层每个 `(项目, serverName)` 在宿主 ctx 上装载一个
  `@deepseek-ai/dsh-mcp-client` 实例（`ctx.plugin`），注册进全局工具层，同一
  项目内多会话共享同一连接；**用户层每行只装载一个实例**（全局，与项目数无关）。
- **热重载**：chokidar 监听各项目根（depth 2，忽略 node_modules/.git/.hg/
  .svn），但只有**已知项目根的精确配置文件**（`<projectRoot>/.dsh/mcp.yml`、
  `<projectRoot>/.dsh/mcp.json` 与 `<projectRoot>/.mcp.json`）的改动经 150ms
  防抖触发全量对账：新增行装载、删除行卸载、配置变化重装。另有独立 watcher 以
  **精确文件路径**监听用户层：`~/.dsh/mcp.yml`、`~/.dsh/mcp.json` 与
  `~/.dsh/profiles/<当前 profile>/mcp.json`（chokidar v5 对被监听的缺失文件能在
  其创建时补发事件，前提是父目录已存在）——不监听家目录整体。
- **profile 名解析**：从 loader 根 include 的 `config.path`
  （`~/.dsh/profiles/<name>/cordis.yml`）或 `ctx.baseUrl` 推导，可用
  `DSH_MCP_PROFILE=<name>` 覆盖；解析不出时不读 profile 层（其余层照常）。
- **生效名**：原始 `serverName` 在整个目录（宿主全局行 + 全部项目行）中唯一时
  保持原名；冲突时**项目行**改为 `p<sha256(项目根)前6位>_<原名>`（截断 32 字符，
  确定性、与装载顺序无关），避免 `dsh-mcp-client` 按进程根的 serverName
  预留冲突。全局行（profile patch 行与用户层行）参与占用判定但不改名。模型可见
  的工具名由生效服务器名与 MCP 工具自身的名字拼成 `mcp__<生效名>__<工具名>`，
  与文件里写的 `serverName` 可能不同。
- **会话可见性**：agent 创建时按其会话 cwd 解析项目，对该 agent 应用
  `tools.restrict({ deny })`，deny 掉除本会话项目外的全部项目服务器，以及本项目
  自身行压制过的全局服务器；会话无 cwd 时回退 owner 项目（子代理），再回退 dsh
  进程 cwd 所在项目。会话销毁时释放。

## 安全边界

`.dsh/mcp.yml`、`.dsh/mcp.json` 与 `.mcp.json` 中的 `stdio` 行会在 dsh
宿主进程内 spawn 其 `command`——配置文件是**可执行代码载体**，只应在可信项目
中添加。用户层（`~/.dsh/mcp.yml`、`~/.dsh/mcp.json`、profile json）同样是可执行
代码载体，只是它们属于你自己的机器：用户层行会以**全局**方式装载（宿主级一条
连接，所有项目可见），不再按项目 fan-out。装载失败/配置无效行仅告警跳过，不影响
其他服务器。`~/.claude.json` 这类 Claude 用户态单体文件（混存凭据与项目历史）
自 v0.4.0 起**完全不再读取**。
