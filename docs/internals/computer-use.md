# Computer use

Codex-style desktop control reuses the device toolkit's shape: a small MCP
surface (`computer_status/start/allow/forget/observe`) plus a preconfigured
CLI on the provider PATH (`computer-use`), with driving left to the upstream
tool. Do not wrap the upstream tools one by one; the comment on the toolkit
explains why.

## One external tool, two gates

[open-computer-use](../../apps/server/src/computer/ComputerToolchain.ts) is
npm-installed at a pinned version into the T3 home and run with the server's
Node, never `npx`. Consent has two layers that must stay in agreement:

1. The `computer` MCP capability, from `enableAgentComputerAccess`
   (environment default plus project override). This is the kill switch.
2. The per-app allow list at `<stateDir>/computer/allowed-apps.json`,
   owned by `ComputerService`. This is Codex's per-app prompt / Always allow.

The MCP handlers check the allow list, but agents drive mostly through the
CLI, so the [launcher](../../apps/server/src/computer/ComputerShim.ts)
enforces the same list for `call`/`snapshot` by parsing `--args`,
`--args-file`, `--calls`, and `--calls-file`. If the upstream CLI gains a new
app-targeted flag or subcommand, the launcher's parser must learn it, or that
route silently bypasses per-app consent. Read-only discovery (`list-apps`,
`doctor`, `list_apps`) intentionally passes with an empty list so agents can
discover apps before any approval.

The launcher also scrubs `OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS`
and `OPEN_COMPUTER_USE_DISABLE_APP_AGENT_PROXY` from the agent's environment.
The first keeps the Codex default (the real pointer never moves); the second
keeps macOS automation running under the helper app's identity, which is what
the TCC grants attach to. There is deliberately no setting for either yet.

## macOS lifecycle

The CLI self-proxies through the bundled `.app` over a Unix socket and
launches the app instance itself on first use. The server never manages the
`.app` lifecycle. `computer_start` runs `doctor`, which opens the upstream
onboarding UI when permissions are missing; that is the permission flow, not
a Doer window.
