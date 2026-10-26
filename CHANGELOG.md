# Changelog

## 0.4.2

Cheaper history injection.

- **Fix: DSH internal messages were being injected as user speech.** DSH marks
  `runtime-context` snapshots, `skill-catalog` and `skill-invocation` messages with
  `role: "user"`, so they were forwarded to the worker as if the user had said them.
  Measured on a real session: **9,561 → 5,808 characters (4,675 → 2,840 tokens, −39%)**
  once filtered by `source.kind` to `user` / `model` only.
- **New `context` parameter.** The leader writes its own background summary and it replaces
  the auto-injected history. Since the leader already holds the conversation, summarising
  costs output tokens only — no extra read. Injected text is re-read on every worker turn,
  so a 10-turn delegation drops from ~28,400 to ~2,800 tokens on this component.
- Skill documents when to prefer a summary (long conversations, partial relevance) and when
  not to (tasks that depend on exact wording, original error text, or large code blocks).

## 0.4.1

Worker-side token savings.

- **New `disallowedTools` config and per-call parameter.** This is the only lever that actually
  shrinks the worker's system prompt — `allowedTools` merely pre-approves. Measured with the
  read-only set (Write / Edit / Bash / shell / WebFetch / WebSearch / NotebookEdit / Task /
  TodoWrite removed): **11,993 → 7,760 input tokens (−35.3%)**, with `Read` still working.
- Measured the write-task case too: removing only the tools a write task never uses
  (WebFetch / WebSearch / NotebookEdit / Task / TodoWrite) saves **−10.9%**.
- Skill now documents the four worker-side levers in order of impact: split tasks (the only
  quadratic term), disallow tools for read-only work, disallow unused tools for write work,
  and use `resume` for iterations while starting a fresh session across tasks.
- Note: `model: "haiku"` saves money, not tokens; `effort` affects latency and output only.

## 0.4.0

Change tracking and revert.

- **Workspace snapshots.** Before a delegation the plugin records every file's
  `size` + `mtime` and backs up its content (budgeted). After the delegation it rescans and
  reports `filesChanged` / `added` / `modified` / `removed`, and appends a readable summary
  to the returned text. Failures mid-delegation also report what was already touched.
- **New tool `claude_code_revert`.** Restores the workspace to a snapshot: rewrites modified
  or deleted files and removes files the worker created. Supports `dryRun` for a preview.
  Only paths recorded in the snapshot are touched, every path is re-checked to stay inside
  the snapshot root, and files are never removed recursively.
- **Why this matters here:** `dsh-rewind-plugin` hooks DSH's own `write`/`edit` tools, so
  files the worker changes inside Claude Code are invisible to it. Verified on this machine:
  `~/.dsh/rewind-snapshots/` had no snapshot newer than 10-16 despite heavy delegation.
- New config: `trackChanges` (default `true`), `maxTrackedFileSize` (512 KiB),
  `maxTrackedTotalBytes` (64 MiB), `maxTrackedFiles` (8000), `maxTrackedMs` (1000),
  `keepSnapshots` (20). New per-call parameter `trackChanges`.
- **Scan budget.** A tree that exceeds the file or time budget is left **untracked** rather
  than producing a partial diff (two differently-truncated scans would invent added/removed
  files). Measured: 12 files ≈ 6 ms scan, 175 files ≈ 34 ms, a 20 000-file tree bails at
  ~0.9 s instead of scanning for 3.5 s.
- **Revert refuses to delete on a truncated scan** — only restores, and says so, so files it
  could not enumerate are never removed.
- Snapshot scanning skips `node_modules`, `.git`, build output and other non-source
  directories.
- `allowedTools` still only pre-approves. Narrowing it does **not** shrink the system
  prompt — use the SDK's `disallowedTools` for that (measured −35% on a single call).

## 0.3.0

Security and reliability hardening.

- **Worker environment allowlist.** The SDK subprocess no longer inherits `process.env`
  wholesale. `NODE_OPTIONS` (arbitrary `--require` injection), `NODE_PATH`,
  `ELECTRON_RUN_AS_NODE`, `ELECTRON_NO_ATTACH_CONSOLE` and `__COMPAT_LAYER` are always
  dropped; only Windows essentials plus `ANTHROPIC_*` / `CLAUDE_*` are kept, so DSH's own
  credentials no longer leak into the worker. Note: `HTTP_PROXY` / `HTTPS_PROXY` /
  `NODE_EXTRA_CA_CERTS` are not inherited either — the worker connects directly, which is
  correct for a local Claude Code install talking to its configured endpoint.
- **`allowDangerouslySkipPermissions` config (default `false`).** `permissionMode:
  "bypassPermissions"` is refused unless this is explicitly `true`, matching the SDK's own
  requirement. Prevents bypassing permissions by accident.
- **Inner timeout with subprocess abort.** A `timeoutMs` timer aborts the SDK child process,
  merged with the DSH cancellation signal. The error reports how much output was produced
  before the abort.
- **`cwd` falls back to the session workspace.** Order is now
  `args.cwd → config.cwd → exec.agent.session.header.cwd → process.cwd()`, and a warning is
  prepended to the result when it had to fall back to the process directory.
- **Version is read from `package.json`** instead of being hardcoded in the
  `CLAUDE_AGENT_SDK_CLIENT_APP` identifier.
- Fix: the timeout message was unreachable. Aborting makes the SDK message stream throw
  `Operation aborted`, which escaped before the `timedOut` branch could run. The abort error
  is now swallowed when the abort came from the timeout, so the readable message surfaces.

## 0.2.0

- Adds **Claude Mode**: a toggle in the composer (`conversation.input.right` slot, next to
  the model selector). Turning it on writes `/claude-mode ` into the draft, so every
  subsequent message carries the `claude-mode` skill and the model delegates tasks to
  `claude_code`. Turning it off strips the prefix. State is per session and persisted in
  `localStorage`.
- Adds the `claude-mode` skill: instructs the leader to delegate tasks, not to use
  read/write/edit/bash itself, to split large work into staged delegations, and to keep
  only intent clarification and review.
- Ships a web client entry (`dsh.client`, `exports["./client"]`).
- Adds `@deepseek-ai/cordis` to `peerDependencies`.
- Bounds defaults: `maxTurns` 100 → 40, `timeoutMs` 600000 → 300000.

## 0.1.0

Initial release.

- Registers the `claude_code` tool and the `claude-code-delegation` skill.
- Runs Claude Code through `@anthropic-ai/claude-agent-sdk`'s `query()`, so the
  tool returns structured output: final text, `sessionId`, token counts, and the
  list of tools the worker actually used.
- Ships a default `allowedTools` allowlist that includes `Bash` and `PowerShell`.
  Without pre-approval, `acceptEdits` denies every shell command in
  non-interactive mode and the worker can only edit files.
- Injects the current DSH conversation history (user and assistant text only)
  into the delegated task. Controlled by `includeHistory`,
  `historyMaxMessages`, and `historyMaxChars`; switchable per call.
- Targets DSH 0.2.x (`@deepseek-ai/dsh-tools >=0.2.0-rc.2 <0.3.0-0`).
