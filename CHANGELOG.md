# Changelog

## 0.2.0

- Adds **Claude Mode**: a toggle in the composer (`conversation.input.right` slot, next to
  the model selector). Turning it on writes `/claude-mode ` into the draft, so every
  subsequent message carries the `claude-mode` skill and the model delegates everything to
  `claude_code`. Turning it off strips the prefix. State is per session and persisted in
  `localStorage`.
- Adds the `claude-mode` skill: instructs the leader to delegate every task, not to use
  read/write/edit/bash itself, and to keep only intent clarification and review.
- Ships a web client entry (`dsh.client`, `exports["./client"]`).
- Adds `@deepseek-ai/cordis` to `peerDependencies`.

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
