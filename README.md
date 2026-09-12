# Normie Agent Harness (fork of T3 Code)

> This is **LAG-4/t3code**, a separate product fork of [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code)
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
machine with a [desktop app](https://github.com/LAG-4/t3code/releases) and a web app.
No terminal. No jargon.

Doer starts free with OpenCode's free models (Big Pickle first, then other free Zen
models when available — the default for new tasks) plus your subscriptions on Codex,
Claude Code, Cursor, Grok Build, and Google Antigravity. If they're set up on your
computer, Doer can use them.

- Site: [doer.lagaryan.click](https://doer.lagaryan.click)
- Downloads: [GitHub Releases](https://github.com/LAG-4/t3code/releases)
- License: MIT — built on top of [T3 Code](https://github.com/pingdotgg/t3code) and [OpenCode](https://opencode.ai).

## "Wait, what are you selling me?"

Nothing. Doer is free forever: the app costs nothing, it starts on free models, and
it only ever asks for a subscription you already have if you outgrow them. It exists
because AI help shouldn't require a terminal, a tutorial, or a new subscription —
just a computer and something you'd rather not do yourself.

## Installation

> [!WARNING]
> Doer starts free with OpenCode's free models and also supports Codex, Claude, Cursor, Grok Build, and Antigravity. Install and authenticate at least one provider before use:
>
> - OpenCode (default, free): install [OpenCode](https://opencode.ai) and run `opencode auth login`. New threads use Big Pickle (`opencode/big-pickle`), then other `*-free` Zen models when Big Pickle isn't available.
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

### Try it out (install-free)

The easiest way to test Doer is to run the server in your terminal (requires Node.js 22.16+, 23.11+, or 24.10+):

```bash
npx @lag4/doer-cli@latest
```

This will launch Doer's backend on your machine as well as the local web app to get things done.

Tip: Use `npx @lag4/doer-cli@latest --help` for the full CLI reference.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/LAG-4/t3code/releases).

> Alpha builds are unsigned: on macOS, right-click the app and choose Open the first
> time. Windows may show a SmartScreen warning.

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
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

Have a feature request? Open an [issue](https://github.com/LAG-4/t3code/issues).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
