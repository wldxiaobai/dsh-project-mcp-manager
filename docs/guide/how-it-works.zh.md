# 工作原理

[English](how-it-works.md) | 中文

[← 返回 README](../README.zh.md) ｜ 相关：[配置来源与分层](layers.zh.md) · [配置格式](format.zh.md) · [查询面](service.zh.md)

- **项目发现**：在线 agent 会话的 `session.header.cwd` + dsh 进程启动目录 →
  向上找最近的含 `.git` 的祖先目录作为项目根（无 `.git` 时退回目录本身）。
- **装载**：项目层每个 `(项目, serverName)` 在宿主 ctx 上装载一个
  `@deepseek-ai/dsh-mcp-client` 实例（`ctx.plugin`），注册进全局工具层，同一
  项目内多会话共享同一连接。插件启动时装载已恢复会话和进程启动目录中的工作区，
  运行中发现新的工作区时也会装载。已发现且有 MCP 配置的工作区在插件运行期间保持
  装载，切换焦点或关闭会话只更新会话和界面状态。新建会话时最多等待 20 秒，
  等待范围为该会话可见的 Eager 服务器，首条模型请求即可见其工具；启动时恢复
  的会话不等待。新发现的工作区引入重名时，已有 Eager 实例保留名称和连接。
  Lazy 服务器仍按需建立连接。
  **用户层每行只装载一个实例**（全局，与项目数无关）
  ——详见[配置来源与分层](layers.zh.md)。
- **热重载**：chokidar 只监听已知项目根和它的 `.dsh`（depth 1）。放行的是
  项目根、`.dsh` 和三个配置文件，其它路径一律忽略，因此不会打开 `lib/`、
  `src/`、`build/`，Windows 上构建时可以删掉这些目录。只有**已知项目根的精确
  配置文件**（`<projectRoot>/.dsh/mcp.yml`、`<projectRoot>/.dsh/mcp.json` 与
  `<projectRoot>/.mcp.json`）的改动经 150ms 防抖触发全量对账：新增行装载、
  删除行卸载、配置变化重装。另有独立 watcher 以
  **精确文件路径**监听用户层：`~/.dsh/mcp.yml`、`~/.dsh/mcp.json`、
  `~/.dsh/profiles/<当前 profile>/mcp.yml` 与 `mcp.json`，以及 `$DSH_HOME/dsh-mcp.json`
  （对方插件的全局存储；只监听以便创建时能立刻诊断，从不装载）。chokidar v5
  对被监听的缺失文件能在其创建时补发事件，前提是父目录已存在——不监听家目录
  整体。
- **profile 名解析**：从 loader 根 include 的 `config.path`
  （`~/.dsh/profiles/<name>/cordis.yml`）或 `ctx.baseUrl` 推导，可用
  `DSH_MCP_PROFILE=<name>` 覆盖；解析不出时不读 profile 层（其余层照常）。
- **生效名**：原始 `serverName` 在整个目录（宿主全局行 + 全部项目行）中唯一时
  保持原名；冲突时**项目行**改为 `p<sha256(项目根)前6位>_<原名>`（截断 32 字符），
  避免 `dsh-mcp-client` 按进程根的 serverName 预留冲突。已挂载 Eager 的生效名
  优先保留（宿主全局名占用除外），新发现工作区引入重名时只改新行、不重挂在线
  实例；因此生效名依赖挂载历史，冲突消失后已挂实例保持前缀名直到卸载。生成名
  撞字面名/截断名时追加确定性哈希后缀（`<前23字符>_<8位hex>`）。全局行
  （profile patch 行与用户层行）参与占用判定但不改名。模型可见的工具名由生效
  服务器名与 MCP 工具自身的名字拼成 `mcp__<生效名>__<工具名>`，与文件里写的
  `serverName` 可能不同。
- **会话可见性**：agent 创建时按其会话 cwd 解析项目，对该 agent 应用
  `tools.restrict({ deny })`，deny 掉除本会话项目外的全部项目服务器，以及本项目
  自身行压制过的全局服务器；会话无 cwd 时回退 owner 项目（子代理），再回退 dsh
  进程 cwd 所在项目。服务器说明和资源列表按同一规则过滤，资源调用也按会话校验。
  会话销毁时释放工具限制。
- **上下文占用**：`contextCost()` 给会话可见的 MCP 工具定义计价；`resultCost()`
  给仍保留的、能对应到 MCP 工具调用的 `tool/result` 消息计价，数据取自
  `session.deriveMessages()`，被裁剪或压缩掉的结果自然不再计入。Lazy 代理定义作为
  共享开销只计一次，Lazy 结果按代理参数里的 `server` 归属。两者都按 token-meter
  口径估算；请求头、工具结果或压缩替换 surface 改变数字后，registry 会重发
  `projectMcp/updated`。见[查询面](service.zh.md#工具调用结果占用)。
