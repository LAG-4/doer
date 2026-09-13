# FORK: Normie agent harness (LAG-4/t3code)

> This repo is a **separate product forked from `pingdotgg/t3code`**, not a contribution branch.
> Never open PRs to upstream. Cherry-pick upstream fixes via the `upstream` remote when needed.
> Upstream is MIT-licensed (T3 Tools Inc) — keep that copyright + MIT notice in all copies.

**What this fork is:** the same T3 Code harness (Node WebSocket server + web/desktop/mobile clients,
6 BYO providers: Codex, Claude, Cursor, Grok, OpenCode, Antigravity), but rebuilt for
**non-developers** — a free/cheap alternative to Claude Cowork and ChatGPT Work, defaulting to
OpenCode free models while keeping provider choice.

**Goal:** same project but for normies. Daily life/work tasks, files, browser, schedules —
no git jargon, no terminal, no PRs.

**Normie vocabulary (use in UI/docs, not `project/environment/worktree`):**
`Space` (= project/folder), `This computer` (= environment), `History/Undo` (= checkpoint/snapshot),
`Task` (= thread). Never show `branch`, `worktree`, `hunk`, `baseRef`, `PTY`, `cwd`, `HOME`, `ACP`
outside an `Advanced` disclosure.

**Cut / hide first (gate behind `SIMPLE_MODE = true`, don't delete server logic yet):**
`BranchToolbar*.tsx`, `GitActionsControl.tsx`, `worktreeCleanup.ts`, `DiffPanel.tsx`,
`chat/ChangedFilesTree.tsx`, `ThreadTerminalDrawer.tsx` + `server/terminal/Manager.ts`,
`chat/OpenInPicker.tsx`, `routes/_chat.pull-requests.tsx`, `pullRequest/*`,
`server/sourceControl/*`, `server/git/GitManager.ts`, `CommandPalette.tsx`,
`routes/settings.source-control.tsx`, `settings.keybindings.tsx`, `DiagnosticsSettings.tsx`,
`AddProviderInstanceDialog.tsx` binary-path/HOME fields, `CustomModelEditor.tsx`,
`ProjectScriptsControl.tsx` `runOnWorktreeCreate`. Keep `packages/contracts/` untouched so DBs stay compatible.

**Keep (already generic):** threads/drafts, rich composer + attachments + @-files, citations,
plan cards, approvals/sandbox (reworded), file browser/preview/search, checkpoints as History,
pairing URLs, Tailscale/LAN, mobile remote control, `preview/Manager.ts` browser preview.

**Add after cuts (Cowork/Work parity, in order):** 1) onboarding: pick folders + `Free (OpenCode)`
default, 2) Projects-v2: folder + instructions + memory, 3) scheduled/recurring tasks (biggest gap —
T3 only has snooze/wake now), 4) blessed connectors (Drive/Gmail/Calendar/Slack) over raw MCP, 5) plan mode (promote `ProposedPlanCard.tsx`: gather → plan → approve → do), 6) shareable output
pages (reuse preview server, like Work Sites), 7) polished xlsx/pptx/docx outputs.

**Fork dev loop (verified 2026-09-11):** `./dev.sh web|desktop|server|share|mobile|status|stop` (`./dev.sh commands` lists all)
(single entry point, isolated `--home-dir /tmp/t3-fork-dev`, PID-tracked logs in `/tmp/t3fork-dev/`).
Raw form: `vp i`, then `vp run dev --home-dir /tmp/<name>`
(server ~13773/web ~5733 from `[dev-runner]`, ports shift if occupied — e.g. 13775/5735 when busy). Open the full pairing URL
with token, never bare localhost. Never run against live `~/.t3/userdata`. Seed with `VACUUM INTO`
copy per Test data below. Checks: `vp test run <files>`, `vp lint <files>`,
`vp run --filter <package> typecheck`. No repo-wide checks. Stop only PIDs you spawned.

# T3 Code

T3 Code is a minimal GUI for coding agents. A Node WebSocket server wraps provider CLIs and agents (Codex, Claude Code, Cursor, Grok, OpenCode, Antigravity) and serves web, desktop, and mobile clients.

You can think of T3 Code as an open source "bring-your-own-subscription" alternative to apps like Claude Desktop, Codex App, Cursor Glass and Conductor.

## What makes T3 Code special?

We have over 200,000 users who love T3 Code. It's important we maintain the things they love as we continue to iterate on the product. Here's a brief list of the things we can never compromise on.

### 1. Open at the core

T3 Code is truly open. We share our roadmap, we share how we think about things, and of course we share all our code. A large number of our users run forks. We work in the open, and should strive to stay that way.

### 2. Performance without compromise

Lots of apps have gotten bogged down with bad tech decisions and "slop". We have not, and we're proud of the performance of T3 Code. We regularly audit for performance regressions, often caused by sending too much data over websockets, css animations causing gpu spikes, lists being hard to render, and more. Make sure all changes are considerate of performance impact.

### 3. Remote ready

The architecture of T3 Code's websocket layer (npx t3) enables a lot of awesome remote features. These have become core to the product. Whether users are connecting directly over their local network, using Tailscale, or leaning in fully with T3 Connect (our tunnel solution, also in this repo), we need to make sure new features are properly supported.

### 4. Multi-surface

T3 Code has 3 key app surfaces: **web**, **desktop**, and **mobile**.

**Web** is kind of two surfaces, as we have the public facing "app.t3.codes" as well as locally hosting the web app through the `npx t3` command. Both need to be supported by all new features where reasonable.

**Desktop** is the main surface most users install first. It's a full Electron app that bundles the server runner as well. The desktop app can also be used as the host server, allowing remote connections from app.t3.codes or the mobile app.

**Mobile** is a React Native app for both iOS and Android, available on the App Store and Google Play. The mobile app allows for connecting to any T3 Code server to control work remotely.

## A note from Theo

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

Of note: Most T3 Code contributions will come from T3 Code itself, often controlled remotely. This means you should be careful about accessing data, killing dev servers, and other things that may damage the T3 Code instance that the contributor is using.

## A small glossary

We need to be on the same page with terminology. When communicating, use this language:

- **you** means the agent reading this file and changing T3 Code.
- **we, us, and maintainers** mean Theo, Julius and the people building T3 Code. These are who you are talking to now.
- **user** means the person using T3 Code to direct coding agents.
- **agent** means the coding agent a user runs inside T3 Code. Depending on context, that may also include you.
- **provider** means the agent runtime or harness T3 Code talks to, such as Codex, Claude, Cursor, or OpenCode.
- **client** means the web, desktop, or mobile UI.
- **environment** means one running T3 server and the machine, filesystem, provider credentials, and state it owns.
- **project** means an environment-local workspace record rooted at a directory.
- **thread** means the durable conversation and work history for a project.
- **turn** means one user-to-agent cycle, including follow-up work such as checkpointing.
- **T3 home** means the base data directory. Runtime state normally lives below its userdata directory.

## Ways to hurt yourself (and the developer's machine)

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to the live install.** `~/.t3/userdata` is the developer's real T3 Code database, in use while you work. Reading it and copying from it are fine, and a good way to get real test data (see Test data). Never start a server against it, never open it read-write, never clean it up.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`. Setting them bakes localhost into the bundle and silently breaks every remote browser.
4. **Detaching processes.** Never `nohup`, `&`-background, disown, or otherwise detach a process from the agent session. A detached test run or dev server keeps running unmonitored after the turn ends and can starve the developer's own running T3 Code, browser, and other apps — this once forced a full machine restart. Run everything attached with an explicit timeout, one heavy suite at a time. After any interrupted command, `ps`-check for strays from this worktree before doing anything else.

## Hit every surface

The most common defect in this repo is a change that works on the path you tested and is missing everywhere else. Before calling frontend work done, walk this list and say which entries applied:

- **Entry points.** A behavior reachable from the chat view is usually also reachable from Settings, the command palette, and a keybinding. Fixing one is not fixing the feature.
- **Clients.** Web, desktop (wraps web, adds Electron shell/IPC), and mobile (React Native, separate navigation). Shared logic lives in `packages/client-runtime`
- **Providers.** Codex, Claude, Cursor, Grok, OpenCode, and Antigravity each have an adapter. Provider-shaped features need a decision per adapter, even if the decision is "not supported here".
- **Contracts.** Anything crossing the wire is typed in `packages/contracts`. Change the schema and the server, web, mobile, and desktop all follow.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Snooze needs unsnooze. Close needs reopen. A one-way door is a bug.
- **Connection modes.** Local, remote/relay, and tunnel behave differently. Multi-device and multi-environment cases are real.
- **Docs.** Check whether the change makes existing guidance inaccurate. Apply the [documentation rules](#documentation) before adding anything.

## Dev servers

- `vp i` installs. Worktrees get this from the t3.json setup script; if module resolution looks broken, it probably did not run.
- `vp run dev` starts server and web. In a worktree, state defaults to that worktree's gitignored `.t3`, which deliberately outranks an ambient `T3CODE_HOME` so you cannot land on shared state by accident. An explicit `--home-dir` still wins.
- Ports derive from the worktree path and are stable across restarts, but read the real ones from the `[dev-runner]` line since occupied ports shift.
- Sharing over the tailnet is three steps: run `vp run dev --share` in the background, wait for the `pairingUrl:` line in its output, paste that full URL (token included) in your reply. Do not wire up `tailscale serve` by hand for this, and do not open the URL yourself.
- The web app requires pairing. Hand over the pairing URL, not the bare origin. A URL without its token is useless to whoever you gave it to. If the token got consumed, mint a fresh one with `node apps/server/src/bin.ts pair` — note it carries standard scopes, while the startup URL carries admin scopes (needed for Settings → Connections management).
- Stop what you started, by the PID you tracked. See rule 1.

## Test data

An empty database is a bad test. Seed your worktree's `.t3` with a copy of real data instead of pointing at live state:

- Copy from `~/.t3/userdata` (the developer's real data, the most realistic test set) or `~/.t3/dev`. Worktree state lives at `<worktree>/.t3/userdata`.
- Snapshot the database with `VACUUM INTO`, which is safe even while a server has the source open and yields one consistent file:

  ```bash
  mkdir -p .t3/userdata
  rm -f .t3/userdata/state.sqlite*  # VACUUM INTO refuses to overwrite
  bun -e "new (require('bun:sqlite').Database)(process.env.HOME + '/.t3/userdata/state.sqlite', { readonly: true }).run(\"VACUUM INTO '.t3/userdata/state.sqlite'\")"
  ```

  A plain `cp` is only safe when no server has the source open, and must bring the `-wal` and `-shm` siblings along. A live file copy is a corrupt copy.

- Bring `secrets` and `settings.json` only if the flow under test needs them.
- Copy in, never symlink. Data flows one way: into your sandbox, never back out.

## Verifying

- Smallest proof that the change works. `vp test run <files>` for the tests you touched, targeted lint and typecheck for the scope you changed.
- Test meaningful logic or observable behavior. Do not render components to static markup to assert props or attributes, or add tests that merely assert callback wiring or mirror the implementation.
- **Do not run repo-wide checks.** No `vp check`, no `vp run -r test`, no `vp run -r typecheck` unless I ask. CI owns the full suite.
- Backend behavior changes ship with focused tests for that behavior.
- The server is event-sourced and its async flows emit typed receipts. Wait on receipts and worker drains, never on sleeps or polling. A test that needs a timeout to pass is wrong.
- Upon request, user-visible frontend changes should get one integrated pass in a real client: `test-t3-app` for web, `test-t3-mobile` for mobile. The primary agent does this once after integrating. Subagents do not launch their own dev servers. Ask permission before doing computer use or spinning up browsers.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- UI changes need before/after images. Motion or timing needs a short video.
- Upload PR evidence to GitHub. Never commit PR-only screenshots or assets such as `.github/pr-assets/`.
- One concern per PR. If the description says "also", split it.
- When babysitting: poll checks and comments newer than the last push, verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new. Stop when the bots are green on the latest commit.

## Documentation

Most code changes do not need an internal documentation change. Agents can read the code.

- `docs/internals/` is for architectural decisions and their reasons, constraints that span components, and implementation traps that are hard to discover from the source. Before adding a paragraph, ask what a maintainer would get wrong without it. If reading the relevant code answers the question, leave it out.
- Do not document every feature, enumerate fields or methods, narrate control flow, maintain file catalogs, or append PR summaries. Types, tests, and code already record the implementation. The glossary defines shared vocabulary; it is not a feature index.
- Keep a local implementation explanation in a nearby code comment. Use an internal doc when the reasoning crosses boundaries or needs context the code cannot carry well. Link to the relevant source instead of copying it.
- When a documented decision or constraint changes, rewrite or remove the affected text. Do not append another account of the new behavior. A new internal page needs a distinct, durable reason to exist.
- `docs/user/` helps users accomplish tasks. Give each major feature a concise section explaining what it does, how to start, and anything unintuitive. A settings path is useful; descriptions of visible buttons, icons, layouts, animations, or every UI state are not. Before adding text, ask what task or decision it helps the user with.
- Keep user docs in the shipped product's voice, without implementation details or contributor tooling. Update the relevant feature section when how to use it changes. A UI tweak does not need a documentation entry, and a new control does not need its own page.
- `docs/operations/` holds maintainer setup, release, and debugging procedures. Keep instructions for operating an installed T3 Code server in the user guides.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files. Keep temporary working material outside the worktree. `.plans/` is gitignored only as a safety net for legacy tooling.
- Track active maintainer work in the GitHub issue or project item that owns it. External proposals follow `CONTRIBUTING.md` and belong in Ideas discussions.
- A merged PR is the implementation record. Close or update its tracking item when the work lands; do not preserve a second checklist in the repository.

## How it works

Clients send typed WebSocket requests. The server turns them into _commands_, a pure _decider_ turns commands into persisted _events_, and a _projector_ derives the read model the UI renders. Provider CLIs run as subprocesses; per-provider _adapters_ translate their native protocols into orchestration events. Side effects run in queue-backed _reactors_ that emit _receipts_ when milestones land. Each turn ends with a _checkpoint_, a hidden git ref, so the app can diff and restore.

Full glossary with file links: `docs/internals/glossary.md`

## Where code lives

- `apps/server` - WebSocket, orchestration, providers, checkpointing. Effect-heavy: read `.repos/effect-smol/LLMS.md` before writing Effect code.
- `apps/web` - React/Vite UI. `apps/desktop` wraps it, `apps/mobile` is React Native, `apps/marketing` is the site.
- `packages/contracts` - Effect/Schema contracts plus small derived helpers. No heavy runtime logic.
- `packages/shared` - shared runtime utils, subpath exports, no barrel.
- `packages/client-runtime` - client code shared by web and mobile.
- `.repos/` - vendored read-only references. Prefer their patterns over invented ones. Never edit or import from them. Sync with `vpr sync:repos` when bumping the matching dependency.

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Inferred types over annotations. `any` is the enemy.
- Comments describe how a thing is used, and move when the code moves. To be used mostly to describe functions, not to annotate every line of behavior.
- Our users drive agents all day and notice a dropped frame, a lying spinner, and a stale label. No continuously repainting animations; they peg the GPU on high-refresh displays.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.

## Additional tips

- Don't verify with browsers or computer use unless the user explicitly agrees or requests it.
- Security is important, but should not be over-indexed on, especially for dev mode/maintainer-only features.

## Fork rules (LAG-4/t3code only — never upstream this section)

This fork ships a simplified build for non-developers. `main` must stay a pure
mirror of upstream `pingdotgg/t3code` `main` so fixes flow in cleanly.

- **Never commit to `main`.** Not directly, not via PR. The daily `Sync upstream
main` workflow fast-forwards it; any direct commit breaks the sync.
- **`lite` is the product branch (and repo default).** All custom work lives here.
- **Feature work:** cut branches off `lite` (`feat/<name>`), PR them back into
  `lite`. Never base fork work on `main`, never target PRs at `main`.
- **Pull upstream work into the product** (your choice, your timing — nothing
  auto-merges into `lite`):
  - Catch up fully: `git checkout lite && git fetch origin && git merge origin/main`.
  - Take one fix/feature: `git checkout lite && git cherry-pick <sha-from-main>`
    or `git checkout origin/main -- <path>`.
  - If upstream re-adds something `lite` deliberately removed, keep it removed
    (resolve that hunk in favor of `lite`) and say so in the merge commit.
    This includes `apps/marketing`: upstream T3 copy must never come back —
    `doer-branding.test.ts` fails CI when it does, so resolve marketing
    conflicts in favor of `lite` until that test is green.
  - When merging `origin/main` into `lite`, keep this Fork rules section: if
    upstream edited AGENTS.md, resolve by taking their body and re-adding this
    section at the end.
- **Upstream sync failures:** if the sync workflow fails with "not possible to
  fast-forward", someone committed to fork `main`. Move those commits onto
  `lite` (`git cherry-pick`), then reset the mirror:
  `git fetch upstream && git checkout main && git reset --hard upstream/main && git push --force-with-lease origin main`.
- **Never touch the developer's running apps.** This machine runs the
  developer's real T3 Code (and other apps) alongside agent work. Never
  `kill`, `pkill`, `killall`, or stop any process you did not spawn yourself —
  not even by exact PID, since PIDs get reused. Never start dev servers,
  builds, test runs, or bulk file rewrites without explicit permission: they
  spike CPU/RAM and file watchers in running apps rebuild off your writes.
  Default to read-only (`rg`, `git diff`, `Read`); ask before anything that
  consumes significant resources.

## Distribution (Doer fork — `lite` only, never upstream this section)

Doer ships free-tier only: unsigned desktop apps via GitHub Releases (in-app
auto-update included), the `@lag4/doer-cli` npm package, and the marketing site at
https://doer.lagaryan.click. No store builds, no signing certs, no Clerk/relay,
no Discord, no AUR. Operator checklist: `docs/operations/doer-distribution.md`.

- **Release workflow** (`.github/workflows/release.yml`): free GitHub-hosted
  runners; jobs are `resolve_commit → preflight → quality → build (+wsl
prebuild) → publish_cli → release`. Upstream-only jobs (AUR, Vercel deploys,
  Discord, `finalize`) stay in the file but are gated to
  `github.repository == 'pingdotgg/t3code'` — never remove the gates, and
  never let `finalize` run on the fork (it would push to fork `main`, which
  must stay a pure upstream mirror).
  Nightlies run **daily 02:08 UTC** and only publish when new commits exist
  (see `.github/scripts/check-nightly-release.cjs`). Stable ships by pushing a
  `vX.Y.Z` tag above `apps/desktop/package.json`, or `workflow_dispatch
channel=stable`, which builds the latest nightly commit.
- **npm CLI**: package `@lag4/doer-cli`, binaries `doer` + `doer-cli` — both bin
  entries must exist or `npx @lag4/doer-cli` breaks. First publish auto-creates the
  package; auth is the `NPM_TOKEN` repo secret (granular token, publish
  scope). `publish_cli` must stay before `release` in `needs` — servers
  self-update to the exact client version, so the npm package must exist
  before desktop artifacts ship.
- **Identity rules**: desktop app ID `click.lagaryan.doer`, URL schemes
  `doer://` / `doer-dev://`, artifacts `Doer-<version>-<arch>.*`. The site
  (`apps/marketing/src/lib/releases.ts`, `/download`) resolves assets by
  filename suffix (`-arm64.dmg`, `-x64.dmg`, `-x64.exe`, `-x86_64.AppImage`):
  never change the electron-builder `artifactName` arch suffixes without
  updating the site matchers; never point the site back at `pingdotgg/t3code`.
  Effect service IDs follow the package name (`@lag4/doer-cli/...` in
  `apps/server`) — the `deterministicKeys` lint enforces it and the release
  gate runs typecheck, so a rename without updating IDs blocks all releases.
- **Triage pair**: `apps/server/src/cli/triagePrompt.ts` (`TRIAGE_PLAYBOOK`)
  and `.github/triage/PLAYBOOK.md` must stay byte-identical (a test enforces
  it); both point at `LAG-4/t3code` on branch `lite`. Edit both together.
- **SSH remote path**: remote hosts install `@lag4/doer-cli@<spec>` and exec the
  `doer` binary (`packages/ssh/src/tunnel.ts`, `command.ts`); the desktop
  resolves the spec from its release channel. The pinned-runtime and
  service-launcher entry paths are `node_modules/@lag4/doer-cli/dist/bin.mjs`.
- **Signing later**: adding `CSC_*`/`APPLE_*` or `AZURE_*` secrets re-enables
  signed macOS/Windows builds with no code change (the workflow already
  branches on their presence).
- **Merging upstream**: if upstream touches `release.yml`, the build script,
  or CLI packaging, keep the fork gates/identity and re-verify with server
  typecheck, `vp test run scripts/build-desktop-artifact.test.ts`
  `packages/ssh/src/runnerProcess.test.ts`, marketing `typecheck` + `build`,
  and `node scripts/release-smoke.ts`.
