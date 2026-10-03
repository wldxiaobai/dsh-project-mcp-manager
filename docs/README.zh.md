# dsh-project-mcp-manager

[English](../README.md) | 中文

项目级 MCP 自动加载插件：在项目根 `<projectRoot>/.dsh/mcp.yml` 或
`.dsh/mcp.json` 写入 MCP 服务器配置，在该项目开启 dsh 会话时自动装载（经官方
`@deepseek-ai/dsh-mcp-client`），文件改动热重载到运行中的 dsh 进程，并按
会话 cwd 控制工具可见性。`dsh-project-mcp-manager` 的默认 bundle 包含装载器和
配套包 `dsh-project-mcp-ui` 提供的 web 端与桌面端设置页。UI 默认启用，可以
单独停用；装载器继续工作。

**能力边界**（dsh ≥ 0.2.0-rc.2）：协议、重连、工具名、resources 与服务器
instructions 归官方 client。发行版 profile 已经装了共享的 MCP 资源工具。官方
配置是 profile 层 Cordis patch（该层自有 HMR）加上 `plugin_manager`。宿主还没做、
仍由本插件负责的是：

1. 项目级发现：`<projectRoot>/.dsh/mcp.yml`、`.dsh/mcp.json`，以及只读的遗留
   `.mcp.json`。
2. 按会话 cwd 隔离工具可见性。
3. MCP 专用配置格式、`dsh-mcp` CLI 和设置页。

项目文件热重载是本插件自己的文件监听，不替代官方 profile HMR。**传输类型由官方
client 决定。** v0.7.x 与 v0.8.x 面向 dsh `0.2.0` 线（从 0.2.0-rc.2 起）。仍在 dsh 0.1.5
上的宿主继续用插件 v0.6.0。

若这个插件对你有帮助，欢迎给仓库点一颗
[star](https://github.com/wldxiaobai/dsh-project-mcp-manager)。遇到问题、宿主
不适配或有想法，请开
[Issue](https://github.com/wldxiaobai/dsh-project-mcp-manager/issues)——哪怕几句话也很有用。

## 文档

功能说明已拆分到 `docs/`，中英双版并存：

- [配置格式](guide/format.zh.md)——原生 YAML 受管块、JSON 方言、与
  cordis 方言的差异。
- [设置页](guide/settings-ui.zh.md)——使用默认包含的 UI、看懂服务器列表、添加服务器
  （含从剪贴板填入）、开关、删除与管理工具。
- [配置来源与分层](guide/layers.zh.md)——七层来源模型、影子优先序、
  全局装载 vs 项目装载，以及只读的遗留 Claude Code 层。
- [`${VAR}` 展开](guide/env-expansion.zh.md)——装载时插值与对应诊断。
- [CLI `dsh-mcp`](guide/cli.zh.md)——作用域、写入格式与独占契约。
- [查询面](guide/service.zh.md)——`ctx.projectMcp`、`projectMcp/updated` 事件、
  包入口导出的视图类型，以及对配套 UI 的语义化版本承诺。

设计与发布记录（中文）：[dsh 0.2.0-rc.2 适配记录](design/adaptation-dsh-0.2.0-rc.2.md) ·
[dsh 0.1.6-alpha.2 适配方案](design/adaptation-dsh-0.1.6-alpha.2.md) ·
[dsh 0.1.5-rc.2 适配记录](design/adaptation-dsh-0.1.5-rc2.md) ·
[dsh 0.1.5-rc.1 适配记录](design/adaptation-dsh-0.1.5-rc1.md) ·
[dsh 0.1.2-rc.1 适配记录](design/adaptation-dsh-0.1.2-rc1.md) ·
[JSON 配置层设计提案](design/proposal-json-mcp-config.md) ·
[运行时稳健性与 JSON 互通提案](design/proposal-runtime-robustness-and-json-interop.md) ·
[v0.7.2 发布说明](releases/v0.7.2.md) ·
[v0.7.1 发布说明](releases/v0.7.1.md) ·
[v0.7.0 发布说明](releases/v0.7.0.md) ·
[v0.6.0 发布说明](releases/v0.6.0.md) ·
[v0.4.3 发布说明](releases/v0.4.3.md) ·
[v0.4.2 发布说明](releases/v0.4.2.md) ·
[v0.4.1 发布说明](releases/v0.4.1.md) ·
[v0.4.0 发布说明](releases/v0.4.0.md) ·
[v0.3.1 发布说明](releases/v0.3.1.md)。

代码审查记录（中文）：[v0.3.1 以来 TypeScript 变更审查](code-review/ts-review-since-v0.3.1.zh.md) ·
[v0.4.3 至 v0.6.0](code-review/ts-review-v0.4.3-to-v0.6.0.zh.md) ·
[7e0088d 至 804662f（审查落地复查）](code-review/ts-review-7e0088d-to-804662f.zh.md) ·
[feat/adapt-dsh-0.2.0-rc.2（v0.7.0）](code-review/review-feat-adapt-dsh-0.2.0-rc.2.zh.md)。

本地测试与维护记录：[v0.8.0 npm Web 下载验证](testing/v0.8.0-npm-web.zh.md) ·
[本地测试产物与目录说明](testing/local-artifacts.zh.md)。

## 安装（挂载到 profile）

插件通过 **bundle patch** 挂载：把包加入 `dsh.profile.bundles` 后，dsh 启动时
按顺序合成每个 bundle 的 patch（`dsh.bundle.patch` 指向的 `cordis.patch.yml`）
作为插件行。manager 的默认 bundle 包含 `mcp-project`（核心装载器）与
`mcp-project-ui`（设置页）两行，自动安装同一精确版本的 UI 依赖；UI 包不再
单独声明 `dsh.bundle`，不应再作为独立 bundle 选择。

> 核心加 UI 的默认 bundle 已纳入源码版本 **0.8.0**。下列 npm 示例在两个
> 0.8.0 包同步发布后才提供这个布局；Git 标签不会自动发布 npm 或更新 `latest`。

**前置：安装 dsh 本体**（尚未安装 dsh 的用户）：

```powershell
npm install -g @deepseek-ai/dsh        # npm 官方包
npm install -g deepseek-ai/dsh         # 或从 GitHub 源码安装
```

**方式一：dsh 插件命令（推荐）**——`dsh plugin` 在 profile 目录内转发 pnpm，
负责安装/升级依赖：

```powershell
# 安装最新版，自动包含 UI（选择你使用的 profile）
dsh plugin --profile web add dsh-project-mcp-manager@latest
dsh plugin --profile desktop add dsh-project-mcp-manager@latest
# headless 等其他 profile 替换名字即可。

# 锁定发布版本（版本号可先 npm view dsh-project-mcp-manager versions 查看；
# 默认 UI 需要上文所述的同步发布版）
dsh plugin --profile web add dsh-project-mcp-manager@<version>
```

**方式二：直接 pnpm 安装**（与方式一等价）：

```powershell
# dshHome 默认为 %USERPROFILE%\.dsh（设置了 DSH_HOME 则用其值）
cd $env:USERPROFILE\.dsh\profiles\web
pnpm add dsh-project-mcp-manager@latest
```

**方式三：本地开发安装**——先构建源码仓库，再只链接根 manager 包。workspace
依赖提供匹配的 UI，无需另外链接 UI，也无需单独选择 UI bundle：

```powershell
# 在源码仓库内运行
pnpm install
pnpm run build     # 先核心，后 UI（宿主代码 + 浏览器 bundle）
dsh plugin --profile web add link:<你的 dsh-mcp-project 源码目录>
# 例如 link:D:\dev\dsh-mcp-project；桌面端改用 --profile desktop
```

链接指向源码仓库；改源码后重新构建，让宿主读取更新后的编译产物。

> **dsh ≥ 0.1.2 注意**：插件是否生效取决于 profile 的 `dsh.profile.bundles`，
> 不只是依赖是否安装。推荐的 `dsh plugin ... add` 会处理 bundle reconcile。
> 若直接用 pnpm 安装，请再跑一次 `dsh plugin --profile web list` 触发对账
> （桌面端 profile 换成 `desktop`）。在 web 或桌面端的插件页检查 manager 所含的
> 两个组件。desktop profile 由 Electron 管理，不要用桌面端 CLI `--dump-config`
> 检查它。只选择 `dsh-project-mcp-manager`，不要另选它的 UI 依赖。

**升级/锁定版本**：重跑方式一的 `add` 命令并带上目标版本后缀——`@latest`
升级到最新，`@<version>` 锁定指定发布版。默认 UI 需选择上文所述的 manager/UI
同步发布版。v0.7.x 与 v0.8.x 需要 dsh 0.2.0-rc.2（`0.2.0` 线）。
dsh 0.1.5 继续用插件 `@0.6.0`。

**设置页（默认包含）**：上面的 manager 安装会自动带上 web 端和桌面端 UI。
入口在「设置 → 内置插件 → 插件：MCP 管理」。如果只想隐藏页面、不停用装载器，
在插件管理器的 bundle 所含组件开关里，仅关闭 `mcp-project-ui`（也可以用 profile
patch 覆盖禁用该行），保持 `mcp-project` 启用。

headless profile 安装同一个 bundle，但没有浏览器页面。缺少 dsh `connection`
服务时，UI 不注册路由；连接侧集成等待该服务，不阻塞核心装载器与
MCP 装载。

**从单独安装的 UI 迁移**：先安装 manager bundle，再从 profile 的 bundle 选择
（`dsh.profile.bundles`）中移除 `dsh-project-mcp-ui`，保留 manager。之后可选执行
`dsh plugin --profile web remove dsh-project-mcp-ui` 移除直接 UI 依赖（桌面端换成
`desktop`）；manager 仍提供自己的 UI 依赖。运行新 bundle 前建议移除旧直接 UI
依赖，或对齐到 manager 的精确版本，避免它优先于传递依赖解析。旧 UI bundle 若
曾禁用，需在加载 manager 前用 `mcp-project-ui` 行的 `disabled: true` 覆盖保留意图。
不承诺旧 bundle 选择或直接依赖会自动清理。详见
[设置页迁移说明](guide/settings-ui.zh.md#从单独安装的-ui-迁移)。

## 构建与测试

```powershell
pnpm install
pnpm run build     # 核心 tsc → lib/；然后 UI tsc + 浏览器 bundle → packages/ui/lib/
pnpm test          # node 直跑 test/ 下的 .mjs（装载器、CLI 与设置页辅助函数）
```

## 工作原理

- **项目发现**：在线 agent 会话的 `session.header.cwd` + dsh 进程启动目录 →
  向上找最近的含 `.git` 的祖先目录作为项目根（无 `.git` 时退回目录本身）。
- **装载**：项目层每个 `(项目, serverName)` 在宿主 ctx 上装载一个
  `@deepseek-ai/dsh-mcp-client` 实例（`ctx.plugin`），注册进全局工具层，同一
  项目内多会话共享同一连接。尚未聚焦时，项目层只给有活跃会话或进程 cwd 的项目
  发起装载，离开后宽限 5 分钟再卸载。聚焦某个工作区之后只保留这一处，其它工作区
  立刻卸载，避免桌面端切走后别的项目的工具还留在全局工具层。条目与文件监听保留。
  **用户层每行只装载一个实例**（全局，与项目数无关）
  ——详见[配置来源与分层](guide/layers.zh.md)。
- **热重载**：chokidar 监听各项目根（depth 2，忽略 node_modules/.git/.hg/
  .svn），但只有**已知项目根的精确配置文件**（`<projectRoot>/.dsh/mcp.yml`、
  `<projectRoot>/.dsh/mcp.json` 与 `<projectRoot>/.mcp.json`）的改动经 150ms
  防抖触发全量对账：新增行装载、删除行卸载、配置变化重装。另有独立 watcher 以
  **精确文件路径**监听用户层：`~/.dsh/mcp.yml`、`~/.dsh/mcp.json`、
  `~/.dsh/profiles/<当前 profile>/mcp.yml` 与 `mcp.json`，以及 `$DSH_HOME/dsh-mcp.json`
  （对方插件的全局存储；只监听以便创建时能立刻诊断，从不装载）。chokidar v5
  对被监听的缺失文件能在其创建时补发事件，前提是父目录已存在——不监听家目录
  整体。
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

## 查询面

其它插件和配套 UI 从 `ctx.projectMcp`（`snapshot`、`serverView`、`globalState`、
`reload`）读装载状态。查询看到的是上一轮对账的内存，不读盘。对账成功结束时 emit
`projectMcp/updated`，无载荷。监听方再调 `snapshot()` 自己 diff。核心装载器不打开
浏览器 SSE，这条通道由 bundle 内的 UI 负责。同一服务还提供设置页用的写方法
（`addServer`、`setServerEnabled`、`removeServer`、`setToolEnabled`），它们只写受管
`mcp.yml`。

这个面——方法、事件，以及从包入口再导出的视图类型（`ProjectFileState`、
`McpServerRuntimeView`、`McpServerView`、`McpRowSource`，以及这些视图点名的类型）
——对配套 UI 按语义化版本承诺。manager 依赖 `dsh-project-mcp-ui` 的**同一精确
版本**，UI 对 `dsh-project-mcp-manager` 的 peer dependency 也锁到该精确版本
（发布后的两份契约都不要写 `^` 或 `~`）。两个包须同步升版、同步发布；用户只需
安装 manager。详见[查询面](guide/service.zh.md)。

## 安全边界

`.dsh/mcp.yml`、`.dsh/mcp.json` 与 `.mcp.json` 中的 `stdio` 行会在 dsh
宿主进程内 spawn 其 `command`——配置文件是**可执行代码载体**，只应在可信项目
中添加。用户层（`~/.dsh/mcp.yml`、`~/.dsh/mcp.json`、profile yml 与 json）同样是可执行
代码载体，只是它们属于你自己的机器：用户层行会以**全局**方式装载（宿主级一条
连接，所有项目可见），不再按项目 fan-out。装载失败/配置无效行仅告警跳过，不影响
其他服务器。`~/.claude.json` 这类 Claude 用户态单体文件（混存凭据与项目历史）
自 v0.4.0 起**完全不再读取**。

设置页写的是同一批受管文件，在页面上添加本地命令服务器，宿主就会 spawn 那条
命令。页面路由（`/api/project-mcp/*`）挂在 dsh connection 上：能用这个 dsh web
GUI 的人，就能通过它添加并启动服务器。

## 与同类插件共存

本插件与 `@wingsky-1/dsh-mcp-manager` 都做按项目自带 MCP，但**文件格式互不兼容**：

1. **项目文件格式互不兼容。** 本插件读 `<projectRoot>/.dsh/mcp.json` 里的
   `{ mcpServers: { … } }`；对方在同一路径存 `{ version, servers: [] }`。缺
   `mcpServers` 在本插件是合法空层，对方格式会表现为「我配了但没生效」。装载器
   现在会写一条诊断，指认该格式并建议改用 `mcpServers` 或 `.dsh/mcp.yml`。
   全局 `~/.dsh/dsh-mcp.json` 同样提示；若该文件已经是本插件的 `mcpServers`
   方言，诊断会建议把对象搬到 `mcp.json`——仍不会从对方文件名装载。
2. **同名服务器会被两个插件各启动一次**，stdio 可能互相抢端口或独占资源。
3. **建议同一项目只启用一个**，或让两者分居 `mcp.yml`（本插件）与
   `.dsh/mcp.json`（对方）。

`globalNames()` 只读官方 loader patch 行，看不到对方运行时注册的工具，因此
「改名避让」不会覆盖对方实例。
