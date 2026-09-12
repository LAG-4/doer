# Doer distribution (fork)

How Doer ships to users, for free. Agent-oriented rules live in
`AGENTS.md` ("Distribution (Doer fork)"); this page is the human checklist.

## What users get

- **Desktop app** (Windows x64, Linux x64, macOS arm64 + x64, unsigned) from
  [GitHub Releases](https://github.com/LAG-4/t3code/releases), with in-app
  auto-update. Stable channel tracks finished releases, Nightly tracks previews.
- **Terminal**: `npx doer-cli@latest` (stable) or `npx doer-cli@nightly`
  (preview). The package also installs a short `doer` command. Same backend,
  no desktop app needed.
- **Website**: https://doer.lagaryan.click/download always shows the newest
  build per channel.

## One-time setup (all free)

1. **npm token**: on npmjs.com create a granular access token with publish
   access for the `doer-cli` package (scope it to "All packages" until the
   first publish creates `doer-cli`, then narrow it). Add it as the
   `NPM_TOKEN` secret in the GitHub repo (Settings → Secrets → Actions).
   Without it, `publish_cli` fails and no GitHub Release ships.
2. **Vercel**: the marketing site deploys from the repo (production tracks
   `lite`). Point `doer.lagaryan.click` at the production deployment
   (via Cloudflare as today).
3. Nothing else. No Apple, Azure, Clerk, Cloudflare Workers, Expo, or Discord
   accounts are needed. Runners are free GitHub-hosted ones.

## Shipping

- **Nightly**: automatic, daily ~02:08 UTC, only when new commits exist. Manual:
  Actions → Release → Run workflow → `channel: nightly`.
- **Stable**: push a `vX.Y.Z` tag higher than `apps/desktop/package.json`
  (first release: `v0.0.41`), or dispatch `channel: stable` (builds the latest
  nightly commit — the tested path).
- Never push a test tag: every accepted tag publishes for real (npm package +
  GitHub Release).

## Identity (do not change casually)

- npm package `doer-cli`, binaries `doer` + `doer-cli` (both must exist or
  `npx doer-cli` breaks).
- Desktop app ID `click.lagaryan.doer`, URL schemes `doer://` / `doer-dev://`,
  artifacts `Doer-<version>-<arch>.*` (the site matches on the arch suffixes).
- Effect service IDs follow the package name (`doer-cli/...` in `apps/server`);
  the `deterministicKeys` lint enforces this and the release gate runs it.
- Triage prompt and `.github/triage/PLAYBOOK.md` must stay byte-identical
  (there is a test); both point at `LAG-4/t3code` on branch `lite`.

## Later, when it matters

- **Signed builds**: add Apple (`CSC_LINK`, `CSC_KEY_PASSWORD`,
  `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_TEAM_ID`,
  `MACOS_PROVISIONING_PROFILE`) or Azure (`AZURE_*`) secrets — the workflow
  signs automatically when they exist. No code change.
- **Package managers** (winget, Homebrew, AUR) need manual registry
  submissions; wire them up only on request.
