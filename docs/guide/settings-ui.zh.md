# 设置页

[English](settings-ui.md) | 中文

[← 返回 README](../README.zh.md) ｜ 相关：[配置来源与分层](layers.zh.md) · [配置格式](format.zh.md) · [`${VAR}` 展开](env-expansion.zh.md)

默认 `dsh-project-mcp-manager` bundle 内的配套包 `dsh-project-mcp-ui` 在 dsh
web 端与桌面端的设置里加一个 MCP 标签页：列出装载器会启动的服务器、显示每台
是否在运行，并可以添加、开关、删除服务器或单个工具。所有改动都写进
**受管 `mcp.yml`**，页面不改 JSON 文件，也不改遗留
`.mcp.json`。之后由装载器照常经文件监听生效，所以页面和 [CLI](cli.zh.md)
可以混用。

## 安装

只需安装你所用 profile 的 **manager**：

```powershell
dsh plugin --profile web add dsh-project-mcp-manager@latest
dsh plugin --profile desktop add dsh-project-mcp-manager@latest
```

manager 以**同一精确版本**依赖 `dsh-project-mcp-ui`，会自动安装 UI。默认 bundle
包含 `mcp-project`（核心）与 `mcp-project-ui`（UI）两行，均默认启用。UI 保留
精确版本的 manager peer dependency，但不再单独声明 `dsh.bundle`，不要另选 UI
bundle。两个包必须同步发布（[版本契约](service.zh.md#对配套-ui-的语义化版本)）。
这个布局已纳入源码版本 **0.8.0**；npm 示例在两个 0.8.0 包同步发布后适用。
Git 标签不会自动发布 npm。

本地开发时，在源码仓库内执行以下命令，只链接根 manager 包：

```powershell
pnpm install
pnpm run build     # 先构建核心，再构建 UI 宿主代码与浏览器 bundle
dsh plugin --profile web add link:<源码目录>
# 桌面端改用 --profile desktop；无需另外链接 packages/ui
```

改源码后重新构建，更新链接所使用的编译产物。

headless profile 可以使用同一个 manager bundle。没有浏览器运行时就没有设置页；
缺少 dsh `connection` 服务时，UI 不注册路由，只有连接侧集成等待，
不阻塞核心装载器与 MCP 装载，UI 行本身可以独立处于 active。connection 到来时
注册对应集成，销毁时清理。

入口：**设置 → 内置插件 → 插件：MCP 管理**（英文界面为
Settings → Built-in plugins → Plugin: MCP Manager）。旧版宿主可能将中间项显示为「插件」。

要隐藏页面，在插件管理器中展开 manager bundle 所含组件，只关闭
`mcp-project-ui`，保留 `mcp-project` 启用。也可以在 profile patch 中按 id 覆盖
禁用 UI 行。这样只停用 UI，不停用装载器，也不移除 UI 依赖。

### 从单独安装的 UI 迁移

1. 先安装或升级 manager bundle。
2. 从 profile 的 bundle 选择（`dsh.profile.bundles`）中移除
   `dsh-project-mcp-ui`，保留 `dsh-project-mcp-manager`。现在由 manager 提供 UI
   行，不应继续另选旧的 UI bundle。
3. 完成第 1 步后，可以选择移除旧的**直接** UI 依赖：

   ```powershell
   dsh plugin --profile web remove dsh-project-mcp-ui
   # 桌面端换成 --profile desktop
   ```

   UI 仍通过 manager 的依赖安装。旧的直接 UI 版本可能优先于传递依赖解析：
   **运行新 bundle 之前**，建议移除旧直接依赖，或将它对齐到 manager 的精确版本。
   不要假定旧 bundle 选择或直接依赖会自动清理。

如果旧的独立 UI bundle 曾被禁用，请在**加载新 manager bundle 之前**，用下面的
profile patch 行覆盖保留停用意图：

```yaml
- id: mcp-project-ui
  disabled: true
```

只禁用旧独立 bundle 不会停用 manager 的新 UI 组件；没有这个覆盖时，默认 UI
会启用。

## 列表里显示什么

服务器按分节显示：

| 分节 | 文件 |
|---|---|
| 工作区层 | 各已知项目的 `<projectRoot>/.dsh/mcp.yml`、`.dsh/mcp.json`、`.mcp.json` |
| profile 层：桌面端 / web 端 / `<name>` 端 | `~/.dsh/profiles/<当前 profile>/mcp.yml` 与 `mcp.json` |
| 用户层 | `~/.dsh/mcp.yml`、`~/.dsh/mcp.json` |

用户层与 profile 层路径用 `~` 表示家目录，工作区路径保持原样。

**装载器会启动的每台服务器一张卡。** 合并规则与装载器的影子规则一致（精确名、
归一名、服务身份，见[配置来源与分层](layers.zh.md)）：

- 低优先级文件里的同名行留在胜出者卡片上，说明「已被覆盖」。
- 名字不同、但命令与参数相同（或地址相同）的行：来自 yml 时在胜出者卡片上
  说明；来自 JSON 时不显示，因为装载器不会启动它。

名字旁的标签是来源文件。黄色的「`<文件>` · 待接管」表示这一行来自 JSON 文件或
`.mcp.json`，改动前会先确认（见下文）。

**状态行**：

| 状态 | 含义 |
|---|---|
| 运行中 · N 个工具 | 已连接，工具已注册。开关为绿色。 |
| 已启用 · 等待会话启动 | 已打开但未装载，例如该工作区还没有会话，或空闲宽限后已卸载。开关为白色。 |
| 正在启动 | 正在装载。页面会持续刷新，直到有结果。 |
| 启动失败 | 连接失败。 |
| 未启动 · 名称已被占用 / 缺少环境变量 / 环境变量展开后无效 / 配置无效 / 已停止重试 | 装载器跳过了这一行，下一行写完整原因。 |
| 已禁用 | 这一行已关闭（`disabled: true`）。 |

每次对账后页面会自动刷新（SSE 推送，断开时退回轮询），所以在编辑器或 CLI 里
改的配置也会显示出来。

## 添加服务器

点「添加 MCP」：

1. **保存到**：工作区（当前工作区的 `.dsh/mcp.yml`）、用户（`~/.dsh/mcp.yml`）
   或 profile（`~/.dsh/profiles/<当前>/mcp.yml`）。下方显示将写入的路径。还没有
   在某个工作区打开会话时「工作区」不可选；解析不出当前 profile 时「profile」
   不可选。
2. **名称**：1–32 位字母、数字、`_` 或 `-`。该文件里已有同名时拒绝，文件不动。
3. **类型**：本地命令（stdio）或远程地址（Streamable HTTP）。
4. 本地命令：命令、参数（每行一个）、环境变量（每行一个 `KEY=值`）。远程地址：
   地址、请求头（每行一个 `名称: 值`）。`${VAR}` 原样写入，装载时展开
   （[`${VAR}` 展开](env-expansion.zh.md)）。

「添加」写入一条受管行并发起对账。工作区里的 stdio 行写 `cwd: .`（项目根），
用户层与 profile 层继承宿主目录。

**从剪贴板填入**读取剪贴板里的 JSON 或 YAML 并填表。认 `mcpServers` 或
`servers` 映射、单个条目，以及受管 yml 行。有多个服务器时只填第一个，并说明
其余几个没有填入。`enabled: false` 的条目跳过；SSE（`type: "sse"`）条目会被
拒绝，因为装载器装不了。浏览器可能会请求剪贴板权限。保存位置保持对话框里当前
的选择。

表单不覆盖 `tools.allow`/`deny` 模式、`reconnect`、超时和 `maxInstructionBytes`，
这些请用「MCP 配置」。

## MCP 配置

「添加 MCP」旁的菜单用系统默认编辑器打开一份受管 `mcp.yml`：用户层文件、当前
profile 文件，以及每个已知工作区各一份。文件不存在时先创建 YAML 空列表（`[]`），
第一次写服务器时再生成受管块。
Windows 上会同时在资源管理器里选中它。写法见[配置格式](format.zh.md)。

## 开关、删除与工具

- **开关**：受管 yml 行就地翻转 `disabled`。
- **删除**：先确认。受管 yml 行直接删掉；如果更低优先级的文件里还有同名或
  同命令的行，改为保留一条 `disabled: true` 占位，避免那一条再启动。
- **管理工具**：列出运行中服务器已注册的工具，每个一个开关。切换会把精确工具名
  写进该行的 `tools.allow` / `tools.deny`。未运行的服务器没有工具可列。

**来自 JSON 文件或 `.mcp.json` 的行**不会被就地修改。每次改动都先弹确认，再在
同一作用域的受管 yml 里写一条更高优先级的行，原文件不变：

| 卡片来源 | 写入 |
|---|---|
| `.dsh/mcp.json`、`.mcp.json` | 该工作区的 `.dsh/mcp.yml` |
| profile `mcp.json` | profile `mcp.yml` |
| `~/.dsh/mcp.json` | `~/.dsh/mcp.yml` |

启用会拷贝整条配置；停用或删除写一条占名的 `disabled: true` 占位（`disabled`
如何遮蔽低层见[配置来源与分层](layers.zh.md)）。

**工作区层卡片只能改当前工作区的。** 其它工作区的卡片置灰（「这个工作区当前
不能改」）。用户层与 profile 层卡片始终可改。

## 安全

在页面上添加本地命令服务器，等同手写一条 `stdio` 行：dsh 宿主会 spawn 这个
命令。页面路由（`/api/project-mcp/*`）挂在 dsh connection 上，能使用这个 dsh
web GUI 的人就能通过它添加并启动服务器。GUI 的访问权限应当等同受管配置文件的
写权限来对待。
