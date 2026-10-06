# Doer distribution (fork)

How Doer ships to users, for free. Agent-oriented rules live in
`AGENTS.md` ("Distribution (Doer fork)"); this page is the human checklist.

## What users get

- **Desktop app** (Windows x64, Linux x64, macOS arm64 + x64, unsigned) from
  [GitHub Releases](https://github.com/LAG-4/doer/releases), with in-app
  auto-update.
- **Terminal**: `npx @lag4/doer-cli@latest`. The package also installs a short
  `doer` command. Same backend, no desktop app needed.
- **Website**: https://doer.lagaryan.click/download always shows the newest
  build per channel.

## One-time setup (all free)

1. **npm token**: on npmjs.com create a granular access token with publish
   access for the `@lag4/doer-cli` package (scope it to "All packages" until the
   first publish creates `@lag4/doer-cli`, then narrow it). Add it as the
   `NPM_TOKEN` secret in the GitHub repo (Settings → Secrets → Actions).
   Without it, `publish_cli` fails and no GitHub Release ships.
2. **Vercel**: the marketing site deploys from the repo (production tracks
   `lite`). Point `doer.lagaryan.click` at the production deployment
   (via Cloudflare as today).
3. **Public Gmail (optional)**: finish the production Google OAuth setup and
   verification described in [Operating Gmail](google-oauth.md). Keep
   `DOER_GMAIL_PUBLIC_READY` unset or false until Google approves public access
   and the packaged app has been checked. Other tools can ship while Gmail is
   unavailable in the default release.

No Apple, Azure, Clerk, Cloudflare Workers, Expo, or Discord accounts are needed.
Runners are free GitHub-hosted ones.

## Keeping the website Doer (not T3)

The repo source on `lite` is Doer, but the live domain is owned by Vercel
dashboard settings, so it can show the upstream T3 site without any repo
change: if the production branch is `main` (a pure upstream mirror, synced
daily) or the domain sits on the upstream `t3code-marketing` project, every
upstream deploy overwrites Doer with T3. This happened on 2026-09-13, when
the live domain served a fresh upstream build (canonical `t3.codes`,
`pingdotgg/t3code` links) while `lite` still held the Doer pages.

- Vercel project `doer-marketing`: Settings → Git → Production Branch must
  be `lite`. Domains: `doer.lagaryan.click` only here, never on
  `t3code-marketing`.
- Upstream catch-up merges must resolve `apps/marketing` conflicts in favor
  of `lite`. `apps/marketing/src/lib/doer-branding.test.ts` fails CI when
  T3 copy, links, or metadata leak back in — keep it green, don't weaken it.
- `Doer site check` workflow fetches the live homepage daily and fails when
  it serves T3 content. When it fires, fix the dashboard (above) and
  redeploy the latest `lite` commit; no repo change is needed.

## Shipping

- **Stable only**: push a `vX.Y.Z` tag higher than `apps/desktop/package.json`
  (first release: `v0.0.41`), or Actions → Release → Run workflow with an
  optional `version` input (blank builds the `apps/desktop/package.json`
  version at the selected ref). No nightlies, no schedules.
- Never push a test tag: every accepted tag publishes for real (npm package +
  GitHub Release).
- **Recovery**: if desktop artifacts built but the release job couldn't
  publish, Actions → Publish release assets re-publishes the GitHub Release
  from that run's `desktop-*` artifacts without rebuilding.

## Identity (do not change casually)

- npm package `@lag4/doer-cli`, binaries `doer` + `doer-cli` (both must exist or
  `npx @lag4/doer-cli` breaks).
- Desktop app ID `click.lagaryan.doer`, URL schemes `doer://` / `doer-dev://`,
  artifacts `Doer-<version>-<arch>.*` (the site matches on the arch suffixes).
- Effect service IDs follow the package name (`@lag4/doer-cli/...` in `apps/server`);
  the `deterministicKeys` lint enforces this and the release gate runs it.
- Triage prompt and `.github/triage/PLAYBOOK.md` must stay byte-identical
  (there is a test); both point at `LAG-4/doer` on branch `lite`.

## Later, when it matters

- **Signed builds**: add Apple (`CSC_LINK`, `CSC_KEY_PASSWORD`,
  `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_TEAM_ID`,
  `MACOS_PROVISIONING_PROFILE`) or Azure (`AZURE_*`) secrets — the workflow
  signs automatically when they exist. No code change.
- **Package managers** (winget, Homebrew, AUR) need manual registry
  submissions; wire them up only on request.

## Microsoft Store (AppX, free signing)

Two routes address the 10.2.9 unsigned-package rejection; pick one per release.
Only that stated failure requires signing — no broader policy claim is made
here, and a green build never guarantees certification.

- **Signed EXE (existing Win32 listing).** Add the `AZURE_*` Trusted Signing
  secrets and the release workflow signs the NSIS installer in place. No code
  change. Needs an Azure Trusted Signing account + certificate profile. Adding
  the secrets only enables the signing step: before shipping, verify the
  installer AND every shipped PE binary (all DLLs, node.exe, helpers) carry
  valid signatures.
- **Store AppX (free, separate packaged submission).** Build the unsigned
  `.appx` with Actions → Store AppX → Run workflow (default app version
  `0.0.56`, mapped to Store package `1.0.56` / manifest `1.0.56.0`; always a
  new version, never reuse a rejected one), upload it to Partner Center, and
  Microsoft signs it after certification. No Apple/Azure certificate needed.
  The `.appx` stays in CI artifacts: it is never attached to a GitHub Release
  and never mirrored to the download site.
- **Prerequisite for Store distribution:** the Store job builds the desktop
  app at the input version but publishes no npm package. Remote SSH hosts
  install `@lag4/doer-cli@<version>`, so run the normal release first to
  publish the matching CLI version; until that npm version exists, the Store
  package is install-only with no remote-backend support claim.

### Store version mapping

The Store requires a four-part Version with a nonzero first section and a
reserved trailing 0
(`https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements`),
but electron-builder packs `${app.version}.0` verbatim — so app `0.0.56`
would produce the invalid `0.0.56.0`. The build maps app major+1 (`0.0.56` →
Store `1.0.56` → manifest `1.0.56.0`; `1.0.0` → `2.0.0.0`), rejects
prereleases, and rewrites the packed manifest's Identity Version through the
supported `appxManifestCreated` hook (a staged `.cjs` file path, which
survives config JSON serialization where a function would not). The app keeps
its own version everywhere else; CI validates the unpacked manifest carries
the mapped quad. Updating an already-certified packaged listing requires a
mapped Store version strictly higher than the certified one.

### Package identity (four exact values, no substitutes)

The workflow takes four required inputs from Partner Center → the product →
Package identity, plus the reserved packaged app name. Do not reuse the old
`T3CODE_DESKTOP_APPX_*` repo vars (their listing is unconfirmed — they may
belong to a different submission — so never substitute them); the workflow
overrides them with your inputs and the build fails closed without all four.

- Name (Identity.Name), Publisher (`CN=<guid>`), Publisher display name.
- Display name: the reserved packaged app name. This is the fourth exact
  value needed in addition to the identity trio — do not assume it.

### Listing constraint

The existing Win32 app name may be held, so the new packaged submission may
require a DIFFERENT reserved name (e.g. Doer Alpha or another name you
reserve). The existing Win32 product cannot just accept the AppX via the same
URL form — packaged submissions are separate. Never delete the Win32 listing
automatically to free the name; create the new packaged submission with its
own identity and keep both until the Store build is certified. Migrating the
exact `Doer` name later (if ever) requires your explicit decision.

### runFullTrust justification (for the submission notes)

Electron apps ship with the `runFullTrust` capability (electron-builder adds
it automatically). Reviewers expect a reason: Doer runs a local Node server
sidecar, spawns terminal shells (node-pty/conpty), reads and writes across
the user's own folders, and embeds a WSL Linux runtime. None of this fits a
sandboxed capability set.

### Verify on Windows before submitting

1. Download the `doer-store-appx-<app-version>` CI artifact (package +
   `SHA256SUMS.txt` + unpacked `AppxManifest-<app-version>.xml`).
2. For local validation only, make a TEST-SIGNED COPY: sign the copy with a
   self-signed cert, install the cert into the machine's Trusted People
   store, then `Add-AppxPackage -Path <test-signed-copy.appx>`. This copy is
   validation-only — upload the ORIGINAL UNSIGNED CI `.appx` to Partner
   Center, never the test-signed copy.
3. Launch the sideloaded app and check `doer://` deep links, first-run
   folders under `~/.doer` (full-trust user folders), and the WSL backend.
4. Run the Windows App Cert Kit against the test-signed package and clear
   every failure, especially the branding checks (the build stages its own
   `StoreLogo`, `Square150x150Logo`, `Square44x44Logo`, `Wide310x150Logo`
   from the Doer icon — never Electron defaults).
5. Upload the **unsigned** CI `.appx` to Partner Center.

A green build is not a certification guarantee: WACK results, manual policy
review, and Store backend/subprocess behavior (especially WSL) still decide.
The Store build disables in-app self-update because the Microsoft Store
manages updates for Store packages (the app reports "Automatic updates are
managed by the Microsoft Store for the Store package."); Store installs
update through the Store only.

## Optional Microsoft sign-in

Register a Microsoft Entra public-client application with device-code sign-in
enabled and the supported account types your installation needs. Set
`DOER_MICROSOFT_CLIENT_ID` to its application ID on the server host, then restart
Doer. This is a public application identifier; no client secret is used.
The initial delegated permissions are `User.Read`, `Mail.Read`, `Calendars.Read`,
`Files.Read`, and `offline_access`. SharePoint is opt-in and additionally requests
`Sites.Read.All`. Your organization may require administrator consent.
Test consent with both personal and organization accounts before distributing
your registered configuration. Access and refresh tokens stay in the server's
protected secret store. Do not bundle account tokens in a release.
