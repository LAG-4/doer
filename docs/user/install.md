# Install Doer

Doer runs AI helpers on your computer and lets you control them from its
desktop or web app. Install the desktop app first — Doer sets up its free AI
automatically on first run, with no terminal commands needed.

## Requirements

Doer sets up OpenCode's free AI service automatically on a new installation.
Other AI services may require an account or subscription. You can configure
them after opening the app.

## Desktop app

Download a release from [GitHub Releases](https://github.com/LAG-4/doer/releases)
or from the [download page](https://doer.lagaryan.click/download):

| Platform | Install                                                                     |
| -------- | --------------------------------------------------------------------------- |
| Windows  | `Doer-<version>-x64.exe` installer                                          |
| macOS    | `Doer-<version>-arm64.dmg` (Apple Silicon) or `-x64.dmg` (Intel)            |
| Linux    | `Doer-<version>-x86_64.AppImage` (make it executable first with `chmod +x`) |

Alpha releases are unsigned, so the first launch needs one extra step:

- **macOS:** right-click (Control-click) the app and choose **Open**, then
  confirm. If macOS reports the app is damaged, open **System Settings →
  Privacy & Security**, scroll to the Security section, and choose
  **Open Anyway**.
- **Windows:** SmartScreen may warn about an unknown publisher. Choose
  **More info → Run anyway**.

The app updates itself from GitHub Releases: when a new version is published,
Doer offers it in-app and installs it on restart.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects
there. Select that computer in **Settings → AI services** to set up its AI services.
Doer installs its own server runtime there automatically; the first launch after an app update can
take longer.

## Providers

Open **Settings → AI services** in the web or desktop app and select the computer
where your tasks will run. Choose **Install and enable** for OpenCode, Claude,
Cursor, or Grok. Doer downloads and checks the service for you; no terminal
commands are needed for installation. If a download fails, choose **Try setup
again**. Setup runs on the selected computer, even when you control it remotely.

For Codex, choose **Set up with ChatGPT** to install it and connect your account.
Antigravity has installation and Google sign-in in the same settings page.
Claude, Cursor, and Grok still require their own account sign-in after installation.

| Provider    | Install and authenticate                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| OpenCode    | Automatic setup; the free models work without signing in. See [OpenCode](./providers-opencode.md) for optional paid accounts. |
| Codex       | Set up with ChatGPT in Doer. See [Codex](./providers-codex.md) for existing accounts.                                         |
| Claude      | Install in Doer, then follow [Claude's sign-in instructions](./providers-claude.md).                                          |
| Cursor      | Install in Doer, then follow [Cursor's account setup](https://cursor.com/docs/cli/installation).                              |
| Grok Build  | Install in Doer, then follow [Grok's account setup](https://github.com/xai-org/grok-build).                                   |
| Antigravity | Install and sign in with Google in Doer.                                                                                      |

Doer remembers where it installed each service, so you do not need to restart
the app or change system settings after installation. A custom installation
can still be selected through **Advanced** settings; automatic setup preserves
that choice.

OpenCode is on by default. Codex, Claude, Cursor, and Grok are opt-in:
enable them in **Settings → AI services** and they appear in the model picker
from the next refresh.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** appears only when Doer can tell which
installer owns the CLI (its own update command, Homebrew, or a global npm, pnpm,
bun, or Vite+ install) and runs that installer. Otherwise update the CLI the same
way you installed it. Homebrew installs compare against the version Homebrew
offers, which can trail the npm release by a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, Doer does not display
their original values.

For provider-specific setup and accounts, see [OpenCode](./providers-opencode.md),
[Codex](./providers-codex.md), [Claude](./providers-claude.md), and
[Antigravity](./providers-antigravity.md).

## If setup fails

- **Setup failed or a download failed:** open **Settings → AI services** and
  choose **Try setup again**. Automatic setup preserves a custom installation
  you selected through **Advanced** settings.
- **The AI does not answer or looks disconnected:** check
  **Settings → AI services** for that computer. Re-enable the provider or sign
  in again, then start a new task.
- **Your work is safe:** when available, History lets you review or restore
  saved file changes. Review the task before retrying.
- **If an email send looks uncertain:** check Gmail before retrying — a lost
  network response can leave delivery uncertain, and retrying blindly may send
  it twice.

## Advanced

### Run from the command line

```bash
npx @lag4/doer-cli@latest
```

This starts the server and opens the local web app. Run
`npx @lag4/doer-cli@latest --help` for command-line options.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
npx @lag4/doer-cli app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `npx @lag4/doer-cli app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

### Mobile app

There are no Doer phone apps yet. From your phone's browser, open the pairing
link from the desktop app to control Doer on your computer. Follow
[remote access](./remote-access.md) to link it through T3 Connect or a pairing URL.

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating Doer](./updating.md): update the app and connected servers.
