# Normie Agent Harness (fork of T3 Code)

> This is **LAG-4/doer**, a separate product fork of [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code)
> for **non-developers** — think Claude Cowork / ChatGPT Work, but BYO-provider with OpenCode free models.
> Not an upstream contribution branch: do not open PRs to upstream. Upstream is MIT (T3 Tools Inc);
> that copyright + license notice is preserved in `LICENSE`.
>
> Agent instructions live in `AGENTS.md` (fork goal, cut/keep/add lists, normie vocabulary, dev loop).
> User flow: pick folders → pick Free (OpenCode) or your provider → chat, files, history, schedules.
> Dev jargon (branches, worktrees, diffs, PRs, terminals, editors) is hidden behind `SIMPLE_MODE`.

# Doer

Doer is a free forever, open-source AI helper for everyday work — writing, research,
files, plans, job applications and more. Hand it the boring work: it runs on your
machine with a [desktop app](https://github.com/LAG-4/doer/releases) and a web app.
No terminal. No jargon.

Doer starts free with OpenCode's free models — automatic setup, no card, no
terminal. If you already pay for an AI service (Codex, Claude Code, Cursor,
Grok Build, or Google Antigravity), you can connect it from Settings once the
app is running.

- Site: [doer.lagaryan.click](https://doer.lagaryan.click)
- Downloads: [GitHub Releases](https://github.com/LAG-4/doer/releases)
- License: MIT — built on top of [T3 Code](https://github.com/pingdotgg/t3code) and [OpenCode](https://opencode.ai).

## "Wait, what are you selling me?"

Nothing. Doer is free forever: the app costs nothing, it starts on free models, and
it only ever asks for a subscription you already have if you outgrow them. It exists
because AI help shouldn't require a terminal, a tutorial, or a new subscription —
just a computer and something you'd rather not do yourself.

## Installation

Start with the desktop app. No terminal needed.

### Desktop app (recommended)

Install the latest version of the desktop app from [GitHub Releases](https://github.com/LAG-4/doer/releases).

On first run Doer sets up its free AI automatically — just open the app and
start your first task. If you already pay for an AI service, connect it later
from Settings.

> Alpha builds are unsigned: on macOS, right-click the app and choose Open the first
> time. Windows may show a SmartScreen warning.

### Advanced: run from the command line

Developers can run the server plus local web app without installing anything
(requires Node.js 22.16+, 23.11+, or 24.10+):

```bash
npx @lag4/doer-cli@latest
```

Tip: Use `npx @lag4/doer-cli@latest --help` for the full CLI reference.
Provider CLIs you manage yourself (for example `opencode auth login`) keep
working — in-app automatic setup just means you only need them for advanced
setups.

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [OpenCode](./docs/user/providers-opencode.md) · [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run Doer as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

Doer uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Open an [issue](https://github.com/LAG-4/doer/issues).

Need support? Open an [issue](https://github.com/LAG-4/doer/issues) with what you
were doing, what you expected, and what happened instead.
