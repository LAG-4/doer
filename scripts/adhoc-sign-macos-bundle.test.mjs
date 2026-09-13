import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "vite-plus/test";

import hook, {
  assertBundleAdhocSealed,
  collectMachOFiles,
  findAppBundles,
  sortMachOFilesDeepestFirst,
} from "./adhoc-sign-macos-bundle.cjs";

const hasCodesign = (() => {
  try {
    NodeChildProcess.execFileSync("codesign", ["-v"], { stdio: "pipe" });
    return true;
  } catch {
    try {
      NodeChildProcess.execFileSync("which", ["codesign"], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }
})();

const skipWithoutCodesign = !hasCodesign;

function makeUnsignedBundle() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doer-adhoc-test-"));
  const appDir = NodePath.join(root, "Foo.app", "Contents", "MacOS");
  NodeFS.mkdirSync(appDir, { recursive: true });
  const binary = NodePath.join(appDir, "Foo");
  NodeFS.copyFileSync(process.execPath, binary);
  // Start from the state unsigned release builds are in: Electron's prebuilt
  // binaries carry linker signatures but the staged bundle has no seal.
  try {
    NodeChildProcess.execFileSync("codesign", ["--remove-signature", binary], {
      stdio: "pipe",
    });
  } catch {
    // Already unsigned (e.g. a Linux-built test binary): nothing to strip.
  }
  return { root, app: NodePath.join(root, "Foo.app"), binary };
}

describe("adhoc-sign-macos-bundle", () => {
  it.skipIf(skipWithoutCodesign)(
    "ad-hoc seals unsigned builds so Gatekeeper offers Open Anyway",
    async () => {
      const { root, app, binary } = makeUnsignedBundle();
      const signatureOf = (target) =>
        NodeChildProcess.spawnSync("codesign", ["-dv", target], { encoding: "utf8" }).stderr;
      try {
        assert.match(signatureOf(binary), /not signed at all/);
        assert.throws(() => assertBundleAdhocSealed(app));

        await hook.default({ packager: { platform: { name: "mac" } }, appOutDir: root });

        assert.deepEqual(collectMachOFiles(root), [NodeFS.realpathSync(binary)]);
        assert.deepEqual(findAppBundles(root), [app]);
        assert.match(signatureOf(binary), /Signature=adhoc/);
        assertBundleAdhocSealed(app);
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("orders Mach-O files deepest-first for inside-out signing", () => {
    // Regression test: the macOS x64 build failed with "code object is not
    // signed at all / In subcomponent: .../Helpers/chrome_crashpad_handler"
    // because the enclosing Electron Framework binary was signed before its
    // nested helper. Nested components must come first.
    const frameworkDir =
      "/stage/Doer.app/Contents/Frameworks/Electron Framework.framework/Versions/A";
    const frameworkBinary = `${frameworkDir}/Electron Framework`;
    const helper = `${frameworkDir}/Helpers/chrome_crashpad_handler`;
    const dylib = `${frameworkDir}/Libraries/libffmpeg.dylib`;
    const mainBinary = "/stage/Doer.app/Contents/MacOS/Doer";
    assert.deepEqual(sortMachOFilesDeepestFirst([frameworkBinary, mainBinary, dylib, helper]), [
      helper,
      dylib,
      frameworkBinary,
      mainBinary,
    ]);
  });

  it("ignores non-mac packaging contexts", async () => {
    await hook.default({ packager: { platform: { name: "win32" } }, appOutDir: "/nonexistent" });
    for (const badContext of [
      undefined,
      { packager: { platform: { name: "mac" } }, appOutDir: "/nonexistent" },
    ]) {
      let threw = false;
      try {
        await hook.default(badContext);
      } catch {
        threw = true;
      }
      assert.equal(threw, true);
    }
  });
});
