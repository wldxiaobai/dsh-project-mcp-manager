# dsh-mcp-project

独立项目级 MCP 自动加载插件：在项目根 `<projectRoot>/.dsh/mcp.yml` 写入 MCP
服务器配置，在该项目开启 dsh 会话时自动装载（经官方
`@deepseek-ai/dsh-mcp-client`），文件改动热重载到运行中的 dsh 进程，并按
会话 cwd 控制工具可见性。无 UI，核心功能精简型插件。

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

## 配置格式

`<projectRoot>/.dsh/mcp.yml`，格式与 profile `cordis.patch.yml` 的受管块
一致（begin/end 标记之间的 YAML insert 列表），每行一个 MCP 服务器：

```yaml
# >>> dsh-mcp-project:mcp:begin
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
# <<< dsh-mcp-project:mcp:end
```

`transport` 支持 `stdio`（command/args/env/cwd）与 `streamable-http`
（url/headers）。行加 `disabled: true` 即停用。标记之外的内容逐字节保留。

## 安装（挂载到 profile）

**方式一：npm 安装（推荐）**

```powershell
# web profile 示例；headless 等其他 profile 同样操作
cd C:\Users\haima\.dsh\profiles\web
pnpm add dsh-mcp-project
```

**方式二：dsh 官方插件命令**（自动处理依赖与 bundle patch 挂载）

```powershell
dsh plugin add dsh-mcp-project --profile web
```

两种方式装完后，在 `cordis.patch.yml` 追加（dsh 官方 patch 语法）：

```yaml
- insert:
    - id: mcp-project
      name: dsh-mcp-project
```

profile patch 由 dsh 自带 HMR 热装载，无需重启；未生效时重启 dsh。
包自带 `cordis.patch.yml` 的 bundle patch（`dsh.bundle.patch`），
`dsh plugin add` 安装时会自动挂载。

**本地开发安装**（源码即改即用，junction 实时同步）：

```powershell
cd C:\Users\haima\.dsh\profiles\web
pnpm add link:D:\path\to\dsh-mcp-project
```

## 与 dsh-skill-mcp-panel 的关系

- 已装的 v2.0.1 面板：无项目级装载能力，与本插件不冲突；其全局受管块行
  会被本插件读取（loader entries），项目同名行自动改名避开。
- v2.1 面板源码（含 ProjectMcpRegistry）：与本插件功能重复，**同一进程内
  两者只能启用一个**（双装载同一 serverName 会触发 mcp-client 的进程根
  预留冲突）。v2.1 写出的项目文件行（`panel-mcp-` 前缀 id）本插件可直接
  读取，过渡平滑。

## 构建与测试

```powershell
npm install
npm run build     # tsc → lib/
node test/test-model.mjs
node test/test-registry.mjs
```

## 安全边界

`.dsh/mcp.yml` 中的 `stdio` 行会在 dsh 宿主进程内 spawn 其 `command`——
项目文件是**可执行代码载体**，只应在可信项目中添加。装载失败/配置无效行
仅告警跳过，不影响其他服务器。
