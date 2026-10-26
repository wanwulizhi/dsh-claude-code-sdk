# Changelog

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
