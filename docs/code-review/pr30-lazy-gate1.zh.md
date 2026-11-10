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
- 最终测试、修复提交与 Gate 判定：实施完成后补记。
