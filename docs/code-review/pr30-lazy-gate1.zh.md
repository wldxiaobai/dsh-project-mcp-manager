# PR #30 Lazy MCP — Gate 1 审查

- 日期：2026-11-10
- 基线：`8dc3853`（前置 `6ccc14c`，比较基线 `2115857`）
- 范围：项目隔离、连接/进程生命周期、服务契约、依赖决策、命名兼容、配置及管理页文档。
- 操作边界：只在现有分支追加本地提交；不切分支、合并、变基或推送。

## 初审结论与实施顺序

初审 **暂不通过 Gate 1**。隔离实现未发现越权路径，但原测试无法证明“双项目都有 Lazy”的边界；连接取消、释放与下一世代启动之间存在竞态，需要修复并用真实 stdio 回归。

| 编号 | 优先级 | 发现 / 风险 | 处置与验收 |
| --- | --- | --- | --- |
| G1-01 | P1 | 原测试只覆盖另一项目没有 Lazy 时整体 deny，未覆盖双方都有代理权限时的参数级隔离 | 补双项目异名/同原名生效名、search/describe/call 双向拒绝，以及全局遮蔽、焦点卸载、会话销毁测试；不得以工具整体 deny 代替参数校验 |
| G1-02 | P1 | `LazyServer.close()` 仅调用 `client.close()`；SDK auto negotiation 的探测阶段尚未挂 `client.transport`，不能及时关掉 session transport 以取消 sibling probe | 保留 transport，显式释放探测/已挂接连接；验证 connect 期间 dispose 不再晚到启动进程 |
| G1-03 | P1 | 等待共享 connect/listTools 时，调用方 signal 只在 await 后检查；取消不能及时返回。共享连接的一个取消者也不能中断其他请求 | 增加调用方级 abort 等待，最后一个取消者负责关闭正在进行的连接/请求，测试并发存活者不受影响 |
| G1-04 | P1 | idle/失败释放提前清空 connection，新调用可与旧连接清理并行；重复 dispose 第二次不等待第一次释放 | 串行化世代回收和新建，幂等 dispose 返回同一释放屏障，测试 idle 重连、失败重试、热重载和卸载 |
| G1-05 | P2 | 新服务方法 `setLoadingMode`、可选 mode 字段、JSON 接管与 disabled 保持没有契约测试/双语说明 | 补服务及写入回归；保持 `mode` 不传给官方 client 的既有断言；补双语 service/format/settings-ui |
| G1-06 | P2 | `eagerToolName()` 镜像官方命名规则，无对拍；官方升级后完整工具名过滤可能静默失配 | 通过官方公开 API 对拍合法名、非法字符、长名、哈希与过滤；依赖升级必须运行 |
| G1-07 | P2 | 新 SDK/subprocess 的架构选择只有依赖声明；官方 client 范围升级可能与精确 SDK 版本漂移 | 记录第二条连接管理路径、直接依赖与去依赖替代方案，增加依赖契约验证，不使用深导入/幽灵依赖 |
| G1-08 | P3 | MCP clientInfo version 固定 `0.10.0`，与包版本不符 | 从本包元数据读取并测试，避免再次硬编码 |
| G1-09 | P3 | active Lazy 被抬头计入“运行中”，卡片却显示“可按需连接”；新增组件 props 未 readonly | 抬头归入等待，补回归，修正 props 只读声明 |

## 隔离静态审查

`visibleLazyMounts` 在每次使用时按会话的项目键取本项目 local 与全局，再排除 suppressed globals；`withTool` 在目录等待后重验当前可见对象身份。`appendLazyProxyDenies` 只负责“一个可见 Lazy 都没有”时隐藏三枚代理，不是双方都有 Lazy 时的授权机制。跨项目拒绝必须在建立连接前完成，测试同时核对另一项目 trace 未被创建。

项目配置遮蔽全局服务器后，即便焦点离开导致 local 卸载，该项目也不回退到被压制的 global。这与原 Eager 语义一致，本轮不改变。

## 架构及产品边界

- 保留 SDK 直接依赖而不手写协议；它与官方客户端使用相同版本，不代表运行两份同一服务器连接。每条服务器选择 Eager 或 Lazy 之一。
- Lazy 不注册每个远端工具；宿主按 `mcp__…` 单工具名施加的策略不覆盖通用代理。行级 allow/deny 仍必须在代理内执行。需要原生策略、instructions 或 Resources 时使用 Eager。
- 无 server 条件的 search 会连接全部可见 Lazy；本轮如实文档化，不新增未经产品确认的并发上限。
- Lazy 工具管理 UI 尚未提供目录编辑入口；既有行级过滤仍生效。本轮不扩展成新的 UI 功能。
- 新服务方法/字段是 additive minor API；核心与 UI 仍须同步升版/发布。本轮不替用户决定发布版本、不回写已发布 v0.12.0 的说明。

## 验证记录

- 初始构建：核心及 UI TypeScript 成功；esbuild 在 workspace-write 沙箱因 piped child spawn `EPERM` 失败，授权原命令后完整构建通过。这是执行环境边界，不能视作产品缺陷。
- 全量 `pnpm test`：**exit 0**（含 pretest 完整 core/UI build）；registry **67 passed**、官方命名对拍 **3 passed**、workspace **11 passed**、UI lifecycle **17 passed**，其余既有套件全部通过。新增生命周期和依赖契约脚本均通过且已进入标准 test 链。
- 全量测试前，增强的慢启动用例真实失败过：`no session spawn after dispose resolved: 2 !== 1`。原因是 SDK 握手错误的 fire-and-forget close 与本地 close 并发，stdio handle 提前清空，使关闭表面完成但进程仍在启动。修复 transport start/close 屏障后，该用例及全量测试通过；未删除、跳过或放宽该断言。
- 最后一处模式写入校验调整（解析合入 mode 后的待写行，避免无法修复旧的非法 mode）之后，重新编译并执行 registry：**67 passed**。
- 核心 `tsc --noEmit`、UI `tsc -p packages/ui/tsconfig.json --noEmit`、`git diff --check`：通过。
- 生命周期测试使用真实 stdio：预取消不启动；connect/list 并发共享；取消一方不影响存活调用；最后一个取消者回收 probe/握手/list/call；重复 dispose 共用屏障；active 调用不触发 idle close；关闭等待者取消不新建；session 慢 start 后的晚到进程必须回收；监控未处理拒绝。idle 时钟由 mock 推进，进程回收用真实 PID 检查，不等五分钟实时间。
- 未做本轮 GUI 手工点测、生产网络端点兼容矩阵、npm 发布或安装 smoke；UI 改动已构建并由宿主路由与纯函数回归覆盖，不宣称当前 GUI 已自动刷新。

## 复审结论

**本次 Gate 1 范围通过**：G1-01～G1-09 均已实施验证。没有发现需要改动授权实现的跨项目越权漏洞；补的是核心承诺缺失的证明。发现的连接/进程竞态与模式占位写入缺陷已修复。通过 Gate 1 不代表 PR 的全部功能、性能或发布步骤已验收。

### 处置映射

| 编号 | 状态 | 产物 |
| --- | --- | --- |
| G1-01 | 完成 | `test/test-registry.mjs`：双方都有 Lazy，同名生效名、异名、双向 search/describe/call，拒绝前不 spawn；全局压制、焦点卸载、销毁会话 |
| G1-02～04 | 完成 | `src/lazy/connection.ts`、`test/test-lazy-lifecycle.mjs`：调用方 abort、世代/transport 屏障、幂等 dispose、独立 30 秒发现超时 |
| G1-05 | 完成 | registry/UI route 契约回归；配置不完整的 disabled 占位拒绝且文件不变；JSON/legacy 原文件不变、disabled 不丢、`mode` 不透传官方断言保留；三对双语指南 |
| G1-06 | 完成 | `test/test-lazy-naming.mjs` 经官方公开 `apply` 与本地 HTTP fixture 对拍实际注册名，再对拍裸名/完整名过滤；不 deep import |
| G1-07 | 完成 | `docs/design/lazy-mcp.md`、`test/test-lazy-dependencies.mjs`，在 Unreleased 记录架构选择与替代方案 |
| G1-08 | 完成 | clientInfo 从本包元数据读版本，并由 stdio initialize trace 验证 |
| G1-09 | 完成 | active Lazy 计为「待使用 / on standby」，不冒充实际运行连接态；三个组件 props readonly |

### 本地提交

- `f480f7d` — 初审报告与实施计划。
- `4dec274` — 调用方取消与连接世代回收。
- `ef4614d` — 慢启动与并发 close 的回收屏障，以及强化的 PID/晚到 spawn 回归。
- `43fac03` — 模式写入校验、双项目授权与 UI route 契约回归。
- `1ef66c9` — 官方命名、过滤及依赖版本契约对拍。
- `4835115` — Lazy 待使用统计与只读 props。
- 最终文档提交 — 双语指南、架构记录、Unreleased 与本复审结果（提交本身不嵌入自身 hash）。

### 保留风险与后续边界

1. **依赖范围风险保留**：官方 client 仍为既有 `^0.2.2-rc.1`，本轮不改依赖版本。对拍在仓库测试时暴露升级漂移，不是消费者安装期的强制限制；未来新解析仍可能出现版本双份。发布如要求完全锁步，应另外评估锁精确版本，不能把测试通过说成消费者永远不会漂移。
2. **SDK 生命周期依赖**：关闭等待 connect/transport settle，不承诺严格 dispose 上限。不能通过超时先返回来隐藏仍在启动的进程。用例覆盖当前 SDK 的真实 session 慢 start 与真实已启动 probe 取消；人为把 SDK 内部 disposable sibling 暂停在建立进程句柄之前的极端 mock 不在覆盖内，需上游提供更强取消契约才能完全证明。SDK 升级须重跑此回归。
3. **资源与排障**：无 server 条件的 search 仍并发连接全部可见服务器，`limit` 不限连接数；连接失败只公开泛化错误/search unavailable，缺少更细的脱敏诊断。本轮文档化，不把未经设计的限流/错误明文输出混入修复。
4. **策略边界**：Lazy 的通用 `mcp_call` 不继承按 `mcp__…` 单工具名设置的宿主策略；需要这类策略、Resources/instructions 的行保持 Eager。Lazy 工具 UI 尚无管理入口，配置级 tools.allow/deny 仍有效。
5. **发布**：新增服务 API 属 minor additive；核心/UI 必须同步升版、同步发布。本轮不改版本号、不发布、不推送。
