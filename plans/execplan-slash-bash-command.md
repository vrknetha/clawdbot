# Add independent `/bash` chat slash command (execute shell)

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

There is no `PLANS.md` checked into this repository. This document follows the ExecPlan requirements embedded in the task prompt and must remain fully self-contained.

## Purpose / Big Picture

Clawdbot already supports chat slash commands such as `/model`, `/verbose`, and `/status` (both as plain text commands and as “native” commands on connectors like Slack/Discord/Telegram). After this change, a trusted user can run a shell command directly from chat by sending a standalone message like `/bash brew install <pkg>`.

This `/bash` feature must be independent of the AI agent run. In plain terms:

1. `/bash ...` runs a shell command without involving the LLM at all (similar “command-only” behavior to `/status`).
2. `/bash` commands must not abort or interfere with an in-flight agent run (i.e., do not do what `/stop` does).
3. For long-running commands, `/bash` must return quickly (start the command in the background) and provide a way to stop and inspect that background job via chat commands that affect only `/bash` jobs.

The change is observable by enabling `commands.bash: true` in config and sending `/bash echo hello` in a chat. If the command finishes quickly, Clawdbot replies with the output immediately. If it does not finish quickly, Clawdbot replies with an acknowledgement that includes a `sessionId`, and `/bash poll` returns the output once it is ready.

For simplicity and safety, `/bash` supports only one running bash job at a time for the entire gateway process (global, across all chats). If a `/bash` job is already running anywhere, a new `/bash <cmd>` must not start; instead it returns a short “already running” message that points the user to `/bash poll` and `/bash stop`.

For usability, fast commands should not force a polling workflow. `/bash` should attempt to run commands in the foreground for a short, configurable window; if the command exceeds that window, it continues in the background and the user uses `/bash poll`.

## Progress

- [x] (2026-01-11) Update ExecPlan for “independent /bash” requirement and global one-at-a-time semantics (completed: clarified raw parsing, global job locking, and docs/test touch-points; remaining: keep updated as implementation proceeds).
- [ ] (2026-01-11) Add config gate `commands.bash` (completed: none; remaining: types, zod schema, schema descriptions, docs examples).
- [ ] (2026-01-11) Add `commands.bashForegroundMs` (completed: none; remaining: types, zod schema, schema descriptions, docs).
- [ ] (2026-01-11) Register `/bash` in command registry (completed: none; remaining: `src/auto-reply/commands-registry.ts` + docs list).
- [ ] (2026-01-11) Implement `/bash` runner + job tracking (completed: none; remaining: enforce global lock, start foreground/background job, clear lock on completion, format replies, decide host/sandbox behavior).
- [ ] (2026-01-11) Implement `/bash poll` + `/bash stop` (bash-only) (completed: none; remaining: poll output/tail, stop most recent job, optional explicit `sessionId`).
- [ ] (2026-01-11) Add/adjust tests and docs (completed: none; remaining: unit tests + `docs/tools/slash-commands.md` + `docs/gateway/configuration.md`).
- [ ] (2026-01-11) Validate with `pnpm test` (completed: none; remaining: run tests, fix failures).

## Surprises & Discoveries

- Observation: Chat command detection uses a lowercased “normalized trigger body” derived from `ctx.CommandBody ?? ctx.RawBody ?? ctx.Body`, so it is not safe to reuse `command.commandBodyNormalized` to build a bash command string (it will lose case and can mangle arguments).
  Evidence (from `src/auto-reply/reply/session.ts`): `const triggerBodyNormalized = stripStructuralPrefixes(commandSource).trim().toLowerCase();`

- Observation: Inline directive parsing happens before command handling, and it can strip directive-like substrings from the message before the agent sees it. `/bash` must parse the raw message (`ctx.CommandBody` / `ctx.RawBody`) to avoid accidentally stripping parts of the intended shell command.
  Evidence (from `src/auto-reply/reply.ts`): directives are parsed from `commandSource = sessionCtx.CommandBody ?? sessionCtx.RawBody ?? ...` and the cleaned text is written back to `sessionCtx.Body` / `sessionCtx.BodyStripped` before `handleCommands(...)` is called.

## Decision Log

- Decision: Gate `/bash` behind `commands.bash: true` (default off).
  Rationale: Executing shell commands from a chat surface materially increases risk; a hard opt-in keeps the default secure.
  Date/Author: 2026-01-11 / Codex

- Decision: `/bash stop` must not alias to `/stop`; it must only stop `/bash`-started jobs.
  Rationale: `/stop` aborts the entire agent run (LLM + tools). The requirement is that `/bash` commands do not interfere with agent execution.
  Date/Author: 2026-01-11 / Codex

- Decision: Enforce “only one running `/bash` job at a time” globally (across the gateway process, not per chat).
  Rationale: Keeps the chat UX predictable for long-running jobs without requiring users to manage multiple concurrent shell sessions in multiple chats. The user explicitly requested the simplest possible model: reject new `/bash <cmd>` while one is already running.
  Date/Author: 2026-01-11 / Codex

- Decision: Add `commands.bashForegroundMs` to control how long `/bash` waits before switching to background mode.
  Rationale: Avoids requiring `/bash poll` for quick commands (e.g. `ls`) while still keeping long-running commands responsive.
  Date/Author: 2026-01-11 / Codex

- Decision: `/bash` runs on the host (elevated) only, and requires the existing `tools.elevated` allowlist gates in addition to `commands.bash`.
  Rationale: A chat-triggered remote shell is inherently high-risk. Reusing the existing elevated allowlist gates ensures `/bash` is explicitly opt-in and tied to per-provider sender allowlists. This also matches the motivating use case (`brew install ...`) which only makes sense on the host.
  Date/Author: 2026-01-11 / Codex

- Decision: `/bash` does not send unsolicited “completed” messages; completion is observed via `/bash poll`.
  Rationale: The gateway currently has no reliable cross-provider background-job notification channel; adding one would be a larger feature. Polling keeps the implementation small and predictable.
  Date/Author: 2026-01-11 / Codex

## Outcomes & Retrospective

(Fill in at completion.)

## Context and Orientation

Clawdbot processes incoming messages through the “auto-reply” pipeline and intercepts slash commands before the model runs.

Relevant modules:

- `src/auto-reply/commands-registry.ts`: Source of truth for supported chat commands and aliases (text + native). Also powers docs/tests via `listChatCommands()`.
- `src/auto-reply/reply/commands.ts`: Handles “imperative” commands that produce immediate replies (`/help`, `/commands`, `/status`, `/config`, `/debug`, `/stop`, `/restart`, `/compact`, etc.).
- `src/auto-reply/reply.ts`: Top-level reply pipeline. Parses inline directives (`/think`, `/verbose`, `/elevated`, etc.), enforces elevated gating, and routes command-only messages into `handleCommands(...)`.
- `src/agents/bash-tools.ts`: Implements the `bash` tool (used by the agent tool system) with sandbox and elevated semantics.
- `src/agents/sandbox.ts`: Resolves per-session sandbox contexts (Docker container + workspace mapping) when sandboxing is enabled.
- `docs/tools/slash-commands.md`: User-facing docs listing slash commands and their config.
- `docs/gateway/configuration.md`: User-facing docs describing config keys (including `commands.*`).

Definitions:

- “Text slash command”: a standalone chat message beginning with `/...` that the gateway parses and handles before sending anything to the model.
- “Native command”: a connector-native slash command (Slack/Discord/Telegram) that the connector translates into a prompt like `/status` and routes through the same gateway command handling.
- “Sandbox”: a Docker container + isolated workspace used for tool execution when configured via `agents.defaults.sandbox`. “Elevated” is an escape hatch that runs bash on the host (when allowed by `tools.elevated.*`).
- “Active `/bash` job”: the single backgrounded shell session started by `/bash <cmd>` that is still running. While an active `/bash` job exists, any new `/bash <cmd>` must be rejected with “already running”.

## Plan of Work

This change is deliberately minimal and piggybacks on existing, battle-tested command and bash execution code. The key design goal is “independent `/bash`”: it must be handled as a command-only action and it must not stop or abort the AI agent run.

1. Add new config keys to the config types and Zod schema, and document them in the schema description map. Update docs examples that show the `commands` object.

   Required keys:
   - `commands.bash` (boolean, default false): enables the `/bash` chat command.
   - `commands.bashForegroundMs` (number, default 2000): how long to wait (ms) for a `/bash` command to complete before returning “still running” and requiring `/bash poll`.

   Notes for implementers:
   - Clamp to a reasonable range (e.g. 0–30_000 ms). `0` means always background immediately.
   - This key is specific to the chat command; it should not silently change the model tool’s behavior unless explicitly intended.
2. Register a new chat command in `src/auto-reply/commands-registry.ts`:
   - Key: `bash`
   - Text alias: `/bash`
   - Native name: `bash` (so it can be registered when `commands.native: true`)
   - Accepts args: yes
   - Disabled by default via `commands.bash` gating (do not show in `/commands` unless enabled).
3. Implement `/bash` handling in `src/auto-reply/reply/commands.ts` as a command-only action:
   - Require `command.isAuthorizedSender`.
   - Require `cfg.commands?.bash === true`.
   - Do not call `abortEmbeddedPiRun(...)` and do not mutate any model/thinking/verbose session state.
   - Parse the shell command string from the raw inbound message (`ctx.CommandBody ?? ctx.RawBody ?? ctx.Body`) so argument case and directive-like substrings are preserved.
   - Start the command and wait up to `commands.bashForegroundMs` for it to finish:
     - If it finishes within the window: reply immediately with exit code + output (no poll needed).
     - If it is still running after the window: mark it backgrounded and reply with an acknowledgement that includes a `sessionId`, telling the user to run `/bash poll`.
   - Enforce “one running job at a time” globally. If any `/bash` job is already running, reject new `/bash <cmd>` with an “already running” message that includes the running `sessionId` and hints `/bash poll` and `/bash stop`.

   Because this is global and must not deadlock after completion, the implementation must ensure the “active job” lock clears when the backgrounded process exits. The simplest reliable pattern is to attach a `child.once("close", ...)` listener (or equivalent) after the job is started/backgrounded and clear the global active session id on completion. Race handling is required (the job might exit before the listener is attached), so `/bash poll` must also clear stale “active” state when it observes that the job is finished.

   Background execution and job tracking should reuse the same primitives as the existing bash tool:
   - Spawn shell commands using `src/agents/bash-tools.ts` / `src/agents/bash-process-registry.ts` so output truncation, tail behavior, and kill semantics match the tool system.
   - Use a dedicated `scopeKey` (for example `chat:bash`) so `/bash poll` and `/bash stop` can only see and manage `/bash`-started sessions (and cannot affect agent-started tool sessions).
   - Request elevated execution (host) unconditionally for `/bash` (so the “shell” behavior matches the user’s intent). If elevated is unavailable, reply with a message that points to the fix-it keys under `tools.elevated.*`.

4. Implement bash-only subcommands (in the same `/bash` handler):
   - `/bash poll`: show status + tail output for the active global `/bash` session (or say “no active /bash job”).
   - `/bash stop`: kill the active global `/bash` session (if any) and reply with confirmation.
   - Optional but recommended for safety/precision: support `/bash poll <sessionId>` and `/bash stop <sessionId>`.

   These must not abort the agent run; they should only stop `/bash`-started jobs (by killing the process tree for that `sessionId`).

5. Add tests:
   - Ensure `/bash ...` is blocked when disabled.
   - Ensure `/bash echo hi` completes in the foreground when `commands.bashForegroundMs` is non-zero and the command is fast, returning output without requiring `/bash poll`.
   - Ensure `/bash poll` works for backgrounded commands (use a test command that sleeps longer than the configured foreground window) and returns output when complete.
   - Ensure a second `/bash <cmd>` while one job is still running returns “already running” and does not start a new job.
   - Ensure `/bash stop` does not call the agent abort path (bash-only behavior).

6. Update docs:
   - Update `docs/tools/slash-commands.md`:
     - Add `commands.bash` and `commands.bashForegroundMs` to the config snippet.
     - Add `/bash`, `/bash poll`, `/bash stop` to the command list.
     - Add a short “behavior” note: foreground up to N ms, then background + poll; only one `/bash` job at a time globally.
   - Update `docs/gateway/configuration.md`:
     - Add `bash` and `bashForegroundMs` to the `commands` snippet.
     - Add bullet notes explaining the keys and the “one running job (global)” constraint.

   Note for implementers: `src/docs/slash-commands-doc.test.ts` enforces that all command aliases from `src/auto-reply/commands-registry.ts` are present in `docs/tools/slash-commands.md` as backticked `/...` strings. If `/bash` (and any new aliases) are added to the registry, the docs must be updated in the same change.

7. Validate by running `pnpm test` and ensuring all tests pass.

## Concrete Steps

All commands below are run from the repo root:

    cd /Users/dev/Workdir/clawdbot

Edit config schemas/types:

    - Update src/config/types.ts (add commands.bash)
    - Update src/config/types.ts (add commands.bashForegroundMs)
    - Update src/config/zod-schema.ts (add commands.bash validation)
    - Update src/config/zod-schema.ts (add commands.bashForegroundMs validation)
    - Update src/config/schema.ts (add key description for commands.bash)
    - Update src/config/schema.ts (add key description for commands.bashForegroundMs)

Register the command:

    - Update src/auto-reply/commands-registry.ts (add “bash” command + gating)

Implement the handler:

    - Update src/auto-reply/reply/commands.ts (add /bash runner + /bash poll + /bash stop)

Update docs:

    - Update docs/tools/slash-commands.md
    - Update docs/gateway/configuration.md

Run tests:

    pnpm test

CI parity (mirror what GitHub Actions runs):

    pnpm lint
    pnpm build
    pnpm test
    pnpm protocol:check

    bunx biome check src
    bunx vitest run
    bunx tsc -p tsconfig.json

Expected evidence:

    - Unit tests pass.
    - Lint/build/protocol checks pass in both pnpm and bun modes.
    - Manually (optional): in a configured chat:
      - “/bash echo hello” replies quickly with a `sessionId`.
      - “/bash poll” replies with output that includes “hello”.
      - “/bash stop” stops a long-running bash command without aborting an in-flight agent run.

## Validation and Acceptance

Acceptance is met when:

1. With `commands.bash` unset or `false`, sending `/bash echo hi` yields a reply that clearly states `/bash` is disabled.
2. With `commands.bash: true` and from an authorized sender:
   - With `commands.bashForegroundMs` set to a small value (e.g. 2000), `/bash echo hi` completes in the foreground and returns output without requiring `/bash poll`.
   - With `commands.bashForegroundMs` set to `0`, `/bash echo hi` returns quickly with a `sessionId` and `/bash poll` returns output that includes `hi`.
   - If a `/bash` job is already running anywhere, `/bash <cmd>` replies with “already running” and suggests `/bash poll` or `/bash stop`.
3. `/bash stop` only affects `/bash` jobs and does not abort or interfere with the AI agent run (no `/stop` behavior).
4. `pnpm test` passes.
5. The GitHub Actions CI tasks pass locally (or are demonstrated to be equivalent):
   - `pnpm lint`, `pnpm build`, `pnpm test`, `pnpm protocol:check`
   - `bunx biome check src`, `bunx vitest run`, `bunx tsc -p tsconfig.json`

## Idempotence and Recovery

These changes are additive and safe to apply multiple times. If execution fails, disable the feature by setting `commands.bash: false` and restart the gateway. If docs/test updates are out of sync, re-run `pnpm test` and update the documented command list accordingly.

## Artifacts and Notes

At completion, add a short transcript showing the command output, for example (illustrative):

    /bash echo hello
    -> ⚙️ bash: echo hello
       Exit: 0
       hello

    /bash sleep 10
    -> ⚙️ bash started (session 1234abcd). Still running; use /bash poll or /bash stop.

    /bash poll
    -> ⚙️ bash still running (session 1234abcd)

    /bash stop
    -> ⚙️ bash stopped (session 1234abcd)

## Interfaces and Dependencies

At the end of implementation, the following interfaces and behaviors must exist:

In `src/config/types.ts`, the `commands` config object must include:

    bash?: boolean;
    bashForegroundMs?: number;

In `src/config/zod-schema.ts`, the `commands` schema must validate:

    bash: boolean (optional)
    bashForegroundMs: number (optional; clamped/ranged; document default)

In `src/config/schema.ts`, the schema description map must include:

    "commands.bash": ...,
    "commands.bashForegroundMs": ...,

In `src/auto-reply/commands-registry.ts`, the chat command registry must include a new command definition:

    key: "bash"
    nativeName: "bash"
    textAlias: "/bash"
    acceptsArgs: true

and `isCommandEnabled(cfg, "bash")` must return `true` only when `cfg.commands?.bash === true`.

In `src/auto-reply/reply/commands.ts`, implement a new command-only handler for `/bash` (plus subcommands), with an in-memory “active job” tracker that is independent of any agent run. The `/bash` handler must:

1. Parse the command string from `ctx.CommandBody ?? ctx.RawBody ?? ctx.Body` (not from the lowercased `command.commandBodyNormalized`).
2. Execute the command via `createBashTool(...)` with a dedicated `scopeKey` so the resulting bash process is tracked separately from agent tool runs.
3. Enforce a global single-running-job constraint and return “already running” if another job is active.
4. Provide `/bash poll` and `/bash stop` that operate only on `/bash`-started jobs and never call `abortEmbeddedPiRun(...)`.
5. Clear the global “active job” state when the command finishes (or when `/bash poll` observes that it has finished), so future `/bash <cmd>` calls are not permanently blocked.

Revision note (2026-01-11): Updated the plan to match the user’s latest requirements: global one-at-a-time `/bash` execution (not per chat), and raw message parsing to avoid lowercasing and directive-stripping corrupting shell commands. This also adds explicit guidance for clearing the global lock when the backgrounded process exits, and calls out the docs test that must be kept in sync.

Revision note (2026-01-11): Clarified that `/bash` is host-only (elevated) and is polled for completion (no unsolicited completion message). This resolves open questions about “where does it run?” and “what reply happens when it finishes?” in a way that matches the motivating long-running admin-task use case while keeping scope small.
