#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Synchronous CI validation runs before any Effect runtime exists.

// CI validation for the unpacked Store package. Reads AppxManifest.xml from
// the unpacked .appx, maps the app version to the expected Store manifest
// quad internally (single mapping implementation), and checks the manifest
// against the expected Partner Center values passed via env (see
// .github/workflows/store-appx.yml). Optionally verifies the packed brand
// assets. Exits nonzero with the mismatch list; package existence alone is
// not evidence.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { findMissingStoreAppxAssets } from "./lib/store-appx-assets.ts";
import {
  resolveStoreAppxManifestVersion,
  validateStoreAppxManifestXml,
} from "./lib/store-appx-version.ts";

const args = process.argv.slice(2);
const manifestPath = args.find((arg) => !arg.startsWith("--"));
const appVersionFlag = args.indexOf("--app-version");
const assetsDirFlag = args.indexOf("--assets-dir");
const appVersion = appVersionFlag >= 0 ? (args[appVersionFlag + 1] ?? "") : "";
const assetsDir = assetsDirFlag >= 0 ? (args[assetsDirFlag + 1] ?? "") : "";
if (!manifestPath || !appVersion) {
  process.stderr.write(
    "Usage: validate-store-appx-manifest.ts <AppxManifest.xml> --app-version <x.y.z> [--assets-dir <unpack/assets>]\n",
  );
  process.exit(2);
}

let manifestVersion: string;
try {
  manifestVersion = resolveStoreAppxManifestVersion(appVersion);
} catch (error) {
  process.stderr.write(
    `manifest mismatch: cannot map app version to a Store version: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exit(1);
}

const expected = {
  identityName: process.env.STORE_APPX_EXPECTED_IDENTITY_NAME ?? "",
  publisher: process.env.STORE_APPX_EXPECTED_PUBLISHER ?? "",
  publisherDisplayName: process.env.STORE_APPX_EXPECTED_PUBLISHER_DISPLAY_NAME ?? "",
  displayName: process.env.STORE_APPX_EXPECTED_DISPLAY_NAME ?? "",
  version: manifestVersion,
  applicationId: process.env.STORE_APPX_EXPECTED_APPLICATION_ID ?? "Doer",
};

const problems = [
  ...validateStoreAppxManifestXml(NodeFS.readFileSync(manifestPath, "utf8"), expected),
];

if (assetsDir) {
  let present: ReadonlyArray<string> = [];
  try {
    present = NodeFS.readdirSync(assetsDir).filter((name) => {
      try {
        const stat = NodeFS.statSync(NodePath.join(assetsDir, name));
        return stat.isFile() && stat.size > 0;
      } catch {
        return false;
      }
    });
  } catch {
    present = [];
  }
  for (const missing of findMissingStoreAppxAssets(present)) {
    problems.push(
      `Packed payload is missing assets/${missing} (vendor defaults fail WACK branding).`,
    );
  }
}

if (problems.length > 0) {
  for (const problem of problems) {
    process.stderr.write(`manifest mismatch: ${problem}\n`);
  }
  process.exit(1);
}
process.stdout.write(`Store manifest valid: ${expected.identityName} ${expected.version}.\n`);
