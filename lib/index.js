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
  maxTurns: z.number().description("Maximum Claude Code agentic turns per task.").default(100),
  timeoutMs: z.number().description("Cooperative timeout budget for one call (ms).").default(600000),
  cwd: z.string().description("Working directory for Claude Code; defaults to the DSH workspace cwd."),
  allowedTools: z
    .array(z.string())
    .description("Claude Code built-in tools to pre-approve (allowlist, not a restriction). Empty array = no pre-approval.")
    .default([...DEFAULT_ALLOWED_TOOLS]),
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
    "## 多轮迭代（resume）",
    "- 调用返回的 sessionId 就是 Claude Code 的会话句柄。",
    "- 同一任务继续迭代时，把上次的 sessionId 作为 resume 参数传回，Claude Code 会记住它之前的上下文。",
    "- resume 失败（会话已被清理）时，去掉 resume 重新派。",
    "",
    "## 成本与延迟",
    "- 每次约 10 秒起步；实际计费取决于本机 claude 的配置（若 ANTHROPIC_BASE_URL 指向第三方中转，costUsd 数字不代表真实花费）。",
    "- 琐碎小问不派；一个「完整子任务」才派。",
    "",
    "## 参数覆盖",
    "- cwd（工作目录）、model（sonnet/opus/haiku）、permissionMode（默认 acceptEdits）、maxTurns、effort（low/medium/high/xhigh/max）、maxThinkingTokens、resume、includeHistory。",
    "",
    "## 权限（重要）",
    "- 非交互模式下没有「询问用户」这一步：未被预授权的工具会被直接拒绝，而不是弹窗。",
    "- 默认 allowedTools 已预授权 shell（Bash/PowerShell）与读写检索工具，正常派活不需要动它。",
    "- 若任务报「requires approval」或反复重试到 maxTurns，说明需要的工具不在白名单里：把该工具名加进 allowedTools，或临时用 permissionMode=bypassPermissions。",
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
    "本会话已进入 Claude 模式。用户开启这个模式的意思是：**所有任务都交给 Claude Code 执行**，你不要自己动手。",
    "",
    "## 硬性规则",
    "- 不要用 read / write / edit / glob / grep / bash 等工具去完成任务本身。",
    "- 每一个用户请求都通过 `claude_code` 委派：把目标、文件绝对路径、约束、验收标准写进 task。",
    "- 委派结果回来必须 review；不满意就带具体反馈再派一轮，用上次的 sessionId 作为 resume。",
    "",
    "## 仍然由你负责的事",
    "- 理解意图、澄清歧义（必要时用 ask_user_question）",
    "- 把任务描述写清楚——这是你的主要工作",
    "- 验收 worker 的产出是否符合标准",
    "",
    "## 例外",
    "用户明确说「这次你自己来」时按用户说的做，并提示这偏离了 Claude 模式。",
  ].join("\n"),
};

/** 输入框开关写入草稿的前缀，必须与客户端 lib/client.js 里的常量一致。 */
const CLAUDE_MODE_PREFIX = "/claude-mode ";

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

  const q = query({
    prompt: task,
    options: {
      cwd: opts.cwd,
      model: opts.model,
      permissionMode: opts.permissionMode,
      maxTurns: opts.maxTurns,
      allowedTools: opts.allowedTools,
      pathToClaudeCodeExecutable: opts.pathToClaudeCodeExecutable,
      resume: opts.resume,
      effort: opts.effort,
      maxThinkingTokens: opts.maxThinkingTokens,
      abortController: opts.abort,
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "dsh-claude-code-local/0.1.0" },
    },
  });

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
          const outcome = await runClaude(composePrompt(args.task, history), {
            cwd: args.cwd ?? config.cwd ?? process.cwd(),
            model: args.model ?? config.model,
            permissionMode: args.permissionMode ?? config.permissionMode,
            maxTurns: args.maxTurns ?? config.maxTurns,
            allowedTools: args.allowedTools ?? config.allowedTools,
            pathToClaudeCodeExecutable: config.pathToClaudeCodeExecutable,
            resume: args.resume,
            effort: args.effort ?? config.effort,
            maxThinkingTokens: args.maxThinkingTokens ?? config.maxThinkingTokens,
            abort,
          });
          return {
            ok: true,
            output: outcome.output,
            sessionId: outcome.sessionId,
            costUsd: outcome.costUsd,
            inputTokens: outcome.inputTokens,
            outputTokens: outcome.outputTokens,
            toolsUsed: outcome.toolsUsed,
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
}
