// electron-builder afterPack hook for UNSIGNED macOS builds (plain Node, no
// dependencies, so it loads inside electron-builder's own runtime).
//
// Background: Electron's prebuilt binaries ship with Apple's linker ad-hoc
// signature, but an unsigned Doer build has no bundle seal to bind it. Apple
// Silicon treats that half-sealed state as tampering and refuses to launch
// with "damaged, move to Bin" and no Open Anyway recourse. A fully unsigned
// bundle instead gets the standard unidentified-developer warning with an
// Open Anyway path (same as the Windows unsigned builds' SmartScreen flow).
// Only wired for unsigned mac builds; signed builds keep real signatures.
//
// The hook fails closed: after stripping, every .app under appOutDir must
// report "code object is not signed at all", or the build fails loudly
// instead of shipping another damaged-looking app.
"use strict";

const { execFileSync, spawnSync } = require("node:child_process");
const { openSync, readSync, closeSync, readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");

// Mach-O magic numbers (big- and little-endian, 32/64-bit, fat binaries).
const MACHO_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe]);

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

function runCodesign(args, target) {
  // codesign -dv reports to stderr regardless of exit code; capture both.
  const result = spawnSync("codesign", [...args, target], { encoding: "utf8" });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

/** Remove ad-hoc signatures from every Mach-O under rootDir. Returns stripped paths. */
function stripAdhocSignatures(rootDir) {
  const stripped = [];
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
      // Only ad-hoc linker signatures are expected here; a real identity
      // would mean this hook ran on the wrong build, so leave it alone and
      // let the unsigned gate below fail loudly instead.
      const before = runCodesign(["-dv"], full);
      if (!before.includes("Signature=adhoc")) continue;
      execFileSync("codesign", ["--remove-signature", full], { stdio: "pipe" });
      stripped.push(full);
    }
  };
  visit(rootDir);
  return stripped;
}

/** Throw unless the app bundle reports fully unsigned. */
function assertBundleUnsigned(appPath) {
  const output = runCodesign(["-dv"], appPath);
  if (!output.includes("code object is not signed at all")) {
    throw new Error(
      `Unsigned macOS build still carries a signature, refusing to ship it: ${appPath}\n${output}`,
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
  stripAdhocSignatures,
  assertBundleUnsigned,
  findAppBundles,
  default: async function stripAdhocSignaturesAfterPack(context) {
    if (context?.packager?.platform?.name !== "mac" || !context?.appOutDir) return;
    stripAdhocSignatures(context.appOutDir);
    for (const app of findAppBundles(context.appOutDir)) {
      assertBundleUnsigned(app);
    }
  },
};
