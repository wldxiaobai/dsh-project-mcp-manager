# `${VAR}` 展开

[English](env-expansion.md) | 中文

[← 返回 README](../README.zh.md) ｜ 相关：[配置格式](format.zh.md) · [配置来源与分层](layers.zh.md) · [CLI `dsh-mcp`](cli.zh.md)

以上任一来源中，`command`、`args[*]`、`env[*]`、`cwd`、`url`、`headers[*]` 里的
`${VAR}` 引用（正则 `\$\{[A-Za-z_][A-Za-z0-9_]*\}`，允许出现在字符串任意
位置）在装载时刻从 dsh 宿主进程环境做**串内插值**——与 Claude Code 同语义，
`"Authorization": "Bearer ${TOKEN}"` 这类写法可用。变量未设置**或为空串**时
该行跳过装载，诊断记 `env-missing` 并只带变量名（绝不带值）；需要保留字面
`${NAME}` 的写法目前不可表达。含引用的 `url` 在装载前的 schema 校验里任意
位置都放行（包括 host 段，如 `https://${HOST}/mcp`）——合法性只在展开后判定：
展开结果会再过一遍装载 schema 复验，产出非法配置（如 `${GATEWAY}/mcp` 拼出
非 URL）时以 `env-invalid` 跳过，不把坏值递给装载后端。快照/行视图里
`fiberPhase` 保持装载生命周期枚举（未挂上的行是 `pending`），跳过原因走独立
的 `skipReason` 字段（`env-missing` / `env-invalid` / `config-invalid` /
`plugin-throw`）。插件任何写路径都不落盘展开后的值；
CLI 写入时 `${VAR}` 原样保留——配置可以进 git，凭据留在环境里。
