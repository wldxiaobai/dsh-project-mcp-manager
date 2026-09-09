# 发布说明 v0.3.1（自 v0.1.1 以来的累积变化）

**发布日期**：2026-09-04 ｜ **区间**：`v0.1.1 → v0.3.1`（含 v0.2.0、v0.2.1、v0.3.0、v0.3.1 四个版本）
**规模**：45 commits，+3331 / −136，新增源码模块 2 个（`src/cc-file.ts`、`src/cli.ts`）、测试套件 3 套

v0.1.1 之前的插件只做一件事：读项目 `.dsh/mcp.yml` 并装载。本区间把它扩展成一个
**多来源、可控边界、可审计**的项目 MCP 管理层：Claude Code 只读兼容层、`dsh-mcp`
CLI、`${VAR}` 运行时展开、跨来源同服务去重，以及把「隐式读取机器级配置」这类
高风险默认行为收敛为显式 opt-in。

---

## 亮点速览

| 主题 | 版本 | 一句话 |
|---|---|---|
| CC 只读兼容层 | v0.2.0 | `.mcp.json` 与 `~/.claude.json` 顶层 `mcpServers` 白名单可被装载，四层影子优先序 |
| `dsh-mcp` CLI | v0.2.0 | `add/list/get/remove`，只写原生 yml，CC 文件保持只读 |
| `${VAR}` 运行时展开 | v0.2.0 | 四个来源的字符串字段挂载时用宿主环境插值，密钥不落盘 |
| **cc-user 层默认关闭** | v0.3.0 ⚠️ | 机器级 `~/.claude.json` 改为显式 `DSH_MCP_READ_CLAUDE_USER=1` 才读 |
| 三键去重 | v0.3.0 | 精确原名 / 归一化名称 / 服务身份，同服务器两种写法只装高优先级一条 |
| 审查修复包 | v0.3.1 | 告警可重武装、去重告警不再刷屏、CLI 与装载器同口径、serverView 归属守卫 |

---

## 新功能

### Claude Code 只读兼容层（v0.2.0，`src/cc-file.ts`）

- 装载 `<projectRoot>/.mcp.json`（project 行 cwd=项目根）与 `~/.claude.json` **顶层
  `mcpServers` 白名单**（user 行 cwd 继承宿主）——该文件其余内容绝不读取、写入、
  日志或回显；JSON 错误脱敏。
- 影子优先序：项目 `.dsh/mcp.yml` > 项目 `.mcp.json` > 用户 `~/.dsh/mcp.yml` >
  用户 `~/.claude.json`；被遮蔽方写入 `.dsh/.mcp-diag.json`
  （`shadowedByYml` / `shadowedByProject`）。
- 方言映射：`sse` 逐条拒绝并给明确报错；未知 CC 键容忍；`type: "http"`/
  `"streamable-http"`/纯 url 条目均归一到 streamable-http。故意不提供 `local`
  scope，且在用户会期待的地方解释原因。
- `~/.claude.json` 的 watcher 按 `mcpServers` 子树规范化 JSON 哈希门控——CC 每会话
  重写整个状态文件也不会空转对账（v0.2.1 起哈希为唯一裁决，去掉 size/mtime 快路径）。

### `dsh-mcp` CLI（v0.2.0，`src/cli.ts`，新 `bin`）

- `add / list / get / remove`，`--scope project|user`、`--transport stdio|http`，
  对齐 CC 手感；`-x` 不识别即视为服务器参数，`--` 透传。
- 写操作只落原生 `.dsh/mcp.yml`（锁 + 校验 + 原子写）；只读层遇 `remove` 给编辑
  指引。`list`/`get` 展示四层带遮蔽标注，密钥值只渲染键名。
- 零新依赖（手写 argv 解析）；`runCli(argv, io, deps)` 可注入测试。

### `${VAR}` 运行时展开（v0.2.0；v0.2.1 补 `cwd` 与 url 主机位）

- `command`、`args[*]`、`env[*]`、`url`、`headers[*]`（v0.2.1 起含 `cwd`）中任意位置
  的 `${NAME}` 在挂载时用 dsh 宿主环境插值（同 CC 语义，`"Bearer ${TOKEN}"` 可用）。
- 未设或空串 → `env-missing` 跳过并只点名变量不泄值；展开后复验失败 →
  `env-invalid`。文件永不改写——配置可以进 git，密钥留在环境。

### 跨来源同服务去重（v0.3.0，`mergeSourcedRows`）

- 三把先到先得影子键：精确 `serverName`、归一化名称（小写去非字母数字，
  `unityMCP` = `unity-mcp`）、服务身份（stdio command+args，Windows 路径大小写
  不敏感；http 取 url）。一台服务器两种写法只装高优先级一条。
- command/url 为空的行不注册身份键（`node a.js` 与 `node b.js` 绝不互杀）；
  `disabled` 占名行三键全占、自身不装载——给「用户层多余服务器」一个项目侧的
  占名退出手段。
- 剔除可见：`shadowedIdentity` 进诊断 + 宿主日志告警点名 winner 与命中维度。

---

## 行为与边界变更

### ⚠️ 破坏性：cc-user 层默认关闭（v0.3.0）

`~/.claude.json` 顶层 `mcpServers` 是机器环境级外部状态，无条件读取会把别的
workspace 的服务器静默扇进每一个项目各自 spawn。现在须
`DSH_MCP_READ_CLAUDE_USER=1` 显式启用，启用时一次性日志提示扇出规模并给出回退
路径。旧开关 `DSH_MCP_IGNORE_CLAUDE_JSON=1` 保留一个版本作强制关闭（与 opt-in
冲突时胜出并告警；v0.4 移除，代码已挂 `TODO(v0.4)` 锚点）。

### 新增边界开关（v0.3.0）

- `DSH_MCP_IGNORE_MCP_JSON=1`：整层停用项目 `.mcp.json`（读、监听、快照分区、CLI
  视图同源生效）。该层默认仍开，作为仓内声明的安全档位。

### 语义修复（v0.2.1）

- 空 stdio `cwd` 按来源分化：项目行=项目根，用户行=宿主 cwd（修复前用户层行会被
  绑到「碰巧装载它的那个项目」的根）。
- 快照视图拆分：`fiberPhase` 保持严格生命周期枚举，具体跳过原因走独立
  `skipReason` 字段（`env-missing`/`env-invalid`/`config-invalid`/`plugin-throw`）。
- CC `"disabled": true` 与 `"enabled": false` 同样静默跳过、不占名。
- 用户 watcher 只盯 `~/.dsh/mcp.yml` 与 `~/.claude.json` 两个精确路径；项目 watcher
  kick 只匹配已知项目根的精确配置文件路径，树深处杂散 `.dsh/mcp.yml` 不再触发。

### 装载正确性（v0.2.0）

- 受管块内未解析的 cordis `!!js` 标签显式报错（此前会静默按字面量装载，
  `TOKEN: "process.env.X"` 原样挂上去、表达式 disabled 行照装）。
- `reconnect` 参数按 `MAX_TIMER_DELAY_MS = 2147483647` 与 dsh-mcp-client 镜像设界，
  越界在配置加载即拒。
- 未知 `transport` 给明确报错而非误入 stdio 分支；坏 yml 文件只打倒自己项目分区，
  不再拖垮整个快照；fiber 异步回调的诊断写盘串行进对账链。

---

## v0.3.1：v0.3.0 发布后审查修复（6 commits）

1. **冲突告警可重新武装**——「旧开关胜出」的一次性告警此前只在撤掉 opt-in 时复位，
   用户按告警清掉旧开关后再冲突会静默；现在解除路径同样复位（`fa37ce4`）。
2. **identity 去重告警变更门控**——告警与 scan 诊断按「每项目剔除集签名」比较，
   集合稳定不重复刷（修复前任何文件事件 × 每个已知项目 × 每条重复行各刷一遍）；
   集合并集变化仍会重新告警（`28f0647`）。
3. **CLI 与装载器同口径**——`list`/`get` 复用 `mergeSourcedRows`：归一名/身份键去重
   剔除的行标注「与 X 同一服务，去重不装载」，`get` 对未实际装载的行给注记与处置
   指引；此前 CLI 只按精确同名判遮蔽，展示口径与生效集合对不上（`614f10d`）。
4. **身份键边界披露**——中英 README 明确：身份比对用**展开前的原始字符串**（一边
   写 `${VAR}` 一边写字面量不会互认），且 `env`/`headers`/`cwd` **不参与**身份键
   （同命令行不同 env 也会合并）；告警文案附「确属不同服务器请改名或调整命令与
   参数」（`90da525`）。
5. **serverView 归属守卫**——`fiberPhase`/`toolCount` 须装载实例确实来自该行所在
   源（与分区视图同口径），被去重/被遮蔽行不再借用 winner 的生命周期与工具数
   （`05f3c9d`）。
6. **类型收紧**——展示辅助函数的 `state: any` → `ProjectServerState | undefined`
   （`e623b44`）。

---

## 测试与文档

- 测试从 model/mcp-file/registry 三套扩为五套 **83 个用例**（model 25 / mcp-file 6 /
  cc-file 9 / registry 29 / cli 14）：新增方言映射、哈希门稳定性、三开关真值表、
  跨层去重事故复刻、告警一次性与重武装、CLI 进程内全命令覆盖等场景。
- README 与 `docs/README.zh.md` 系统性更新：与原生 cordis 方言的差异、`${VAR}`
  语义、影子优先序与三键规则、边界开关裁决表；新增 `AGENTS.md` 作为贡献者约定
  （装载模型、提交节奏、分支策略）的权威入口。

## 升级指引

- 依赖 cc-user 层（`~/.claude.json`）装载的用户：升级后需设
  `DSH_MCP_READ_CLAUDE_USER=1`；不需要该层的用户无需动作，反而少了一类静默 spawn。
- 曾用 `DSH_MCP_IGNORE_CLAUDE_JSON=1` 关层的用户：该开关仍生效（优先级更高），
  请在 v0.4 移除前取消设置即可。
- 诊断文件 `.dsh/.mcp-diag.json` 写法不变，新增 `shadowedIdentity`、`skipReason`
  字段可忽略兼容。

## 组件版本

- `dsh-project-mcp-manager` v0.3.1 ｜ 依赖 `@deepseek-ai/dsh-mcp-client ^0.1.1-rc.2`、
  `chokidar ^5`、`yaml ^2`、`zod ^4`

**Full Changelog**：https://github.com/wldxiaobai/dsh-project-mcp-manager/compare/v0.1.1...v0.3.1
