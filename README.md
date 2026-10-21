# dsh-claude-code-sdk

把**自包含的编码任务**委派给本机 Claude Code 执行，结果回传给 DSH。DSH 当 leader，Claude Code 当 worker。

走官方 **Claude Agent SDK**（`@anthropic-ai/claude-agent-sdk` 的 `query()`），不是简单 shell 调用，因此能拿到流式的 assistant 消息、`sessionId`、token 用量和 worker 实际调用过的工具列表。

内层 Claude Code 自己跑完整的工具循环，**它的工具调用不进入外层 DSH 会话的上下文**。

## 与 zhangjunjesse/dsh-claude-code 的区别

本插件的实现思路来自 `dsh-claude-code`，核心逻辑（消息流处理、Config 字段、输出 schema、技能文案结构）与之等价。以下四点是有意改动：

| 差异 | 原因 |
|---|---|
| peer 范围是 `>=0.2.0-rc.2 <0.3.0-0` | 上游钉在 `^0.1.0-rc.6`，在 DSH 0.2.x 上装不进去 |
| `allowedTools` 有默认白名单，含 `Bash` / `PowerShell` | 上游留空时，`acceptEdits` 下所有 shell 命令会被拒（见下文「权限」） |
| 注入当前 DSH 对话历史 | 让 worker 知道前面聊了什么，不必每次重述背景 |
| 不内置可执行文件路径 | 由 SDK 解析自带的 CLI，跨平台可用；需要时可显式指定 |

**两个插件都会注册 `claude_code` 这个工具名**，同时安装会冲突（`tool "claude_code" is already registered`）。二选一。

## 安装

```bash
dsh plugin add dsh-claude-code-sdk
```

或在插件市场里搜索安装。

安装后无需额外配置即可使用。首次调用会由 npm 拉取对应平台的 SDK 二进制（约 280 MB）。

## 注册了什么

### 工具 `claude_code`

| 参数 | 必填 | 说明 |
|---|---|---|
| `task` | ✅ | 自包含的任务描述（目标、文件、约束、验收标准） |
| `cwd` | | 工作目录，默认取配置值或 DSH 进程目录 |
| `model` | | 本次覆盖模型（`sonnet` / `opus` / `haiku` 或完整 id） |
| `permissionMode` | | `default` / `acceptEdits`（默认）/ `bypassPermissions` / `plan` / `dontAsk` |
| `maxTurns` | | 本次最大 agentic 轮数 |
| `allowedTools` | | 预授权的内置工具（白名单放行，不是限制） |
| `resume` | | 上次返回的 `sessionId`，续接同一会话 |
| `effort` | | 思考强度 `low` / `medium` / `high` / `xhigh` / `max` |
| `maxThinkingTokens` | | 思考 token 预算 |
| `includeHistory` | | 是否注入 DSH 对话历史，默认取配置值 |

返回：`{ ok, output, sessionId, costUsd, inputTokens, outputTokens, toolsUsed }`

### 技能 `claude-code-delegation`

随插件注册的 Leader-Worker SOP：什么时候该委派、任务该怎么写、结果怎么质检、多轮怎么 resume。

## 配置

默认值写在 `cordis.patch.yml`。要覆盖就在 profile 的 `cordis.patch.yml` 里按 id 改：

```yaml
- id: claude-code-sdk
  config:
    model: sonnet
    permissionMode: acceptEdits
    maxTurns: 100
    timeoutMs: 600000
    effort: high
    cwd: '/path/to/project'
    allowedTools: [Bash, Read, Write, Edit, Glob, Grep]
    includeHistory: true
    historyMaxMessages: 20
    historyMaxChars: 12000
    # 可选：指定某个 claude 可执行文件，留空则由 SDK 解析自带的 CLI
    pathToClaudeCodeExecutable: '/path/to/claude'
```

| 字段 | 默认值 |
|---|---|
| `model` | `sonnet` |
| `permissionMode` | `acceptEdits` |
| `maxTurns` | `100` |
| `timeoutMs` | `600000`（10 分钟） |
| `effort` | `high` |
| `cwd` | 未设置（用 DSH 进程目录） |
| `allowedTools` | `Bash, PowerShell, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch` |
| `pathToClaudeCodeExecutable` | 未设置（SDK 自带 CLI） |
| `maxThinkingTokens` | 未设置 |
| `includeHistory` | `true` |
| `historyMaxMessages` | `20` |
| `historyMaxChars` | `12000` |

## 权限：为什么 `allowedTools` 必须有默认值

SDK 在**非交互模式**下没有「询问用户」这一环。当 `permissionMode` 是 `acceptEdits` 时：

- 文件编辑（`Write` / `Edit`）→ 自动批准
- 其余工具（`Bash` / `PowerShell` 等）→ **直接拒绝**，返回 `requires approval`，命令根本不执行

同一台机器、同一个任务（「执行 `node --version` 并回报原始输出」）的实测结果：

| 配置 | 结果 |
|---|---|
| `acceptEdits`，`allowedTools` 为空 | 命令未运行，worker 回复「该命令需要批准」 |
| `acceptEdits` + `allowedTools: [Bash, PowerShell]` | 约 10 秒返回版本号 |
| `bypassPermissions` | 约 10 秒返回版本号 |

所以本插件把 shell 与读写检索工具放进默认白名单：等价于放行常用工具，但不开放全局 bypass。

需要更严格时显式传 `allowedTools: []`（空数组不会被默认值覆盖）。

## 注入 DSH 对话历史

默认开启。派活时从当前会话读出模型可见的消息历史，格式化成 transcript 拼在任务前面：

```
# DSH 会话历史（背景上下文）

以下是本次 DSH 对话此前的记录，供你理解背景、用户偏好和已经做过的决定。
这不是你要执行的任务；你的实际任务在最后。

【用户】
我这个项目的内部代号是 ORION-7，记住。

【助手】
好的，已记住代号 ORION-7。

---

# 当前任务

把部署脚本改成支持 --dry-run 参数。
```

只取 `user` 与 `assistant` 的正文文本块；`system`（DSH 系统提示）、`developer`（工具注册变更）、`tool`（工具结果）、`reasoning` 与 `tool-call` 块都会被过滤。

**边界**

- 历史是**只读背景**，不含文件内容和工具输出。相关文件的绝对路径仍然必须写进 `task`。
- 跨越很多轮的旧约定可能被 `historyMaxMessages` / `historyMaxChars` 截掉，关键约束要在任务里重述。
- 读取失败（取不到 session、方法不存在、抛异常）一律静默降级为「不注入」。

**成本**

Claude Code 单次调用自身有约 12k input tokens 的固定开销；注入历史按其长度额外增加，实测约 **489 tokens / 千中文字符**。默认上限下，短对话约 +1.7k，长对话撞 12000 字符上限约 +5.9k。历史会进入 worker 的每一轮上下文，多轮任务会重复发送。

小任务可以传 `includeHistory: false` 省掉这部分。

## 关于 costUsd

`costUsd` 来自 SDK 的 `total_cost_usd`，按 **Anthropic 官方价目**折算。如果 `~/.claude/settings.json` 把 `ANTHROPIC_BASE_URL` 指向了第三方中转，这个数字**不代表真实花费**，只反映 token 量级。

## 已知限制

- 工具名 `claude_code` 与 `dsh-claude-code` 冲突，二者不能同时安装。
- 依赖的 SDK 平台包体积约 280 MB，首次安装较慢。
- 依赖 DSH 0.2.x 的 `exec.agent.session.deriveMessages()` 读取历史；该接口变化时历史注入会静默降级（不影响委派本身）。

## 开发

```bash
git clone <repo>
cd dsh-claude-code-sdk
npm install
```

本地联调时，把本目录放到 `~/.dsh/profiles/<profile>/local-plugins/` 下，在 profile 的 `node_modules` 建目录联接指向它，并在 profile `package.json` 的 `dsh.profile.bundles` 与 `dependencies` 里登记。

## License

MIT
