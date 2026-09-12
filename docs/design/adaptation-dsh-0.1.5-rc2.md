# 适配记录：dsh v0.1.5-rc.2

[← 返回 README](../README.zh.md) ｜ 相关：[dsh v0.1.5-rc.1 适配记录](adaptation-dsh-0.1.5-rc1.md)

**记录日期**：2026-09-12 ｜ **被测插件**：`dsh-project-mcp-manager` v0.4.3
**宿主**：`@deepseek-ai/dsh@0.1.5-rc.2`（`next` dist-tag；自带
`dsh-mcp-client@0.1.5-rc.2`、cordis 4.0.2、cordis-plugin-loader 1.0.3、
cordis-plugin-include 1.0.7）

**结论**：与 0.1.5-rc.1 **兼容，无需改插件源码或依赖范围**。官方 rc.2 发布说明只涉及
Web 反馈弹窗与交付文件卡片排版；本插件依赖的装载 API 未变。`@deepseek-ai/dsh-mcp-client`
与 `@deepseek-ai/dsh-tools` 的 `lib/` 相对 rc.1 **字节级相同**，package.json 仅版本号
与 peer 范围从 `^0.1.5-rc.1` 改到 `^0.1.5-rc.2`。

现有 specifier `^0.1.5-rc.1` 与 rc.2 同属 `0.1.5` 元组，**可以**解析到
`0.1.5-rc.2`（不像 0.1.2 → 0.1.5 那样必须改范围）。锁文件仍钉在 rc.1 不影响行为：
装载实现与 rc.2 宿主自带的客户端是同一份代码。

---

## 1. 官方 rc.2 变更（与本插件无关）

[dsh-v0.1.5-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.2)
相对 rc.1：

- 点赞/点踩改为弹窗确认，提交失败保留已填内容。
- 交付文件卡片排版、对话间距与代码文件图标。

未提及 MCP 客户端、`tools.restrict`、agents 事件或 bundle patch 合成。

npm：`@deepseek-ai/dsh` 的 `latest` 仍是 `0.1.5-rc.1`，`next` 是 `0.1.5-rc.2`
（2026-09-10 发布）。CLI 依赖面与 rc.1 同构，版本号一律改为 `^0.1.5-rc.2`。

---

## 2. 兼容性核对结果（静态）

| 插件依赖点 | 0.1.5-rc.2 现状 |
|---|---|
| `dsh-mcp-client` `lib/index.js` 与全部 `lib/types/*.d.ts` | 与 rc.1 SHA-256 相同 |
| `dsh-tools` `lib/index.js` / `lib/invariant.js` | 与 rc.1 SHA-256 相同 → `restrict` / `schemas` 签名未变 |
| mcp-client `Config` / `inject = ["tools"]` | 未变 |
| `serverName` `[A-Za-z0-9_-]{1,32}`、工具名 `mcp__<serverName>__<raw>` | 未变 |
| cordis 4.0.2、include 1.0.7 `patches`、loader 1.0.3 | 未升级 |
| `^0.1.5-rc.1` 能否解析 rc.2 | 能（同 major.minor.patch 元组） |

**不升范围的理由**：把下限改成 `^0.1.5-rc.2` 会让仍停留在 rc.1 宿主的用户装入
rc.2 peer，而运行时并无差异。0.4.3 当时升范围，是因为 `^0.1.2-rc.1` **解析不到**
`0.1.5-rc.*`。

---

## 3. 建议

1. **无需发对齐版**：v0.4.3 在 dsh 0.1.5-rc.2 上可继续用。
2. 本地 lock 钉在 rc.1 可保留；若要与 `next` 宿主同解析，fresh install 会因
   `^0.1.5-rc.1` 选到 rc.2。
3. 热重载 / 跨项目 deny / headless LLM 路径与 [rc.1 记录 §3.3](adaptation-dsh-0.1.5-rc1.md)
   相同，本次未在 rc.2 宿主进程里复跑（运行时字节相同）。
