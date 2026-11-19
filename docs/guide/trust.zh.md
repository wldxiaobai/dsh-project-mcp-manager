# 项目层的 workspace 信任门

[English](trust.md) | 中文

[← 返回 README](../README.zh.md) ｜ 相关：[配置来源与分层](layers.zh.md) · [CLI `dsh-mcp`](cli.zh.md) · [`${VAR}` 展开](env-expansion.zh.md) · [设置页](settings-ui.zh.md)

项目层文件（`<projectRoot>/.dsh/mcp.yml`、`.dsh/mcp.json`、`.mcp.json`）是
**可执行代码载体**：`stdio` 行会在 dsh 宿主进程内 spawn 其 `command`。缺省情况下
插件会为每个发现的工作区装载这些文件——对自己的项目很方便，对刚克隆的仓库则有风险。

信任门是可选的严格模式：`projectTrust: "allowlist"` 时，插件在信任该工作区之前
**完全不读项目层文件**。缺省值为 `inherit`，现有安装、CI 与 headless 部署保持原行为。

## 启用信任门

在 loader 行（bundle 或 profile patch）上设置插件配置：

```yaml
- id: mcp-project
  name: dsh-project-mcp-manager
  config:
    projectTrust: allowlist
```

headless 或 CI 也可用环境变量，它优先于配置：

```powershell
$env:DSH_MCP_PROJECT_TRUST = "allowlist"
```

只接受 `inherit` 与 `allowlist` 两个字面量。其它值被忽略：非法变量回落到配置，
而不是静默阻止所有项目装载。

## allowlist 模式下的变化

- 三个项目层文件不会被打开。解析、`${VAR}` 展开与 `spawn` 都在信任检查之后，
  所以未信任的文件完全没有副作用。
- 用户层与 profile 层**不受**信任门限制：`~/.dsh/mcp.yml`、`~/.dsh/mcp.json`
  与 profile 的 `mcp.yml`/`mcp.json` 属于你自己的机器，仍按全局装载。
- 取消信任会在下一轮对账卸载该工作区的行。磁盘上仍有项目层配置文件时
  （只检查文件是否存在，不读取内容），项目诊断改成工作区级记录：
  `summary.untrusted: true` 和一条 `untrusted` 事件，`dsh-mcp status` 会打印
  「已拦截」。没有这些文件时不写诊断，并删掉上一份陈旧文件。
- 插件对每个未信任工作区只记一条警告，并经 `projectMcp` 服务暴露状态
  （`trustState`、`setProjectTrusted`）。
- 在 MCP 管理页给当前工作区添加服务器会**信任该工作区**：写入一行本身已是明确
  决定，「添加成功却静默不装载」只会更糟。

## 信任一个工作区

三种等价方式，写的是同一份存储：

1. **MCP 管理页**——当前工作区未信任时显示提示条与「信任此工作区」按钮。
2. **CLI**——`dsh-mcp trust [dir]` 信任 `dir`（或当前目录）的项目根，
   `dsh-mcp untrust [dir]` 取消，`dsh-mcp trusted` 列出信任表。
3. **存储文件**——`$DSH_HOME/mcp-trust.json`（缺省 `~/.dsh/mcp-trust.json`），
   按工作区根为键的小型 JSON：

```json
{
  "version": 1,
  "projects": {
    "f:\\codeprojects\\my-project": {
      "root": "F:\\codeprojects\\my-project",
      "trustedAt": "2026-11-16T12:00:00.000Z"
    }
  }
}
```

键与装载器内部使用的规范化键一致（Windows 上小写化，`F:\Work` 与 `f:\work`
是同一个工作区）。文件缺失表示「什么都没信任」。JSON 损坏时插件记一条警告并按空表
处理——fail closed，绝不 fail open。

工作区根沿用插件的同一规则：最近的含 `.git` 的祖先目录，没有就用该目录本身。
因此信任子目录等于信任整个仓库，而不只是那个文件夹。

`allowlist` 模式下宿主会监听信任表并在每轮对账重读，所以用 CLI 信任或取消信任
会在片刻内生效，无需重启 dsh。

## 边界

- 信任门只覆盖项目层。用户层行按设计是全局的；只有在你信任自己的机器时才把命令与
  凭据放在那里。
- 缺省保持 `inherit` 是有意为之：直接翻默认值会让所有现有 headless 部署在升级时
  失效。这应当作为部署决策。
- 信任以工作区根为单位，不按行：一旦信任，整份文件又可执行了。信任别人的仓库前
  先读一遍文件。
