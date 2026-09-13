import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "vite-plus/test";

import hook, {
  assertBundleUnsigned,
  findAppBundles,
  stripAdhocSignatures,
} from "./strip-adhoc-macos-signatures.cjs";

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

function makeSignedCopy() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doer-strip-test-"));
  const appDir = NodePath.join(root, "Foo.app", "Contents", "MacOS");
  NodeFS.mkdirSync(appDir, { recursive: true });
  const binary = NodePath.join(appDir, "Foo");
  NodeFS.copyFileSync(process.execPath, binary);
  NodeChildProcess.execFileSync("codesign", ["--force", "--sign", "-", binary], {
    stdio: "pipe",
  });
  return { root, app: NodePath.join(root, "Foo.app"), binary };
}

describe("strip-adhoc-macos-signatures", () => {
  it.skipIf(skipWithoutCodesign)(
    "strips ad-hoc seals so unsigned builds ship fully unsigned",
    () => {
      const { root, app, binary } = makeSignedCopy();
      const signatureOf = (target) =>
        NodeChildProcess.spawnSync("codesign", ["-dv", target], { encoding: "utf8" }).stderr;
      try {
        assert.match(signatureOf(binary), /Signature=adhoc/);
        assert.throws(() => assertBundleUnsigned(app));

        const stripped = stripAdhocSignatures(root);
        assert.deepEqual(stripped, [binary]);
        assertBundleUnsigned(app);
        assert.deepEqual(findAppBundles(root), [app]);
        assert.match(signatureOf(binary), /code object is not signed at all/);
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
  );

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
