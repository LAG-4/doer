// Doer distributes its CLI through npm. Do not stage upstream installers,
// which download T3's standalone archives and install the upstream product.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const marketingDir = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
const publicDir = NodePath.join(marketingDir, "public");
NodeFS.mkdirSync(publicDir, { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(publicDir, "install.sh"),
  `#!/bin/sh
set -eu
if ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' 'Install Node.js with npm first: https://nodejs.org/' >&2
  exit 1
fi
doer_version="\${DOER_VERSION:-latest}"
npm install -g "@lag4/doer-cli@$doer_version"
printf '%s\n' 'Doer is installed. Run doer to start.'
`,
);
NodeFS.writeFileSync(
  NodePath.join(publicDir, "install.ps1"),
  `$ErrorActionPreference = "Stop"
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "Install Node.js with npm first: https://nodejs.org/"
}
$doerVersion = if ($env:DOER_VERSION) { $env:DOER_VERSION } else { "latest" }
& npm install -g "@lag4/doer-cli@$doerVersion"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "Doer is installed. Run doer to start."
`,
);
