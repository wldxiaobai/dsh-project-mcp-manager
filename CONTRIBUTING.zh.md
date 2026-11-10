# 贡献指南

[English](CONTRIBUTING.md) | 中文

感谢你帮助改进 `dsh-project-mcp-manager`。问题报告、文档修正和代码改动都欢迎。

## 开始之前

- 小修复（错别字、文档、明显的 bug）可以直接提 PR。
- 新功能、行为变更、新增依赖，或改动 `projectMcp` 服务面，请先开
  [Issue](https://github.com/wldxiaobai/dsh-project-mcp-manager/issues) 讨论方案。
- 一个 PR 只做一件事。

## 开发环境

需要 Node.js 和 pnpm（版本见 `package.json#packageManager`）。`pnpm-lock.yaml`
是唯一的锁文件，请不要提交 `package-lock.json` 或 `yarn.lock`。

```powershell
pnpm install
pnpm run build     # 先构建核心（src/ → lib/），再构建 UI 包
pnpm test          # 先构建，再用 node 依次运行 test/*.mjs
```

要在 DSH 里试用本地构建，按 [README](docs/README.zh.md#安装挂载到-profile)
中源码仓库的步骤执行 `dsh plugin --profile <p> add link:<仓库路径>`，每次改动后重新构建。
测试时请使用单独的 profile 或临时 `DSH_HOME`。

## PR 自查清单

- 从 `dev` 拉分支，PR 目标为 `dev`。`main` 是稳定分支，只由维护者发布时合入。
- `pnpm run build` 与 `pnpm test` 通过。
- 行为变更和 bug 修复附带 `test/` 下的测试（直接用 `node` 运行的脚本，不使用测试框架）。
- 用户可见的改动同时更新中英文文档：`README.md` 与 `docs/README.zh.md`，以及对应的
  `docs/guide/*.md` / `*.zh.md`。
- 在 [CHANGELOG.md](CHANGELOG.md) 的 `[Unreleased]` 下添加条目。
- 不要修改 `package.json` 或 `packages/ui/package.json` 的版本号；由维护者在发布时
  统一升版，并保持 manager 与 UI 版本一致。
- 新增依赖使用精确或严格锁定的版本，并在 PR 中说明用途。
- 在 PR 描述中写明改了什么、如何验证（运行的测试、DSH 版本、平台）。

## 代码与提交

- TypeScript（ESM，`strict`）。沿用周边代码风格，优先复用现有工具函数，不引入新库。
- [AGENTS.md](AGENTS.md) 记录了项目内部约定（来源优先序、生效名、会话隔离、受管文件
  写入）。改动 `src/registry.ts`、`src/model.ts` 或文件写入相关代码前，请先读对应部分。
- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：
  `<type>(<scope>): <subject>`，例如 `fix(cli): 拒绝无效的 profile 名`。
  仓库历史使用中文 subject，英文也可以接受。
- 每个提交保持小而完整：能单独构建，也能单独审查或回退。

## 审查与合并

- 请保持勾选「Allow edits by maintainers」。审查期间维护者可能直接向你的分支推送修复。
- PR 以 merge commit 方式合并，会保留你的提交与作者信息。贡献者会记录在 CHANGELOG
  与 README 中。

## 安全

`stdio` 服务器条目会启动本地命令，因此涉及配置装载、`${VAR}` 展开和受管文件写入的
改动会重点审查。发现安全问题时请不要公开开 Issue，请通过 `package.json#author`
中的邮箱私下联系维护者。

## 许可

提交贡献即表示你同意按本项目的 [MIT License](LICENSE) 授权你的贡献。
