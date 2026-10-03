# 本地测试产物与工作区目录说明

## `.dsh/` 的用途

项目内的 `.dsh/` 是 DSH 工作区配置与本地辅助文件目录，不应当成为长期测试产物仓库。它与用户家目录下的 DSH 配置、桌面应用运行数据不是同一个目录。

本仓库通过 `.gitignore` 忽略整个 `.dsh/`。忽略仅表示 Git 不跟踪，并不表示文件会自动清理。

清理后仅保留 `.dsh/skills/` 下两份 Git skill 定义：

- `git-commits/SKILL.md`：暂存和提交规范。
- `git-history-safety/SKILL.md`：分支、历史与恢复安全规则。

虽然它们是 Markdown，但属于 DSH 在固定位置发现的可执行 skill 定义，而非普通项目文档。移到 `docs/` 会改变发现路径，因此保留原位。它们此前已存在于本地，本次没有新增或更改，也没有强制加入 Git。

## 本次清理的来源与处置

| 原始产物 | 来源与用途 | 处置 |
|---|---|---|
| `default-bundle-test/` | 默认双组件 bundle 实现期间的本地 tarball、临时 registry、隔离 Web/headless profile、浏览器测试脚本、DOM/截图和日志 | 测试已结束，全部删除；正式回归仍保留在仓库 `test/` |
| `npm-web-080-test/` | npm 发布后 `0.8.0` 全新 web profile 下载与运行测试，包括独立 store 和 Chrome profile | 报告迁至 [npm Web 验证记录](v0.8.0-npm-web.zh.md)，其他临时产物删除 |
| `compat-015-live.mjs`、`compat-probe.mjs` | v0.4.x 与 dsh `0.1.5-rc.1` 的装载/调用兼容测试；脚本硬编码了当时的本机宿主路径 | 删除，验证结论已在[历史适配记录](../design/adaptation-dsh-0.1.5-rc1.md)归档 |
| `v060-cli-live.mjs`、`v060-probe.mjs` | v0.6.0 CLI、格式互通与工具过滤的一次性探针 | 删除；相关行为由正式回归与[历史发布说明](../releases/v0.6.0.md)维护 |
| `gemini-sample.json` | 上述 CLI 脚本生成的 Gemini `httpUrl` / 不支持 SSE 格式测试样例，使用无效示例地址和变量占位符 | 删除，不是真实服务器配置 |
| `.mcp-diag.json` | 旧版插件在项目目录生成的探针诊断摘要与事件 | 删除，属于过期运行态，不是配置 |
| `v060-headless-2.err` | v0.6.0 headless 实机运行的旧错误日志 | 删除，不是持久文档或当前运行配置 |

两个测试环境合计约 278 MiB **逻辑文件大小**，主要由 npm 依赖和 Chrome 自动下载的缓存/模型文件构成。这不等同于精确释放的磁盘空间：pnpm 可使用硬链接，目录统计也可能重复计算共享文件。

含临时认证 URL 的 Web 启动日志、浏览器 cookie 和 profile 数据不适合放进 `docs/`，本次直接随临时环境删除。清理 pnpm store 时只移除其中的目录链接，不递归删除链接指向的外部位置。

## 后续维护原则

1. 一次性联调尽量使用系统临时目录中的独立 `DSH_HOME`、pnpm store 和浏览器 profile，测试结束后关闭进程并清理。
2. 可复用的回归脚本放进 `test/` 并纳入 Git；不要把依赖旧宿主和本机绝对路径的临时脚本当成正式测试。
3. 长期结论归档到 `docs/testing/`，设计与历史适配记录放在 `docs/design/`；不保留无必要的完整安装环境。
4. 删除 `.dsh/` 内容前逐项确认用途。真实 `mcp.yml` / `mcp.json`、skills 或其他用户配置不可仅因被 Git 忽略就删除。
5. 日志归档前检查认证 URL、cookie、API key 和本机敏感路径；通常保留脱敏结论即可。

本次只清理项目 `.dsh/` 中列明的过期产物，没有改动用户家目录的 DSH 配置、现有桌面应用、发布产物或 `v0.8.0` Git 标签。
