# chatlog-viewer

English: [README.md](README.md)

用于阅读 Claude Code 与 Codex 会话日志的本地 Web 界面。会话按工作目录或时间分组。
用户消息完整显示，助手回复、思考与工具调用默认折叠。

仅使用 Python 标准库：无第三方依赖，不访问网络。日志文件只读取，不修改。

## 运行

```bash
python server.py              # 启动并打开浏览器（默认 http://127.0.0.1:16010）
python server.py --port 16011  # 使用其他端口
python server.py --no-open    # 不打开浏览器
python server.py --reindex    # 丢弃缓存，重新解析全部日志
python server.py --base-path /chatlog   # 挂载到某个路径前缀下
```

Windows 下 `start.cmd` 执行相同命令。

`--base-path` 用于置于共享入口之后的场景：一个对外端口前置多个应用，源站根路径
不属于其中任何一个。前缀在入口处剥离，因此各路由自身的形态保持不变；页面以相对
路径引用静态资源，并以自身所在目录解析 API 调用，故无需再告知其挂载位置。

## 日志来源

| 来源 | 路径 |
| --- | --- |
| Claude Code | `~/.claude/projects/<project>/<sessionId>.jsonl` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`、`~/.codex/archived_sessions/**` |

## 索引

首次运行解析全部会话，并将摘要索引写入 `.cache/index.json`（开发机上 116 个会话耗时不到
一分钟）。之后仅重新解析 mtime 或大小发生变化的文件。顶栏的 `Reindex` 触发增量重扫。

会话正文按请求实时解析，不做缓存，因此打开的会话始终反映其日志文件的当前内容。
当日志自索引以来有增长时，其索引条目会基于同一次解析结果重建。

## 界面

### 侧栏

- `Group`：Folder、Time 或 Flat。目录分组不区分大小写，因为 Windows 报告的工作目录
  大小写不一致。
- `Show`：All、★ 或 Archived。
- `Hide sessions I never spoke in`（默认启用）排除没有用户消息的会话，例如仅包含一条
  `/clear` 的会话。
- 来源（Claude Code / Codex）在顶栏筛选。
- 每行显示对应日志文件的大小，分组标题显示该组合计。
- 拖动分隔条调整宽度（220–680 px），双击恢复为 330 px。`Ctrl+B` 或 ◀ 按钮收起侧栏。
  两项设置均保存在 `localStorage`。

### 正文

- 每条用户消息渲染为一张卡片。以斜杠命令发送的消息会将命令名显示为标签。
- 两条用户消息之间的助手活动折叠为一行摘要（`AI  <首句>  2 replies · 11 tools`）。
  展开后显示回复正文、思考块和逐条工具调用。
- 助手回复按 markdown 渲染：围栏代码块、标题、带 `:---:` 对齐的管道表格、嵌套列表、
  任务列表、块引用、分隔线、删除线、行内代码与链接。只有当某行的下一行是单元格数量
  相同的分隔行时，该行才被解析为表头；其他包含 `|` 的行按普通文本处理。
- `Markdown` / `Raw text` 在渲染结果与等宽显示的原始文本之间切换全部助手回复和思考块。
  该设置对所有会话生效，保存在 `localStorage`。
- `↑ Newest first` 反转正文顺序。反转的单位是一轮问答——一条用户消息及其之后的助手
  活动——因此回复不会被排到它所回应的消息之前。该设置保存在 `localStorage`。
- 被取消后重新输入的消息以灰色显示并加中划线，并带 `CANCELLED` 标记。判据是结构性的：
  当一条用户消息之后、下一条用户消息之前不存在任何 AI 活动时，该消息被标记。会话的
  最后一条消息永不标记，因为该会话可能仍在进行中。
- `⟳ Refresh` 在不离开当前会话的前提下重新读取日志。标签页可见时还会每 4 秒轮询一次，
  仅在 mtime 或大小发生变化时才重新读取，因此可以实时跟随仍在写入的会话。重新读取会
  保留滚动位置、已展开的助手回合和已折叠的侧栏分组，并更新头部与侧栏的计数。
- `Expand all AI`、`Collapse all` 和 `Only my messages` 仅作用于当前打开的会话。
- 主题跟随系统的浅色/深色设置。会话路径保存在 URL fragment 中，可对单个会话添加书签。

## 搜索

顶栏搜索框仅匹配用户消息，助手回复与工具输出不参与索引。

- 纯子串匹配，忽略大小写。不支持正则、模糊匹配和分词。查询作为单个字面量整体匹配，
  因此 `docker 配置` 仅在这些字符连续出现时才命中。
- 匹配在服务端执行，对象是索引时收集的文本，覆盖全部会话。请求在最后一次按键后
  120 ms 发出；116 个会话上的匹配耗时为个位数毫秒。
- 从第一次按键起即反馈状态：请求发出前显示旋转指示和 `Searching…`，随后替换为
  `N sessions` 或 `No matches`。响应带序号，在更新的查询发出后才到达的响应会被丢弃。
- 结果替换侧栏列表，并仍受来源、★ 和归档筛选影响。每行显示命中次数和首条匹配片段。
- 查询词会在会话标题、侧栏片段以及所打开会话的用户消息卡片中高亮。
- 限制：每个会话索引用户文本的前 30 000 字符（`server.py` 中的 `SEARCH_BUDGET`），
  每个会话最多返回 4 条片段，最多返回 400 个会话。结果按会话开始时间倒序排列，
  而非按相关度排列。

快捷键：`/` 聚焦输入框，`Esc` 退出，`j` 和 `k` 在结果间移动。清空输入框恢复完整列表。

## 会话管理

日志文件不会被修改。标记保存在 `store.json` 中，以日志路径为键。

| 操作 | 控件 | 效果 |
| --- | --- | --- |
| 收藏 | 侧栏行上的 ☆，或正文头部按钮 | 设置 `star`，由 ★ 控件筛选 |
| 归档 | 正文头部按钮 | 从 `All` 中排除，列在 `Archived` 下 |
| 重命名 | 正文头部按钮 | 覆盖标题；提交空值恢复自动生成的标题 |
| 备注 | 正文头部按钮 | 自由文本，显示在正文头部和侧栏行上 |
| 删除 | 正文头部按钮，需再次点击确认 | 将日志移入 `.trash/`，文件名带时间戳 |

删除可撤销：将文件从 `chatlog-viewer/.trash/` 移回原目录，再执行 `Reindex` 即可。
`.trash/` 不会自动清空。

确认与文本输入均为行内控件。未使用 `confirm()` 和 `prompt()`，因为两者会阻塞页面。

## 如何判定用户输入

两种日志格式需要不同的规则。

- **Claude Code**：`type == "user"` 的记录同时承载工具结果和注入的上下文。只有
  `origin.kind == "human"` 的记录被视为用户输入。`tool_result` 块、
  `<system-reminder>` 和 `<local-command-stdout>` 归类为折叠内容。
- **Codex**：`event_msg` 流（`user_message`、`agent_message`）保存的是呈现给用户的
  对话内容，而 `response_item` 还包含 `<environment_context>`、`<recommended_plugins>`
  等注入块。因此消息内容取自 `event_msg`，工具调用取自 `response_item`。
- 斜杠命令的参数（`<command-name>`）是用户输入的文本，按普通消息处理，也参与搜索。
  不带参数的命令渲染为标签。

已知限制：从 Claude Code 导入的 Codex 会话（记录于
`~/.codex/external_agent_session_imports.json`）的每条记录都带有导入时间而非原始对话
时间，因此其时间戳没有参考价值。

## 目录结构

```
server.py     HTTP 服务、索引与缓存、搜索、管理接口
parsers.py    将两种日志格式映射到统一的消息模型
static/       前端（原生 JavaScript，无框架，无构建步骤）
.cache/       派生索引，可安全删除
store.json    收藏、归档标记、重命名和备注；唯一的非派生状态
.trash/       已删除的日志
```

## HTTP 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/sessions` | 索引列表，已合并用户标记 |
| GET | `/api/session?path=` | 单个会话解析后的消息；文件增长时同时重建其索引条目 |
| GET | `/api/peek?path=` | 单个日志的 mtime 与大小，用于变更检测 |
| GET | `/api/search?q=` | 匹配查询的会话及片段 |
| GET | `/api/status` | 索引进度 |
| GET | `/api/reindex` | 启动一次增量重扫 |
| POST | `/api/manage` | `{path, patch}`；patch 字段：`star`、`archived`、`title`、`note` |
| POST | `/api/delete` | `{path}`；将日志移入 `.trash/` |

## 消息模型

| 角色 | 含义 |
| --- | --- |
| `user` | 用户输入。只有该角色计入 `N from me` 与搜索。被取消并替换时带 `superseded` 标记 |
| `command` | 不带参数的斜杠命令 |
| `assistant` | 助手回复正文 |
| `thinking` | 助手思考块 |
| `tool_use` | 工具调用及其参数 |
| `tool_result` | 工具输出 |
| `user_auto` | 并非由人发起的 `user` 记录 |
| `meta` | 注入的系统内容 |
