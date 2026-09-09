# dsh-project-mcp-manager

[English](../README.md) | 中文

项目级 MCP 自动加载插件：在项目根 `<projectRoot>/.dsh/mcp.yml` 写入 MCP
服务器配置，在该项目开启 dsh 会话时自动装载（经官方
`@deepseek-ai/dsh-mcp-client`），文件改动热重载到运行中的 dsh 进程，并按
会话 cwd 控制工具可见性。无 UI，仅具备核心功能。

## 文档

功能说明已拆分到 `docs/`，中英双版并存：

- [配置格式](guide/format.zh.md)——原生 YAML 受管块、JSON 方言、与
  cordis 方言的差异。
- [配置来源与分层](guide/layers.zh.md)——六层来源模型、影子优先序、
  全局装载 vs 项目装载，以及只读的遗留 Claude Code 层。
- [`${VAR}` 展开](guide/env-expansion.zh.md)——装载时插值与对应诊断。
- [CLI `dsh-mcp`](guide/cli.zh.md)——作用域、写入格式与独占契约。

设计与发布记录（中文）：[dsh 0.1.2-rc.1 适配记录](design/adaptation-dsh-0.1.2-rc1.md) ·
[JSON 配置层设计提案](design/proposal-json-mcp-config.md) ·
[v0.4.2 发布说明](releases/v0.4.2.md) ·
[v0.4.1 发布说明](releases/v0.4.1.md) ·
[v0.4.0 发布说明](releases/v0.4.0.md) ·
[v0.3.1 发布说明](releases/v0.3.1.md)。

代码审查记录（中文）：[v0.3.1 以来 TypeScript 变更审查](code-review/ts-review-since-v0.3.1.zh.md)。

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
dsh plugin --profile web add dsh-project-mcp-manager@0.4.2
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
升级到最新，`@0.4.2` 锁定到指定版本。

## 构建与测试

```powershell
pnpm install
pnpm run build     # tsc → lib/
pnpm test          # node 直跑 test/ 下六个 .mjs（model / mcp-file / json-file / json-write / registry / cli）
```

## 工作原理

- **项目发现**：在线 agent 会话的 `session.header.cwd` + dsh 进程启动目录 →
  向上找最近的含 `.git` 的祖先目录作为项目根（无 `.git` 时退回目录本身）。
- **装载**：项目层每个 `(项目, serverName)` 在宿主 ctx 上装载一个
  `@deepseek-ai/dsh-mcp-client` 实例（`ctx.plugin`），注册进全局工具层，同一
  项目内多会话共享同一连接；**用户层每行只装载一个实例**（全局，与项目数无关）
  ——详见[配置来源与分层](guide/layers.zh.md)。
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
