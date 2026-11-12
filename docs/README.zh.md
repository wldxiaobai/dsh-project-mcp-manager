# dsh-project-mcp-manager

[English](../README.md) | 中文

项目级 MCP 自动加载插件：在项目根 `<projectRoot>/.dsh/mcp.yml` 或
`.dsh/mcp.json` 写入 MCP 服务器配置，在该项目开启 dsh 会话时自动装载（经官方
`@deepseek-ai/dsh-mcp-client`），文件改动热重载到运行中的 dsh 进程，并按会话
原始项目（`session.header.cwd`）控制工具可见性。`dsh-project-mcp-manager` 的默认 bundle 包含装载器和
配套包 `dsh-project-mcp-ui` 提供的 web 端与桌面端 MCP 管理页（主页左侧栏、设置页
左侧栏与设置里的插件标签页三个入口，打开同一个页面）。
UI 默认启用，可以单独停用；装载器继续工作。

**Eager 模式的能力边界**（dsh ≥ 0.2.2-rc.1）：协议、重连、工具名、resources 与服务器
instructions 归官方 client。发行版 profile 已经装了共享的 MCP 资源工具。官方
配置是 profile 层 Cordis patch（该层自有 HMR）加上 `plugin_manager`。宿主还没做、
仍由本插件负责的是：

1. 项目级发现：`<projectRoot>/.dsh/mcp.yml`、`.dsh/mcp.json`，以及只读的遗留
   `.mcp.json`。
2. 按会话原始项目（`session.header.cwd`）隔离工具可见性。`working_directory`
   不挪这个焦点。
3. MCP 专用配置格式、`dsh-mcp` CLI 和 MCP 管理页。

项目文件热重载是本插件自己的文件监听，不替代官方 profile HMR。**传输类型由官方
client 决定。**

**支持的 dsh 版本：**

| 插件版本 | dsh 版本 |
|---|---|
| v0.11.x – v0.12.x | `0.2` 线，从 `0.2.2-rc.1` 起（`engines.dsh`：`^0.2.2-rc.1`） |
| v0.10.x | `0.2.1-rc.2` – `0.2.1-rc.5` |
| v0.7.x – v0.8.x | `0.2.0` 线，从 `0.2.0-rc.2` 起 |
| v0.6.0 | `0.1.5` |

若这个插件对你有帮助，欢迎给仓库点一颗
[star](https://github.com/wldxiaobai/dsh-project-mcp-manager)。遇到问题、宿主
不适配或有想法，请开
[Issue](https://github.com/wldxiaobai/dsh-project-mcp-manager/issues)——哪怕几句话也很有用。

## DSH 0.2.2-rc.1 按需加载

在 MCP 管理页把指定服务器的「加载模式」设为「按需加载」，或在
`.dsh/mcp.json` 的 `mcpServers` 条目中添加 `"mode": "lazy"`。
在受管 `mcp.yml` 行中，对应字段是 `config.mode`。缺省为 `eager`。

Lazy 支持 stdio 和 Streamable HTTP。使用 `mcp_search` 搜索工具，
`mcp_describe` 查看完整 Schema，再用 `mcp_call` 调用。搜索会连接当前会话
可见的 Lazy 服务器以发现工具。传入 `server` 可只查一台。工具目录按连接缓存，
每个会话首次搜索时独立连接，连接保持至会话结束或条目卸载。工具允许和拒绝规则适用于三个代理。

需要 DSH Resources 集成、服务器 instructions 或按单个注册工具配置宿主策略时，
使用 Eager。Lazy 处理 MCP 工具调用，文本和图片走 DSH 的 MCP 结果转换。
连接失败后，可在下一次请求时重试。

## 抬头里的上下文占用

MCP 管理页抬头按当前会话显示两个估算：

- **MCP**：模型可见的 MCP 工具定义（schema 与描述）占用，按服务器分组；可见的
  `mcp_search`、`mcp_describe`、`mcp_call` 定义作为 Lazy 共享开销只计一次。
- **结果**：当前 surface 上仍保留的 MCP 工具调用结果，包括经 Lazy
  `mcp_search`、`mcp_describe`、`mcp_call` 返回的全部结果；被工具结果裁剪器裁掉
  或被压缩移除的不再计入。

两者都按宿主的「4 字符约 1 token」口径估算，不是 provider 精确计数，也不含服务器
`instructions` 与对话历史。没有会话或没有可计价内容时不显示标签；点开标签可看
分服务器明细与占上下文窗口的比例，「结果」气泡还给定义与结果的合计。请求头、工具
结果或压缩改写 surface 后数字会自动刷新，不需要轮询。当前会话走代码模式（PTC）时
两个标签合并为一个 `MCP 无法估算`，明确标注无法按此口径估算而非给零。详见
[MCP 管理页](guide/settings-ui.zh.md#mcp-上下文占用)与
[查询面](guide/service.zh.md#工具调用结果占用)。

## 安装（挂载到 profile）

只需安装 `dsh-project-mcp-manager`，它同时带上核心装载器和 MCP 管理页。bundle
的组成见[安装](guide/settings-ui.zh.md#安装)。

**前置：安装 dsh 本体**（已安装可跳过）。推荐从官方下载页获取 DeepSeek Harness：
<https://www.deepseek.com/harness/>。也可以从 npm 或 GitHub 安装：

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
同步发布版；按上方的兼容性表格选择与你 dsh 版本匹配的插件版本。

以前单独装过 `dsh-project-mcp-ui` 的，见
[从单独安装的 UI 迁移](guide/settings-ui.zh.md#从单独安装的-ui-迁移)。

### MCP 管理页入口

安装 manager 后，web 端和桌面端都有 MCP 管理页。下面三个入口打开同一个页面：

- 主页左侧栏的「MCP 管理」
- 设置页左侧栏的「MCP 管理」
- 设置 → 内置插件 →「插件：MCP 管理」

headless profile 没有页面，装载器照常工作。页面用法见
[MCP 管理页](guide/settings-ui.zh.md)。

### MCP 管理页入口设置

在 **设置 → 通用 →「MCP 管理页入口」** 点「设置…」，勾选要显示的入口。三个可以
全部关掉；这一行始终保留，随时可以重新打开。主页 →「插件」→
`dsh-project-mcp-manager` 页面里也有这一行，两处改的是同一份设置。

要去掉整个页面但保留装载器，在插件管理器里只关闭 `mcp-project-ui` 组件。

## 构建与测试

```powershell
pnpm install
pnpm run build     # 核心 tsc → lib/；然后 UI tsc + 浏览器 bundle → packages/ui/lib/
pnpm test          # 先构建，再跑装载器、CLI、页面辅助、Lazy 与隔离竞态等测试
```

## 工作原理

装载器从会话的 `session.header.cwd` 向上找最近的 `.git` 祖先，作为该会话的
项目。每个项目服务器经 `@deepseek-ai/dsh-mcp-client` 装载一次，再用
`tools.restrict({ deny })` 让会话只看到本项目的服务器。用户层每行在宿主上只装载
一次。配置文件改动经 150ms 防抖热重载。详见[工作原理](guide/how-it-works.zh.md)。

其它插件和配套 UI 从 `ctx.projectMcp` 读装载状态，见[查询面](guide/service.zh.md)。

## 安全边界

`.dsh/mcp.yml`、`.dsh/mcp.json` 与 `.mcp.json` 中的 `stdio` 行会在 dsh
宿主进程内 spawn 其 `command`——配置文件是**可执行代码载体**，只应在可信项目
中添加。用户层（`~/.dsh/mcp.yml`、`~/.dsh/mcp.json`、profile yml 与 json）同样是可执行
代码载体，只是它们属于你自己的机器：用户层行会以**全局**方式装载（宿主级一条
连接，所有项目可见），不再按项目 fan-out。装载失败/配置无效行仅告警跳过，不影响
其他服务器。`~/.claude.json` 这类 Claude 用户态单体文件（混存凭据与项目历史）
自 v0.4.0 起**完全不再读取**。

MCP 管理页写的是同一批受管文件，在页面上添加本地命令服务器，宿主就会 spawn 那条
命令。页面路由（`/api/project-mcp/*`）挂在 dsh connection 上：能用这个 dsh web
GUI 的人，就能通过它添加并启动服务器。

## 与同类插件共存

`@wingsky-1/dsh-mcp-manager` 也读 `<projectRoot>/.dsh/mcp.json`，但格式不同，
两个插件还可能把同一台服务器各启动一次。建议同一项目只启用一个，或让本插件只用
`.dsh/mcp.yml`。详见
[与 `@wingsky-1/dsh-mcp-manager` 共存](guide/layers.zh.md#与-wingsky-1dsh-mcp-manager-共存)。

## 文档

功能说明已拆分到 `docs/`，中英双版并存：

- [配置格式](guide/format.zh.md)——原生 YAML 受管块、JSON 方言、与
  cordis 方言的差异。
- [MCP 管理页](guide/settings-ui.zh.md)——使用默认包含的 UI、看懂服务器列表、添加服务器
  （含从剪贴板填入）、开关、删除与管理工具，以及抬头里的 MCP / 结果上下文标签。
- [配置来源与分层](guide/layers.zh.md)——七层来源模型、影子优先序、
  全局装载 vs 项目装载，以及只读的遗留 Claude Code 层。
- [`${VAR}` 展开](guide/env-expansion.zh.md)——装载时插值与对应诊断。
- [CLI `dsh-mcp`](guide/cli.zh.md)——作用域、写入格式与独占契约。
- [工作原理](guide/how-it-works.zh.md)——项目发现、装载、热重载、生效名、会话可见性与
  上下文占用。
- [查询面](guide/service.zh.md)——`ctx.projectMcp`、`contextCost` / `resultCost`、
  `projectMcp/updated` 事件、包入口导出的视图类型，以及对配套 UI 的语义化版本承诺。

设计、发布、代码审查与测试记录：[记录索引](records.zh.md)。

## 参与贡献

PR 请提交到 `dev` 分支。环境搭建、自查清单与提交约定见
[贡献指南](../CONTRIBUTING.zh.md)。

## 致谢

感谢为本项目贡献代码的开发者：

- [@yangjh0127](https://github.com/yangjh0127)：逐服务器的 Lazy 按需加载模式，
  以及 MCP 管理页中的加载模式切换
  （[#30](https://github.com/wldxiaobai/dsh-project-mcp-manager/pull/30)）。
- [@yangjh0127](https://github.com/yangjh0127)：切换会话时保持工作区 MCP 常驻挂载，
  工具、服务器说明与资源按会话隔离，Lazy 按会话独立激活
  （[#32](https://github.com/wldxiaobai/dsh-project-mcp-manager/pull/32)）。
