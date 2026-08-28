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
node test/test-model.mjs
node test/test-registry.mjs
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

## 工作原理

- **项目发现**：在线 agent 会话的 `session.header.cwd` + dsh 进程启动目录 →
  向上找最近的含 `.git` 的祖先目录作为项目根（无 `.git` 时退回目录本身）。
- **装载**：每个 `(项目, serverName)` 在宿主 ctx 上装载一个
  `@deepseek-ai/dsh-mcp-client` 实例（`ctx.plugin`），注册进全局工具层。
  同一项目内多会话共享同一连接。
- **热重载**：chokidar 监听各项目根（depth 2，忽略 node_modules/.git/.hg/
  .svn），`.dsh/mcp.yml` 的增删改经 150ms 防抖触发全量对账：新增行装载、
  删除行卸载、配置变化重装。
- **生效名**：原始 `serverName` 在整个目录（全局行 + 全部项目行）中唯一时
  保持原名；冲突时双方都改为 `p<sha256(项目根)前6位>_<原名>`（截断 32 字符，
  确定性、与装载顺序无关），避免 `dsh-mcp-client` 按进程根的 serverName
  预留冲突。全局行（profile `cordis.patch.yml` / bundle 层已装载的
  mcp-client 行）参与占用判定但不改名。
- **会话可见性**：agent 创建时按其会话 cwd 解析项目，对该 agent 应用
  `tools.restrict({ deny })`，deny 掉除本会话项目外的全部项目服务器；会话
  无 cwd 时回退 owner 项目（子代理），再回退 dsh 进程 cwd 所在项目。会话
  销毁时释放。

## 安全边界

`.dsh/mcp.yml` 中的 `stdio` 行会在 dsh 宿主进程内 spawn 其 `command`——
项目文件是**可执行代码载体**，只应在可信项目中添加。装载失败/配置无效行
仅告警跳过，不影响其他服务器。
