// electron-builder afterPack hook for UNSIGNED macOS builds (plain Node, no
// dependencies, so it loads inside electron-builder's own runtime).
//
// Background: an unsigned Doer build must still carry a complete ad-hoc
// signature seal. Electron's prebuilt binaries ship with linker ad-hoc
// signatures but no bundle seal, and electron-builder adds files (Info.plist,
// app.asar, resources) without sealing. Apple Silicon Gatekeeper reads that
// half-sealed state as tampering and refuses to launch with "damaged, move to
// Bin" and no Open Anyway recourse. Shipping fully unsigned is worse: recent
// macOS denies execution of unsigned code entirely (kernel ASP:
// "Security policy would not allow process"), even after Open Anyway.
//
// So this hook ad-hoc seals the finished bundle, mirroring the dev flow
// (apps/desktop/scripts/electron-launcher.mjs): first every Mach-O gets its
// own ad-hoc signature (`codesign --deep` does NOT cover loose dylibs such as
// Electron Framework's libffmpeg — without one dyld refuses to load it into
// the signed process), then each .app gets a `--deep` seal binding everything.
// The result is the standard unidentified-developer warning with a working
// Open Anyway path. Only wired for unsigned mac builds; signed builds keep
// their real signatures.
"use strict";

const { execFileSync, spawnSync } = require("node:child_process");
const { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } = require("node:fs");
const { join } = require("node:path");

// Mach-O magic numbers (big- and little-endian, 32/64-bit, fat binaries).
const MACHO_MAGICS = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xcafebabf,
]);

function isMachO(filePath) {
  let fd = -1;
  try {
    fd = openSync(filePath, "r");
    const header = Buffer.alloc(4);
    if (readSync(fd, header, 0, 4, 0) !== 4) return false;
    return MACHO_MAGICS.has(header.readUInt32BE(0));
  } catch {
    return false;
  } finally {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors on files we only probed.
      }
    }
  }
}

/** Collect every Mach-O under rootDir, deduplicated by real path (framework version symlinks alias the same files). */
function collectMachOFiles(rootDir) {
  const found = new Set();
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        visit(full);
        continue;
      }
      if (!stat.isFile() || !isMachO(full)) continue;
      try {
        found.add(realpathSync(full));
      } catch {
        // Unresolvable path: leave it for the strict verify below to reject.
        found.add(full);
      }
    }
  };
  visit(rootDir);
  return [...found];
}

/** Ad-hoc sign one Mach-O file. */
function adhocSignFile(filePath) {
  execFileSync("codesign", ["--force", "--sign", "-", filePath], { stdio: "pipe" });
}

/**
 * Order Mach-O files deepest-first so nested components are signed before
 * the binaries that enclose them (inside-out). codesign refuses to sign an
 * enclosing binary while a nested component is still unsigned ("code object
 * is not signed at all / In subcomponent: .../Helpers/chrome_crashpad_handler"),
 * which broke the macOS x64 build while arm64 passed by luck of readdir order.
 */
function sortMachOFilesDeepestFirst(files) {
  const depthOf = (filePath) => filePath.split(/[/\\]/).length;
  return [...files].sort((a, b) => {
    const depthDelta = depthOf(b) - depthOf(a);
    if (depthDelta !== 0) return depthDelta;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** Ad-hoc seal one .app bundle, binding every nested component. */
function sealAppBundle(appPath) {
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "pipe" });
}

/** Throw unless the app bundle verifies strictly (every nested component sealed). */
function assertBundleAdhocSealed(appPath) {
  const verify = spawnSync("codesign", ["--verify", "--deep", "--strict", appPath], {
    encoding: "utf8",
  });
  const detail = `${verify.stdout ?? ""}${verify.stderr ?? ""}`.trim();
  if (verify.status !== 0) {
    throw new Error(
      `Unsigned macOS build failed strict ad-hoc verification, refusing to ship it: ${appPath}\n${detail}`,
    );
  }
  const describe = spawnSync("codesign", ["-dv", appPath], { encoding: "utf8" });
  const output = `${describe.stdout ?? ""}${describe.stderr ?? ""}`;
  if (!output.includes("Signature=adhoc")) {
    throw new Error(
      `Unsigned macOS build is not ad-hoc sealed, refusing to ship it: ${appPath}\n${output}`,
    );
  }
}

function findAppBundles(appOutDir) {
  let entries;
  try {
    entries = readdirSync(appOutDir);
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.endsWith(".app")).map((entry) => join(appOutDir, entry));
}

module.exports = {
  collectMachOFiles,
  adhocSignFile,
  sortMachOFilesDeepestFirst,
  sealAppBundle,
  assertBundleAdhocSealed,
  findAppBundles,
  default: async function adhocSignMacosBundleAfterPack(context) {
    // Fail closed on a miswired hook: shipping the half-sealed state is
    // exactly the "damaged on Apple Silicon" bug this exists to prevent.
    if (!context || typeof context.appOutDir !== "string") {
      throw new Error("adhoc-sign-macos-bundle afterPack hook received no appOutDir.");
    }
    const platformName = context.packager?.platform?.name;
    if (platformName !== undefined && platformName !== "mac") return;
    for (const file of sortMachOFilesDeepestFirst(collectMachOFiles(context.appOutDir))) {
      adhocSignFile(file);
    }
    const apps = findAppBundles(context.appOutDir);
    if (apps.length === 0) {
      throw new Error(`adhoc-sign-macos-bundle found no .app bundle under ${context.appOutDir}.`);
    }
    for (const app of apps) {
      sealAppBundle(app);
    }
    for (const app of apps) {
      assertBundleAdhocSealed(app);
    }
  },
};
