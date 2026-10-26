/**
 * dsh-claude-code-sdk
 *
 * Delegate a self-contained coding task to the local Claude Code agent through
 * the official Claude Agent SDK (@anthropic-ai/claude-agent-sdk), and return the
 * final text plus session id and usage.
 *
 * Differences from zhangjunjesse/dsh-claude-code:
 *   - Supports DSH 0.2.x (peer range is 0.2.0-rc.2 and up, not 0.1.x)
 *   - allowedTools ships a default allowlist including the shell tools. Without
 *     it, acceptEdits denies every shell command in non-interactive mode, so the
 *     worker can edit files but cannot run anything.
 *   - Injects the current DSH conversation history (user/assistant text only)
 *     into the delegated task, configurable and switchable per call.
 *   - No hardcoded executable path: the SDK resolves its own bundled CLI, and
 *     pathToClaudeCodeExecutable stays optional for pointing at a custom one.
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import {
  createSnapshot,
  diffScans,
  formatChangeSummary,
  pruneSnapshots,
  restoreSnapshot,
  scanWorkspace,
} from "./workspace.js";

// 本插件版本，从同目录 package.json 动态读取，供 CLAUDE_AGENT_SDK_CLIENT_APP 标识串拼接，
// 避免与 package.json 的 version 字段脱节。
const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

export const name = "claude-code-sdk";
export const inject = ["tools", "skills"];

// acceptEdits only auto-approves file edits; the shell and other tools must be
// explicitly pre-approved, otherwise non-interactive mode denies them outright
// (there is no canUseTool callback that could ask a human).
const DEFAULT_ALLOWED_TOOLS = ["Bash", "PowerShell", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"];

export const Config = z.object({
  model: z.string().description("Claude model alias (sonnet/opus/haiku) or full id.").default("sonnet"),
  permissionMode: z
    .string()
    .description("Claude Code permission mode: default, acceptEdits, bypassPermissions, plan, or dontAsk.")
    .default("acceptEdits"),
  allowDangerouslySkipPermissions: z
    .boolean()
    .description("Safety switch required by the SDK when permissionMode is 'bypassPermissions'; the plugin refuses to run that mode unless this is true.")
    .default(false),
  maxTurns: z.number().description("Maximum Claude Code agentic turns per task.").default(40),
  timeoutMs: z.number().description("Cooperative timeout budget for one call (ms).").default(300000),
  // 默认行为（按优先级）：args.cwd → config.cwd → 会话工作区（exec.agent.session.header.cwd）→ process.cwd()
  cwd: z.string().description("Working directory for Claude Code; defaults to the session workspace cwd, then the DSH process cwd."),
  allowedTools: z
    .array(z.string())
    .description("Claude Code built-in tools to pre-approve (allowlist, not a restriction). Empty array = no pre-approval.")
    .default([...DEFAULT_ALLOWED_TOOLS]),
  disallowedTools: z
    .array(z.string())
    .description(
      "Tools to remove from the worker entirely. This is the only option that shrinks the worker's system prompt: " +
        "measured 11,993 → 7,760 input tokens (-35%) with the read-only set. Removing tools also denies them.",
    )
    .default([]),
  pathToClaudeCodeExecutable: z
    .string()
    .description("Path to a specific claude executable; when omitted the SDK resolves its own bundled CLI."),
  effort: z.string().description("Thinking effort: low, medium, high, xhigh, or max.").default("high"),
  maxThinkingTokens: z.number().description("Optional thinking token budget per task."),
  includeHistory: z
    .boolean()
    .description("Prepend the current DSH conversation history (user/assistant text) to the delegated task.")
    .default(true),
  historyMaxMessages: z.number().description("Maximum number of recent history messages to include.").default(20),
  historyMaxChars: z
    .number()
    .description("Character budget for the injected history; older messages are dropped first.")
    .default(12000),
  trackChanges: z
    .boolean()
    .description("Snapshot the workspace before delegating, report which files changed, and enable revert via claude_code_revert.")
    .default(true),
  maxTrackedFileSize: z
    .number()
    .description("Per-file byte limit for snapshot backup; larger files are reported but cannot be restored.")
    .default(524288),
  maxTrackedTotalBytes: z
    .number()
    .description("Total snapshot backup budget in bytes; exceeding it degrades to report-only.")
    .default(67108864),
  maxTrackedFiles: z
    .number()
    .description("Maximum files to scan; a larger tree is left untracked instead of producing a partial, misleading diff.")
    .default(8000),
  maxTrackedMs: z
    .number()
    .description("Time budget for one workspace scan in milliseconds; exceeding it leaves the delegation untracked.")
    .default(1000),
  keepSnapshots: z.number().description("How many snapshots to retain before pruning older ones.").default(20),
});

const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"];

const DELEGATION_SKILL = {
  name: "claude-code-delegation",
  description:
    "Leader-Worker 流程：把自包含的编码子任务（写/改插件、重构、修 bug 补测试）委派给本机 Claude Code 执行并循环质检。任务需要 Claude Code 自己读文件、跑循环时用它。",
  whenToUse:
    '用户要求写/改代码且任务自包含、边界清晰（尤其"让 Claude 来写/修 XX"）；或维护本插件本身时。',
  source: "runtime",
  content: [
    "# Claude Code 委派 SOP（Leader-Worker）",
    "",
    "DSH 是 leader，本机 Claude Code 是 worker（走官方 Agent SDK）。工具：claude_code。",
    "",
    "## 何时用 / 何时不用",
    "- 用：自包含、边界清晰的编码任务（写/改插件、重构、修 bug + 补测试、脚手架）；上下文能从文件系统获得（Claude Code 自带 Read/Edit/Bash/Grep/Glob）。",
    "- 不用：强依赖 DSH 生态（subagent/workflow/goal/todo）的任务，自己干。",
    "",
    "## 上下文传递",
    "- 默认会把**当前 DSH 对话历史**（用户与助手的正文，不含工具结果）自动拼在任务前面，所以 Claude Code 大致知道前面聊了什么。",
    "- 但它是「只读背景」，看不到文件内容、也看不到工具输出。所以**相关文件的绝对路径仍然必须写进任务**，别指望它自己找。",
    "- 历史有长度上限（默认最近 20 条、12000 字符）。跨越很多轮的旧约定可能已被截断——关键约束要在任务里重述一遍。",
    "- 想让它只按任务文本干活，传 includeHistory: false。",
    "",
    "## 派活规范（任务文本必须包含）",
    "1. 目标：一句话说清要交付什么。",
    "2. 文件：相关文件绝对路径。派活前先 read/grep 摸清结构，把结论写进任务。",
    "3. 约束：构建/验证命令（npm run build、npx tsc）、禁止事项、风格要求。",
    "4. 验收：明确「做到什么算完成」。",
    "",
    "## 循环质检",
    "- 结果回来必须 review，并亲自跑构建/测试验证，不要直接采信。",
    "- 不满意就带着具体反馈再派一轮，写清上一轮哪里不对。",
    "",
    "## 变更与回退",
    "- 返回里有 `filesChanged`（新增/修改/删除的路径）和 `snapshotId`。汇报时把这些文件列出来，不要只说「改好了」。",
    "- 用户要撤销时，调用 `claude_code_revert` 并传 `snapshotId`。**先传 `dryRun: true`** 把清单给用户看，确认后再执行。",
    "- 纯只读任务可以传 `trackChanges: false`，省掉快照的扫描与备份开销。",
    "- 快照只覆盖 cwd 内、且未超出备份预算的文件；超大文件能报告但不能还原。",
    "",
    "## 多轮迭代（resume）",
    "- 调用返回的 sessionId 就是 Claude Code 的会话句柄。",
    "- 同一任务继续迭代时，把上次的 sessionId 作为 resume 参数传回，Claude Code 会记住它之前的上下文。",
    "- resume 失败（会话已被清理）时，去掉 resume 重新派。",
    "",
    "## 成本与延迟",
    "- 每次约 10 秒起步；实际计费取决于本机 claude 的配置（若 ANTHROPIC_BASE_URL 指向第三方中转，costUsd 数字不代表真实花费）。",
    "- 琐碎小问不派；一个「完整子任务」才派。",
    "",
    "## 省 token",
    "- **轮数是平方项**：worker 每轮都重发累积上下文。拆小任务比任何配置都有效。",
    "- 只读任务（审计、调研、查代码）把 `allowedTools` 设为 `[Read, Glob, Grep]`，同时传 `disallowedTools` 禁掉其余——实测固定开销从 11,993 降到 7,760（-35%）。",
    "- 写类任务禁掉用不到的 `WebFetch/WebSearch/NotebookEdit/Task/TodoWrite`，约省 11%。",
    "- 同一任务多轮迭代用 `resume`（worker 记得读过什么，不用重读）；**跨任务一定开新会话**。",
    "- 任务里直接给关键代码片段，比让 worker 自己去翻文件省得多。",
    "",
    "## 参数覆盖",
    "- cwd（工作目录）、model（sonnet/opus/haiku）、permissionMode（默认 acceptEdits）、maxTurns、effort（low/medium/high/xhigh/max）、maxThinkingTokens、resume、includeHistory。",
    "",
    "## 权限（重要）",
    "- 非交互模式下没有「询问用户」这一步：未被预授权的工具会被直接拒绝，而不是弹窗。",
    "- 默认 allowedTools 已预授权 shell（Bash/PowerShell）与读写检索工具，正常派活不需要动它。",
    "- 若任务报「requires approval」或反复重试到 maxTurns，说明需要的工具不在白名单里：把该工具名加进 allowedTools，或临时用 permissionMode=bypassPermissions（用该模式必须同时设 allowDangerouslySkipPermissions: true，风险自负）。",
  ].join("\n"),
};

/**
 * 「Claude 模式」技能。
 *
 * 输入框旁的开关会把 `/claude-mode ` 写进草稿，于是每一条消息都会带上这个技能。
 * 内容刻意写得短而硬：它会在每一轮被重复注入，长度直接计入成本。
 */
const CLAUDE_MODE_SKILL = {
  name: "claude-mode",
  description: "Claude 模式：本会话所有任务都交给 Claude Code 执行，leader 只负责派活与验收。",
  whenToUse: "用户在输入框旁开启了「Claude 模式」开关时自动带上，无需手动选择。",
  source: "runtime",
  content: [
    "# Claude 模式",
    "",
    "本会话已进入 Claude 模式：**任务交给 Claude Code 执行**，你不自己动手。",
    "",
    "## 规则",
    "- 不用 read / write / edit / glob / grep / bash 去完成任务本身。",
    "- 每个请求通过 `claude_code` 委派：目标、文件绝对路径、约束、验收标准写进 task。",
    "- 委派时传 `effort: \"low\"` 和 `includeHistory: false`，除非任务确实复杂（可提到 medium/high）。",
    "- 结果回来必须 review；不满意就带具体反馈再派，用上次 sessionId 作 resume。",
    "",
    "## 仍然自己做",
    "- 理解意图、澄清歧义（ask_user_question）",
    "- 把任务写清楚——这是你的主要工作",
    "- 验收产出",
    "",
    "## 拆小任务（重要）",
    "- 一次委派会独占整个回合：期间用户插话只能排队，直到它返回才能被处理。",
    "- 所以**不要把大任务整包派出去**。按阶段拆：先派「只读调研」，拿到结果汇报给用户，再派「实施」、再派「验证」。",
    "- 单次委派的目标是几分钟内返回；预计更久的，先拆。",
    "- 每段结果先向用户汇报，让用户有机会调整方向或打断。",
    "",
    "## 例外",
    "纯问答、闲聊、查资料这类不需要动文件或跑命令的，直接回答，不要委派——委派一次至少多花 5 秒和 12k tokens。",
    "用户说「这次你自己来」时按用户说的做，并提示这偏离了模式。",
  ].join("\n"),
};

/** 输入框开关写入草稿的前缀，必须与客户端 lib/client.js 里的常量一致。 */
const CLAUDE_MODE_PREFIX = "/claude-mode ";

/**
 * 构造传给 Claude Agent SDK 的 worker 环境变量。
 *
 * 不再透传整个 process.env：NODE_OPTIONS 可注入 --require 执行任意代码；
 * NODE_PATH / ELECTRON_RUN_AS_NODE 会改变 Node 行为；DSH 内部凭据也会原样泄露给 worker。
 * 改为显式白名单（Windows 环境变量名不区分大小写，统一按 toUpperCase() 比对）。
 *
 * 白名单分三类：
 * 1. BLOCKED_ENV —— 无论白名单怎么列都绝不透传的高危变量。
 * 2. KEEP_ENV —— Windows 上 spawn 子进程与认证必需的基础变量：
 *    - 命令解析/子进程创建：PATH、PATHEXT、ComSpec、SystemRoot、SystemDrive、windir
 *    - 用户与程序目录：TEMP、TMP、USERPROFILE、HOME、APPDATA、LOCALAPPDATA、
 *      ProgramData、ProgramFiles、ProgramFiles(x86)
 *    - 进程/用户/机器身份：NUMBER_OF_PROCESSORS、PROCESSOR_ARCHITECTURE、OS、
 *      USERNAME、USERDOMAIN、COMPUTERNAME
 * 3. 前缀放行：ANTHROPIC_* 与 CLAUDE_*（Claude Agent SDK 靠这些取凭据，缺了会认证失败）。
 *
 * extra 是插件自身的覆盖项（如 CLAUDE_AGENT_SDK_CLIENT_APP），永远在白名单之后合并，保证生效。
 * @param {object} extra 插件自身的额外 env 覆盖
 * @returns {object} 过滤后的 env
 */
function buildWorkerEnv(extra) {
  const BLOCKED_ENV = new Set([
    "NODE_OPTIONS",
    "NODE_PATH",
    "ELECTRON_RUN_AS_NODE",
    "ELECTRON_NO_ATTACH_CONSOLE",
    "__COMPAT_LAYER",
  ]);
  const KEEP_ENV = new Set([
    "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "COMSPEC",
    "TEMP", "TMP", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA",
    "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
    "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
    "USERNAME", "USERDOMAIN", "COMPUTERNAME",
  ]);
  const PREFIX_ALLOW = ["ANTHROPIC_", "CLAUDE_"];

  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (BLOCKED_ENV.has(upper)) continue;
    const prefixed = PREFIX_ALLOW.some((prefix) => upper.startsWith(prefix));
    if (!KEEP_ENV.has(upper) && !prefixed) continue;
    env[name] = value;
  }
  return { ...env, ...extra };
}

/**
 * 跑一次委派，收集文本、会话 id 与用量。
 * @param {string} task 任务文本
 * @param {object} opts SDK 选项
 * @returns {Promise<{output: string, sessionId: string, costUsd: number, inputTokens: number, outputTokens: number, toolsUsed: string[]}>}
 */
async function runClaude(task, opts) {
  let output = "";
  let sessionId = "";
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const toolsUsed = new Set();
  let error;

  if (opts.permissionMode === "bypassPermissions" && opts.allowDangerouslySkipPermissions !== true) {
    throw new Error(
      "permissionMode=bypassPermissions requires allowDangerouslySkipPermissions: true " +
        "(set it in the plugin config); refusing to bypass permissions implicitly.",
    );
  }

  // 内层超时：到点 abort 掉 SDK 子进程。取值优先级 config.timeoutMs → 代码默认 600000。
  const timeoutMs = opts.timeoutMs ?? 600000;
  const controller = new AbortController();
  const externalSignal = opts.abort && opts.abort.signal;
  const onExternalAbort = () => controller.abort(externalSignal && externalSignal.reason);

  const q = query({
    prompt: task,
    options: {
      cwd: opts.cwd,
      model: opts.model,
      permissionMode: opts.permissionMode,
      allowDangerouslySkipPermissions: opts.allowDangerouslySkipPermissions,
      maxTurns: opts.maxTurns,
      allowedTools: opts.allowedTools,
      // 空数组不传，避免把「什么都没禁」当成一次显式声明
      ...(Array.isArray(opts.disallowedTools) && opts.disallowedTools.length > 0
        ? { disallowedTools: opts.disallowedTools }
        : {}),
      pathToClaudeCodeExecutable: opts.pathToClaudeCodeExecutable,
      resume: opts.resume,
      effort: opts.effort,
      maxThinkingTokens: opts.maxThinkingTokens,
      abortController: controller,
      env: buildWorkerEnv({ CLAUDE_AGENT_SDK_CLIENT_APP: `dsh-claude-code-sdk/${PACKAGE_VERSION}` }),
    },
  });

  let timedOut = false;
  let timeoutId;
  try {
    // 合并外部信号（DSH 框架取消）与内层超时：任一触发都 abort 同一个 controller。
    if (externalSignal) {
      if (externalSignal.aborted) onExternalAbort();
      else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`claude_code timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    try {
      for await (const msg of q) {
        if (msg.type === "assistant") {
          sessionId = msg.session_id;
          if (msg.error) error = msg.error;
          for (const block of msg.message.content) {
            if (block.type === "text") output += block.text;
            else if (block.type === "tool_use") toolsUsed.add(block.name);
          }
        } else if (msg.type === "result") {
          sessionId = msg.session_id;
          if (msg.subtype === "success") {
            costUsd = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0;
            const usage = msg.usage;
            if (usage) {
              inputTokens = Number(usage.input_tokens ?? 0);
              outputTokens = Number(usage.output_tokens ?? 0);
            }
            if (!output.trim() && typeof msg.result === "string") output = msg.result;
          } else {
            const detail = msg.result ?? msg.error ?? msg.subtype;
            error = typeof detail === "string" ? detail : JSON.stringify(detail);
          }
        }
      }
    } catch (abortError) {
      // 超时 abort 会让消息流直接抛错（"Operation aborted"）。吞掉它，
      // 交给下面的 timedOut 分支给出可读提示；外部取消（用户点停止）不吞，原样抛出。
      if (!timedOut) throw abortError;
    }

    if (timedOut) {
      const trimmed = output.trim();
      const progress =
        trimmed.length > 0
          ? `超时前已产出 ${trimmed.length} 字符：${trimmed.slice(0, 200)}${trimmed.length > 200 ? "…" : ""}`
          : "超时前尚未产出任何正文";
      throw new Error(
        `claude_code 超时：超过 ${timeoutMs} ms 未完成，已中止 SDK 子进程。${progress}。可用 timeoutMs 配置调大；若卡在某个工具或命令，用 cwd / maxTurns 定位卡点。`,
      );
    }
    if (error) throw new Error("claude_code failed: " + error);
    if (!output.trim()) throw new Error("claude_code returned no output");
    return {
      output: output.trim(),
      sessionId,
      costUsd,
      inputTokens,
      outputTokens,
      toolsUsed: [...toolsUsed],
    };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (externalSignal && typeof externalSignal.removeEventListener === "function") {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

/**
 * 从工具执行上下文取当前会话的工作区目录。
 *
 * 依据：@deepseek-ai/dsh-tools/lib/index.js:1423
 *   `...exec.agent?.session.header.cwd !== void 0 ? { cwd: exec.agent.session.header.cwd } : {}`
 * 以及 @deepseek-ai/dsh-agent-instructions/lib/index.js:1122
 *   `const cwd = agent.session.header.cwd ?? process.cwd();`
 *
 * 会话 header 的 cwd 可能缺失（例如 subagent 会话），此时返回 undefined，由调用方降级到 process.cwd()。
 * @param {object} exec 工具执行上下文
 * @returns {string|undefined} 会话工作区路径，或 undefined
 */
function sessionWorkspaceCwd(exec) {
  try {
    const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
      ? exec.agent.session.header.cwd
      : undefined;
    return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 从当前 DSH 会话里取模型可见的消息历史。
 *
 * 通路：exec.agent.session（活 Session）→ deriveMessages()（与发给模型的完全一致）。
 * 只读、纯派生，不修改会话。取不到就返回 undefined，绝不因为读历史而让委派失败。
 *
 * @param {object} exec 工具执行上下文
 * @returns {Array|undefined} 消息数组，或 undefined
 */
function readSessionMessages(exec) {
  try {
    const session = exec && exec.agent ? exec.agent.session : undefined;
    if (!session || typeof session.deriveMessages !== "function") return undefined;
    const messages = session.deriveMessages();
    return Array.isArray(messages) ? messages : undefined;
  } catch {
    return undefined;
  }
}

/** 只取正文文本块；reasoning / tool-call / tool-addition 等一律忽略。 */
function blockText(block) {
  if (!block || typeof block !== "object") return "";
  if (block.type === "text" && typeof block.text === "string") return block.text;
  return "";
}

/**
 * 把消息历史格式化成一段可读的 transcript。
 *
 * 只保留 user / assistant 的正文文本：system 是 DSH 自己的系统提示（又长又无关），
 * developer 是工具注册变更（纯噪音），tool 是工具结果（体量大且通常无用）。
 *
 * @param {Array} messages deriveMessages() 的结果
 * @param {object} config 部署配置
 * @returns {string} 空字符串表示没有可用历史
 */
export function formatHistory(messages, config) {
  if (!Array.isArray(messages) || messages.length === 0) return "";

  const rows = [];
  for (const message of messages) {
    const role = message && message.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content.map(blockText).filter((part) => part.trim().length > 0).join("\n").trim();
    if (text.length === 0) continue;
    rows.push({ role, text });
  }

  // 最后一条 assistant 通常就是"决定调用 claude_code"那一条，对 worker 没有价值
  while (rows.length > 0 && rows[rows.length - 1].role === "assistant") rows.pop();
  if (rows.length === 0) return "";

  // 先按条数截断（取最近的），再按字符预算从新到旧累加
  const recent = rows.slice(-Math.max(1, config.historyMaxMessages));
  const budget = Math.max(500, config.historyMaxChars);
  const kept = [];
  let used = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const row = recent[i];
    const cost = row.text.length;
    if (used + cost > budget) {
      if (kept.length === 0) {
        // 单条就超预算：截断后保留，避免整段历史为空
        kept.unshift({ role: row.role, text: row.text.slice(0, budget) + "\n…（已截断）" });
      }
      break;
    }
    kept.unshift(row);
    used += cost;
  }
  if (kept.length === 0) return "";

  const dropped = rows.length - kept.length;
  const lines = [
    "# DSH 会话历史（背景上下文）",
    "",
    "以下是本次 DSH 对话此前的记录，供你理解背景、用户偏好和已经做过的决定。",
    "这不是你要执行的任务；你的实际任务在最后。",
    "",
  ];
  if (dropped > 0) lines.push(`（更早的 ${dropped} 条消息已省略）`, "");

  for (const row of kept) {
    lines.push(row.role === "user" ? "【用户】" : "【助手】", row.text, "");
  }

  return lines.join("\n").trim();
}

/**
 * 把历史与任务拼成最终 prompt。
 * @param {string} task 原始任务
 * @param {string} history 已格式化的历史（可为空）
 * @returns {string} 最终 prompt
 */
export function composePrompt(task, history) {
  if (!history) return task;
  return [history, "", "---", "", "# 当前任务", "", task].join("\n");
}

/**
 * 注册委派技能与 claude_code 工具。
 * @param {object} ctx Cordis 上下文（需 tools、skills 服务）
 * @param {object} config 部署配置
 */
export function apply(ctx, config) {
  ctx.skills.register(DELEGATION_SKILL);
  ctx.skills.register(CLAUDE_MODE_SKILL);

  ctx.tools.register(
    defineTool({
      name: "claude_code",
      description:
        "Delegate one self-contained coding task to your local Claude Code and return its final result text. " +
        "Use it for a well-scoped subtask that benefits from Claude Code's own agent loop and tools; give it " +
        "everything it needs (goal, files, constraints) in the task string. To continue a previous delegation " +
        "with its remembered context, pass the sessionId you received earlier as resume. Override the Claude " +
        "model (model) and thinking effort (effort: low/medium/high/xhigh/max) per call. " +
        "This is a slow, expensive call; prefer it only when the work is genuinely self-contained. " +
        "The current DSH conversation history (user/assistant text) is prepended automatically unless includeHistory is false.",
      parameters: {
        task: {
          type: "string",
          description: "Complete, self-contained task description for Claude Code (goal, context, files, constraints).",
          required: true,
        },
        cwd: { type: "string", description: "Working directory for Claude Code; defaults to the configured value or DSH cwd." },
        model: { type: "string", description: "Override the Claude model alias/id for this call." },
        permissionMode: {
          type: "string",
          enum: [...PERMISSION_MODES],
          description: "Override Claude Code permission mode for this call (acceptEdits is the default).",
        },
        maxTurns: { type: "integer", description: "Override the maximum number of Claude Code agentic turns for this call." },
        allowedTools: {
          type: "array",
          items: { type: "string" },
          description: "Override the Claude Code built-in tools to allow (e.g. Read, Edit, Bash, Grep, Glob).",
        },
        disallowedTools: {
          type: "array",
          items: { type: "string" },
          description:
            "Tools to remove from the worker for this call. Removing tools is the only way to shrink the worker's system prompt. For read-only work pass Read, Glob, Grep as allowedTools and disallow the rest.",
        },
        resume: {
          type: "string",
          description:
            "sessionId returned by an earlier claude_code call; resume that Claude Code session so it remembers its previous work. Omit for a fresh session.",
        },
        effort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh", "max"],
          description: "Override Claude Code thinking effort for this call (high is the default).",
        },
        maxThinkingTokens: { type: "integer", description: "Override the thinking token budget for this call." },
        includeHistory: {
          type: "boolean",
          description:
            "Whether to prepend the current DSH conversation history (user/assistant text only) to the task. Defaults to the configured value (true).",
        },
        trackChanges: {
          type: "boolean",
          description:
            "Whether to snapshot the workspace and report which files changed. Defaults to the configured value (true). Turn off for read-only or very large workspaces.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            output: { type: "string", required: true },
            sessionId: { type: "string", required: true },
            costUsd: { type: "number", required: true },
            inputTokens: { type: "integer", required: true },
            outputTokens: { type: "integer", required: true },
            toolsUsed: { type: "array", required: true, items: { type: "string" } },
            snapshotId: { type: "string", required: true },
            filesChanged: { type: "array", required: true, items: { type: "string" } },
            added: { type: "integer", required: true },
            modified: { type: "integer", required: true },
            removed: { type: "integer", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.output }],
      },
      timeoutMs: config.timeoutMs,
      async execute(args, exec) {
        const abort = new AbortController();
        const onAbort = () => abort.abort();
        const signal = exec && exec.signal;
        if (signal && typeof signal.addEventListener === "function") {
          signal.addEventListener("abort", onAbort, { once: true });
        }
        try {
          const withHistory = args.includeHistory ?? config.includeHistory;
          const history = withHistory ? formatHistory(readSessionMessages(exec), config) : "";
          const sessionCwd = sessionWorkspaceCwd(exec);
          const cwd = args.cwd ?? config.cwd ?? sessionCwd ?? process.cwd();
          const cwdFallbackWarning =
            args.cwd === undefined && config.cwd === undefined && sessionCwd === undefined
              ? `cwd 未指定且未能从会话上下文取到工作区，已回退到 ${cwd}；建议显式传 cwd。\n\n`
              : "";

          // 委派前拍快照：既用于事后报告改了哪些文件，也用于 claude_code_revert 还原。
          // 任何一步失败都静默降级，不影响委派本身。
          const tracking = args.trackChanges ?? config.trackChanges;
          let snapshot;
          let trackingNote = "";
          if (tracking) {
            try {
              const created = createSnapshot(cwd, {
                maxFileSize: config.maxTrackedFileSize,
                maxTotalBytes: config.maxTrackedTotalBytes,
                maxFiles: config.maxTrackedFiles,
                maxMs: config.maxTrackedMs,
              });
              if (created.skipped) {
                trackingNote = `\n---\n未追踪改动：${created.reason}。可调大 maxTrackedFiles / maxTrackedMs，或传 trackChanges: false 跳过。`;
              } else {
                snapshot = created;
                pruneSnapshots(config.keepSnapshots);
              }
            } catch {
              snapshot = undefined;
            }
          }

          const collect = () => {
            if (snapshot === undefined) return { diff: { added: [], modified: [], removed: [] }, summary: "" };
            try {
              const after = scanWorkspace(cwd, {});
              const diff = diffScans(snapshot.scan.files, after.files);
              return { diff, summary: formatChangeSummary(diff, snapshot) };
            } catch {
              return { diff: { added: [], modified: [], removed: [] }, summary: "" };
            }
          };

          let outcome;
          try {
            outcome = await runClaude(composePrompt(args.task, history), {
              cwd,
              model: args.model ?? config.model,
              permissionMode: args.permissionMode ?? config.permissionMode,
              allowDangerouslySkipPermissions: config.allowDangerouslySkipPermissions,
              maxTurns: args.maxTurns ?? config.maxTurns,
              allowedTools: args.allowedTools ?? config.allowedTools,
              disallowedTools: args.disallowedTools ?? config.disallowedTools,
              pathToClaudeCodeExecutable: config.pathToClaudeCodeExecutable,
              resume: args.resume,
              effort: args.effort ?? config.effort,
              maxThinkingTokens: args.maxThinkingTokens ?? config.maxThinkingTokens,
              timeoutMs: config.timeoutMs,
              abort,
            });
          } catch (error) {
            // 失败时也要告诉调用方 worker 动过哪些文件——半途而废的改动最需要知道。
            const failed = collect();
            if (failed.summary) error.message += `\n${failed.summary}`;
            throw error;
          }

          const { diff, summary } = collect();
          const filesChanged = [...diff.added, ...diff.modified, ...diff.removed];
          return {
            ok: true,
            output: cwdFallbackWarning + outcome.output + summary + trackingNote,
            sessionId: outcome.sessionId,
            costUsd: outcome.costUsd,
            inputTokens: outcome.inputTokens,
            outputTokens: outcome.outputTokens,
            toolsUsed: outcome.toolsUsed,
            snapshotId: snapshot === undefined ? "" : snapshot.id,
            filesChanged,
            added: diff.added.length,
            modified: diff.modified.length,
            removed: diff.removed.length,
          };
        } finally {
          if (signal && typeof signal.removeEventListener === "function") {
            signal.removeEventListener("abort", onAbort);
          }
        }
      },
      presentCall: (args) => ({
        card: "generic",
        title: "Claude Code",
        kind: "other",
        rawInput: { task: typeof args.task === "string" ? args.task.slice(0, 200) : args.task },
      }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "claude_code_revert",
      description:
        "Revert the workspace to the state captured by a previous claude_code call. Restores files that were modified or deleted, and deletes files that the worker created after that snapshot. Only paths recorded in the snapshot are touched, and nothing outside the snapshot root is modified. Use dryRun first to see what would change.",
      parameters: {
        snapshotId: {
          type: "string",
          required: true,
          description: "The snapshotId returned by the claude_code call you want to undo.",
        },
        dryRun: {
          type: "boolean",
          description: "When true, only report what would be restored or deleted, without touching any file.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            output: { type: "string", required: true },
            restored: { type: "integer", required: true },
            deleted: { type: "integer", required: true },
            skipped: { type: "integer", required: true },
            failed: { type: "integer", required: true },
            files: { type: "array", required: true, items: { type: "string" } },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.output }],
      },
      async execute(args) {
        const result = restoreSnapshot(args.snapshotId, { dryRun: args.dryRun === true });
        const touched = [...result.restored, ...result.deleted];
        const lines = [];
        if (result.dryRun) {
          lines.push(`预演（未改动任何文件）：将还原 ${result.restored.length} 个、删除 ${result.deleted.length} 个`);
        } else {
          lines.push(`已还原 ${result.restored.length} 个文件，删除 ${result.deleted.length} 个新增文件`);
        }
        if (result.skipped.length > 0) lines.push(`跳过 ${result.skipped.length} 个（快照里没有备份内容，通常是超出备份预算的大文件）`);
        if (result.deletionSkipped) lines.push("工作区过大、扫描被截断，本次只还原不删除新文件（避免误删未扫到的文件）");
        if (result.failed.length > 0) {
          lines.push(`失败 ${result.failed.length} 个：`);
          for (const item of result.failed.slice(0, 8)) lines.push(`  - ${item.path}：${item.error}`);
        }
        const shown = touched.slice(0, 20);
        if (shown.length > 0) lines.push("", ...shown.map((p) => `  ${p}`));
        if (touched.length > shown.length) lines.push(`  …另有 ${touched.length - shown.length} 个`);

        return {
          ok: result.failed.length === 0,
          output: lines.join("\n"),
          restored: result.restored.length,
          deleted: result.deleted.length,
          skipped: result.skipped.length,
          failed: result.failed.length,
          files: touched,
        };
      },
      presentCall: (args) => ({
        card: "generic",
        title: "Claude Code 回退",
        kind: "other",
        rawInput: { snapshotId: args.snapshotId, dryRun: args.dryRun === true },
      }),
    }),
  );
}
