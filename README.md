# dsh-claude-code-sdk

把**自包含的编码任务**委派给本机 Claude Code 执行，结果回传给 DSH。DSH 当 leader，Claude Code 当 worker。

走官方 **Claude Agent SDK**（`@anthropic-ai/claude-agent-sdk` 的 `query()`），不是简单 shell 调用，因此能拿到结构化的执行结果：最终文本、`sessionId`、token 用量，以及 worker 实际调用过的工具列表。

目标宿主是 DSH 0.2.x。

---

## 它解决什么问题

DSH 自己有一套工具循环，适合"边聊边做"。但有些任务更适合交给一个独立 agent 整段跑完：

- 一次要改十几个文件、需要反复读代码再改的重构
- 需要自己跑测试、看失败、再修的长循环
- 你希望"派出去干完再回来"，而不是每一步都在主对话里来回确认

这类任务交给 Claude Code 更合适：它有自己的 Read/Edit/Bash/Grep/Glob 工具链和完整 agent 循环。插件负责把任务交出去、把结果收回来。

关键特性：**内层 Claude Code 的工具调用不会进入外层 DSH 会话的上下文**。它读了二十个文件、跑了十次命令，回给 DSH 的只有一段最终结论。主对话不会被中间过程撑爆。

---

## 工作原理

```
┌──────────────────────────────────────────┐
│ DSH（leader）                            │
│  用户：「让 Claude 去把 xxx 重构了」      │
│         ↓ 模型决定调用 claude_code 工具  │
│  ┌────────────────────────────────────┐  │
│  │ dsh-claude-code-sdk                │  │
│  │  1. 从 exec.agent.session 读历史    │  │
│  │  2. 拼成 transcript + 任务文本      │  │
│  │  3. query() 交给 Claude Agent SDK  │  │
│  └────────────────────────────────────┘  │
└──────────────────┬───────────────────────┘
                   │ stdio
┌──────────────────▼───────────────────────┐
│ Claude Code（worker）                    │
│  自己的 agent 循环：Read → Edit → Bash   │
│  → 看测试结果 → 再改 → …                 │
│  这些中间过程 DSH 看不到                  │
└──────────────────┬───────────────────────┘
                   │ 只回一段最终文本 + 用量
┌──────────────────▼───────────────────────┐
│ DSH 拿到 { output, sessionId, tokens }   │
│  leader 负责 review 和验收                │
└──────────────────────────────────────────┘
```

插件内部对消息流的处理：

- `msg.type === "assistant"` → 累加 `text` 块、把 `tool_use` 的工具名收进集合
- `msg.type === "result"` → 取 `total_cost_usd` 与 `usage.input_tokens` / `usage.output_tokens`；正文为空时回退 `msg.result`
- 失败时按 `msg.result ?? msg.error ?? msg.subtype` 提取原因

---

## 与 zhangjunjesse/dsh-claude-code 的区别

实现思路来自 `dsh-claude-code`。核心逻辑（消息流处理、Config 字段、输出 schema、技能文案结构）与之等价，以下五点是有意改动：

| 差异 | 原因 |
|---|---|
| peer 范围是 `>=0.2.0-rc.2 <0.3.0-0` | 上游钉在 `^0.1.0-rc.6`，在 DSH 0.2.x 上装不进去 |
| `allowedTools` 有默认白名单，含 `Bash` / `PowerShell` | 上游留空时，`acceptEdits` 下所有 shell 命令会被拒，worker 实际干不了活（见「权限模型」） |
| 注入当前 DSH 对话历史 | 让 worker 知道前面聊了什么，不必每次重述背景 |
| 不内置可执行文件路径 | 由 SDK 解析自带的 CLI，跨平台可用；需要时可显式指定 |
| 技能里补充了权限与成本的实操说明 | 上游文案假设的是订阅计费，对第三方中转不成立 |

**两个插件都注册 `claude_code` 这个工具名**，同时安装会冲突（`tool "claude_code" is already registered`）。二选一。

---

## 安装

### 前提

- DSH 0.2.x（`@deepseek-ai/dsh-tools >= 0.2.0-rc.2`）
- 本机已安装并登录 Claude Code（`claude` 能跑起来）
- Node.js >= 22.19.0

### 方式

收录到 [awesome-dsh-plugin](https://awesome-dsh-plugin.com) 后，可在 DSH 的 **设置 → 插件** 里搜索安装，或：

```sh
dsh plugin --profile web add dsh-claude-code-sdk
```

安装顺序是「npm 包 → 作者提供的 GitHub Release tarball → 整仓 GitHub 源码」。本包目前只提供源码，因此走最后一条：克隆仓库后安装依赖。

首次安装需要拉取对应平台的 Claude Agent SDK 二进制，**约 280 MB**，耗时取决于到 GitHub 与 npm 的网络。

### 验证装好了

在 DSH 里发一句：

```
用 claude_code 工具执行：task = "只回复两个字：正常"
```

返回「正常」即通。

如果工具没出现，先确认 DSH 是否真的重启了——插件在启动时装载，改完配置不重启不生效。

---

## 快速开始

不需要特殊语法。工具注册后，DSH 的模型会在合适的时候自己调用；你也可以直接点名。

### 点名调用

```
用 claude_code 工具执行：task = "在 D:\proj 下把 utils.js 里的 callback 写法改成 async/await，改完跑 npm test 确认通过"
```

### 只说意图，让技能接管

```
让 Claude Code 去重构 src/parser.js，拆成三个函数，保持现有测试全绿
```

插件注册的 `claude-code-delegation` 技能会告诉模型什么时候该派活、任务该怎么写、结果怎么质检。

### 多轮迭代

第一次调用返回里有 `sessionId`。第二轮把它作为 `resume` 传回去，Claude Code 记得上一轮读过的文件，不用重新读一遍：

```
用 claude_code 继续上次 sessionId=76ab34e8-... 的工作，把刚才那两个测试失败修掉
```

### Claude 模式（输入框开关）

输入框右侧、模型选择器旁边有一个 **「Claude 模式」** 开关。点一下开启：

- 草稿里会自动写入 `/claude-mode `，你接着写任务即可
- 之后**每一条消息**都会带上这个技能，模型据此把所有任务都委派给 `claude_code`
- 再点一下关闭，前缀会被摘掉

开关状态**按会话独立保存**（写在浏览器 `localStorage` 的 `dsh-claude-mode` 键下），关掉浏览器再回来还在。

开启后 leader 的行为约定：

| 该做 | 不该做 |
|---|---|
| 理解意图、澄清歧义 | 用 read / write / edit / bash 自己动手 |
| 把任务描述写清楚（目标、路径、约束、验收） | 跳过委派直接给答案 |
| review worker 产出、必要时带反馈再派一轮 | 直接采信 worker 的自述 |

如果你在开启状态下想让 leader 自己做某件事，直接说「这次你自己来」，它会照做并提示这偏离了模式。

> 实现细节：技能被选中时，DSH 插入的是**纯文本** `/{skill-name} `（不是特殊组件）。所以开关本质上就是往草稿里维护这个前缀——这也是为什么关掉开关时能把前缀干净地摘掉。

### 任务描述怎么写

Claude Code 只能看到任务文本 + 注入的对话历史，**看不到文件内容、也看不到 DSH 的工具输出**。所以任务里要写清四件事：

1. **目标**：一句话说清交付什么
2. **文件**：相关文件的绝对路径（派活前先自己 grep 摸清结构，把结论写进去）
3. **约束**：构建/验证命令、禁止事项、风格要求
4. **验收**：做到什么算完成

对比：

```
❌ 把上面那个文件改一下
   （不知道"上面"是哪个，也不知道要改成什么）

✅ 把 D:\proj\src\utils.js 里的 debounce 函数改写成支持 cancel 方法。
   要求：保持现有导出名不变，不引入新依赖，改完执行 npx vitest run utils 确认通过。
```

---

## 工具 `claude_code`

### 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `task` | string | ✅ | 完整、自包含的任务描述 |
| `cwd` | string | | 工作目录。默认取配置值，再退到 DSH 进程目录 |
| `model` | string | | 本次覆盖模型（`sonnet` / `opus` / `haiku` 或完整 id） |
| `permissionMode` | string | | `default` / `acceptEdits` / `bypassPermissions` / `plan` / `dontAsk` |
| `maxTurns` | integer | | 本次最大 agentic 轮数 |
| `allowedTools` | string[] | | 预授权的内置工具（白名单放行，不是限制） |
| `resume` | string | | 上次返回的 `sessionId`，续接同一会话 |
| `effort` | string | | 思考强度 `low` / `medium` / `high` / `xhigh` / `max` |
| `maxThinkingTokens` | integer | | 思考 token 预算 |
| `includeHistory` | boolean | | 是否注入 DSH 对话历史，默认取配置值 |

### 返回

```jsonc
{
  "ok": true,
  "output": "最终文本",
  "sessionId": "76ab34e8-0069-4c2c-9a5b-33ee5ac8c812",
  "costUsd": 0.0700,
  "inputTokens": 12020,
  "outputTokens": 2,
  "toolsUsed": ["Write", "PowerShell"]
}
```

`toolsUsed` 是 worker 实际调用过的工具名集合，可以用来判断它有没有真的动手（而不是只回了一段话）。

渲染到对话里时只显示 `output`，不显示金额和 token 数。

---

## 注册的技能

两个技能都可以在输入框用 `/` 选，也可以直接键入 `/名称`：

| 技能 | 用途 |
|---|---|
| `claude-code-delegation` | 按需委派：告诉模型什么时候该派活、任务怎么写、结果怎么质检、多轮怎么 resume。适合偶尔用一次。 |
| `claude-mode` | 全程委派：进入「所有任务都交给 Claude」的模式。输入框开关打开时会自动带上。 |

两者的区别是强度。`claude-code-delegation` 只给方法论，模型仍可自己动手；`claude-mode` 是硬性约定，要求 leader 不用 read/write/bash 自己干活，只负责派活与验收。

`claude-mode` 的内容刻意写得短——它会在开启期间被每一轮重复注入，长度直接计入 token 成本。

## 配置

默认值写在插件自带的 `cordis.patch.yml`。要覆盖就在 profile 的 `cordis.patch.yml` 里按 id 改：

```yaml
- id: claude-code-sdk
  config:
    model: sonnet
    permissionMode: acceptEdits
    maxTurns: 100
    timeoutMs: 600000
    effort: high
    cwd: '/path/to/project'
    allowedTools: [Bash, PowerShell, Read, Write, Edit, Glob, Grep]
    includeHistory: true
    historyMaxMessages: 20
    historyMaxChars: 12000
    # 可选：指定某个 claude 可执行文件；留空则由 SDK 解析自带的 CLI
    pathToClaudeCodeExecutable: '/path/to/claude'
```

### 字段一览

| 字段 | 默认值 | 说明 |
|---|---|---|
| `model` | `sonnet` | 模型别名或完整 id。若 `~/.claude/settings.json` 里配了模型映射，这里写的是映射前的别名 |
| `permissionMode` | `acceptEdits` | 权限模式，详见「权限模型」 |
| `maxTurns` | `100` | 单次委派的最大 agentic 轮数。到顶会报 `Reached maximum number of turns` |
| `timeoutMs` | `600000` | 工具级超时（10 分钟），同时作为 DSH 的工具超时声明 |
| `cwd` | 未设置 | 工作目录。建议显式指定，否则会落在 DSH 进程目录 |
| `allowedTools` | 见下 | 预授权工具白名单。默认 `Bash, PowerShell, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch` |
| `pathToClaudeCodeExecutable` | 未设置 | 留空时由 SDK 解析自己捆绑的 CLI（`claude-agent-sdk-<platform>/claude.exe`） |
| `effort` | `high` | 思考强度 |
| `maxThinkingTokens` | 未设置 | 思考 token 上限，与 `effort` 二选一即可 |
| `includeHistory` | `true` | 是否注入 DSH 对话历史 |
| `historyMaxMessages` | `20` | 最多注入最近多少条消息 |
| `historyMaxChars` | `12000` | 注入历史的字符预算 |

工具参数与配置同名时，**工具参数优先**（`args.x ?? config.x`）。注意空数组不会被默认值覆盖——`[]` 是有效值，`??` 只对 `null` / `undefined` 生效，所以显式传 `allowedTools: []` 就是"什么都不预授权"。

---

## 权限模型

这是最容易踩坑的地方，单独讲。

### 非交互模式没有"询问用户"

SDK 在非交互模式下运行时，没有 `canUseTool` 回调去问人。当 `permissionMode` 是 `acceptEdits` 时：

- 文件编辑（`Write` / `Edit`）→ 自动批准
- 其余工具（`Bash` / `PowerShell` 等）→ **直接拒绝**，返回 `requires approval`，命令根本不执行

模型看到拒绝后通常会重试几次，最后耗尽 `maxTurns` 报错。表现出来就是"卡了很久然后失败"，而不是明确的权限错误。

### 实测对比

同一台 Windows 机器，同一个任务「执行 `node --version` 并把原始输出回报」：

| 配置 | 结果 |
|---|---|
| `acceptEdits`，`allowedTools` 为空 | 命令未运行；worker 回复「该命令需要你批准才能执行」；反复重试至 36 秒后报 `Reached maximum number of turns (6)` |
| `acceptEdits` + `allowedTools: [Bash, PowerShell]` | 9.6 秒返回 `v22.22.2` |
| `bypassPermissions` | 9.4 秒返回 `v22.22.2` |

结论：**`allowedTools` 留空等于让 worker 只能改文件、不能跑命令**。建不了项目、跑不了测试、执行不了 git，实际干不了活。

### 本插件的默认选择

把 shell 与读写检索工具放进默认白名单：

```js
["Bash", "PowerShell", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"]
```

这比开全局 `bypassPermissions` 保守：文件编辑照旧自动批准，shell 显式放行，其他工具仍然拒绝。

### 想更严格 / 更宽松

```yaml
# 更严格：只读，不写不执行
allowedTools: [Read, Glob, Grep]

# 完全不给：只让它读任务、回文本（几乎没实用价值，仅用于验证连通）
allowedTools: []

# 更宽松：不推荐，等于不做任何限制
permissionMode: bypassPermissions
```

`Bash` 与 `PowerShell` 同时列出是刻意的：Windows 上 Claude Code 用 `PowerShell`，其他平台用 `Bash`。多列一个不存在的工具不会报错。

---

## 对话历史注入

默认开启。

### 数据通路

DSH 0.2.x 里，`dsh-agent-loop` 在执行工具时把 agent 实例塞进了执行上下文：

```js
const agent = ctx.agents.requireInitiator();
exec = { callId, name, arguments, agent, signal }
```

而这个 agent 带着活会话，所以插件可以这样读：

```js
exec.agent.session.deriveMessages()
```

返回的是**与发给模型完全一致的消息数组**（只读、纯派生，不修改会话）。

### 过滤规则

消息的 `role` 有 `system` / `developer` / `user` / `assistant` / `tool`，`content` 里的块类型有 `text` / `reasoning` / `tool-call` / `tool-addition` / `tool-removal`。

插件只取 `user` 与 `assistant` 的 `text` 块，其余全部丢弃：

| 丢弃 | 原因 |
|---|---|
| `system` | DSH 自己的系统提示，又长又和任务无关 |
| `developer` | 工具注册变更（`tool-addition` / `tool-removal`），纯噪音 |
| `tool` | 工具结果，体量大且通常无用 |
| `reasoning` 块 | 思考过程 |
| `tool-call` 块 | 工具调用记录（名字和参数） |

末尾那条"决定调用 `claude_code`"的 assistant 消息也会被去掉——对 worker 没有价值。

### 实际拼出来的样子

```
# DSH 会话历史（背景上下文）

以下是本次 DSH 对话此前的记录，供你理解背景、用户偏好和已经做过的决定。
这不是你要执行的任务；你的实际任务在最后。

【用户】
我这个项目的内部代号是 ORION-7，记住。

【助手】
好的，已记住代号 ORION-7。

【用户】
部署脚本放在 D:/deploy 目录下。

---

# 当前任务

把 D:/deploy 下的 build.sh 改成支持 --dry-run 参数。
```

### 截断策略

先按 `historyMaxMessages` 取最近的 N 条，再按 `historyMaxChars` 从新到旧累加：

- 超出字符预算时，从**最早**的消息开始丢
- 如果单条就超预算，截断保留（加 `…（已截断）`），而不是整段丢弃
- 被丢弃的条数会写在 transcript 里：`（更早的 N 条消息已省略）`

注意**条数上限通常比字符上限更早生效**。默认 20 条 × 中位数 700 字符 ≈ 14000 字符，已经超过 12000 的字符预算，实际生效约 16 条。

### 边界

- 历史是**只读背景**，不含文件内容和工具输出。相关文件的绝对路径仍然必须写进 `task`。
- 跨越很多轮的旧约定可能被截掉，关键约束要在任务里重述一遍。
- 读取失败（取不到 session、方法不存在、抛异常）一律静默降级为「不注入」，不会因为读历史把委派搞挂。

### 成本影响

见下节「成本与计费」。

---

## 成本与计费

### 实测 token 构成

用 SDK 直接探 `usage`，两档不同长度的文本反推：

| 输入文本 | `input_tokens` |
|---|---|
| 0（纯任务） | ≈ 12,100 ← Claude Code 自身的固定开销 |
| 5,044 字符 | 14,570 |
| 20,037 字符 | 21,907 |

斜率约 **489 tokens / 千中文字符**（≈ 2 字符/token）。反推得到固定开销 ≈ 12,100 tokens——那是 Claude Code 自己的系统提示（工具说明、行为规范），**不注入历史也存在**，无法通过配置消除。

### 历史注入的增量

| 场景 | 注入字符 | 注入 tokens | 总 input | 相对增幅 |
|---|---|---|---|---|
| 不注入 | 0 | 0 | 12,100 | 基线 |
| 短对话（20 条共 3,500 字符） | 3,500 | ~1,700 | 13,800 | +14% |
| 长对话（撞 12,000 字符上限） | 12,000 | ~5,900 | 18,000 | +49% |

### 真正的成本大头

历史注入只是小头。更大的开销来自：

- **Claude Code 自身固定开销** 12k tokens / 次
- **它自己的多轮循环**：每轮都重发整个上下文。10 轮任务 ≈ 180k input tokens
- **读大文件**：一次读 5,000 行就是 +20k tokens

### 关于 costUsd

`costUsd` 来自 SDK 的 `total_cost_usd`，按 **Anthropic 官方价目**折算。如果 `~/.claude/settings.json` 把 `ANTHROPIC_BASE_URL` 指向了第三方中转，这个数字**不代表真实花费**，只反映 token 量级。渲染时只输出正文，不展示金额。

### 省成本的建议

| 场景 | 建议 |
|---|---|
| 改一行、问个技术问题 | 传 `includeHistory: false` |
| 需要接上下文 | 保持默认 |
| 特别在意成本 | `historyMaxMessages: 8`、`historyMaxChars: 6000` |
| 大重构、跨几十轮 | 可放到 `historyMaxMessages: 40`，但要接受多轮乘法 |

不建议把 `historyMaxChars` 调到 30,000 以上——每次委派的基线成本会翻倍，而历史越长、有用比例越低。

---

## 故障排查

### 工具列表里没有 `claude_code`

1. 确认 DSH 真的重启过（插件在启动时装载）
2. 检查 profile 的 `package.json` 里 `dsh.profile.bundles` 是否包含本包
3. 看 `%APPDATA%\DSH Desktop\lifecycle-events\startup.jsonl` 有没有 `profile-composition` 失败

注意：DSH 的启动日志**不记录插件明细**，`failOnStartupError: false` 下插件加载失败是静默的。最可靠的验证方式是发一条消息，然后看会话文件里 `request/header` 的 `tools` 数组——那才是真正注册成功的清单。

### 报 `requires approval` 或反复重试到 maxTurns

需要的工具不在 `allowedTools` 白名单里。把该工具名加进去，或临时用 `permissionMode: bypassPermissions`。

### 报 `Reached maximum number of turns`

任务太大，或 worker 在某个被拒的工具上反复重试。前者调大 `maxTurns`，后者按上一条处理。

### 返回空

插件会抛 `claude_code returned no output`。常见原因是任务描述太模糊，worker 只回了一句空话或直接放弃。把目标和验收标准写具体。

### 中文输出乱码

检查 `cwd` 下的文件编码，以及终端的代码页。插件本身按 UTF-8 传递，不额外转码。

### `tool "claude_code" is already registered`

同时装了 `dsh-claude-code`。卸载其中一个。

---

## 已知限制

- 工具名 `claude_code` 与 `dsh-claude-code` 冲突，二者不能同时安装。
- 依赖的 SDK 平台包体积约 280 MB，首次安装较慢。
- 依赖 DSH 0.2.x 的 `exec.agent.session.deriveMessages()` 读取历史；该接口变化时历史注入会静默降级（不影响委派本身）。
- 非交互模式下无法进行交互式权限确认，只能靠 `allowedTools` 预授权。
- 一次调用只返回最终文本，中间过程不可见。需要看过程就把 `maxTurns` 调小、让它分段交付。

---

## 安全说明

- 插件本身不发起任何网络请求，也不读写凭据。网络访问全部由 Claude Code 及其 SDK 完成。
- 插件会读取当前 DSH 会话的 `user` / `assistant` 文本并写进给 worker 的 prompt。如果对话里有敏感信息，用 `includeHistory: false` 关闭。
- `allowedTools` 决定 worker 能做什么。默认白名单包含 shell，等于给了 worker 在 `cwd` 下执行命令的能力——请只在你信任的目录里使用。
- `bypassPermissions` 会关闭全部限制，仅在你完全清楚后果时使用。

---

## 开发与本地联调

```bash
git clone https://github.com/wanwulizhi/dsh-claude-code-sdk
cd dsh-claude-code-sdk
npm install
```

本地联调：把目录放到 `~/.dsh/profiles/<profile>/local-plugins/` 下，在 profile 的 `node_modules` 建目录联接指向它，并在 profile `package.json` 的 `dsh.profile.bundles` 与 `dependencies` 里登记。

自检方式（不启动 DSH，直接用真实校验函数跑一遍注册）：

```js
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools';
const mod = await import('./lib/index.js');
const cfg = mod.Config({ cwd: process.cwd() });

let tool, skill;
mod.apply({
  tools:  { register: (d) => { assertSupportedJsonSchema(d.output.schema); tool = d; return () => {}; } },
  skills: { register: (s) => { skill = s; return () => {}; } },
}, cfg);

console.log(tool.name, Object.keys(tool.parameters.properties), skill.name);
```

这能验证 schema 合法性、参数表、技能注册，且不需要真实 DSH 实例。

---

## License

MIT
