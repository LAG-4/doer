import * as NodeChildProcess from "node:child_process";
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "vite-plus/test";

import adhoc from "./adhoc-sign-macos-bundle.cjs";
import signer, { readConfiguration, updateRequirement } from "./sign-macos-update-bundle.cjs";

const APP_ID = "click.lagaryan.doer";
const canSign = NodeChildProcess.spawnSync("which", ["codesign"], { stdio: "ignore" }).status === 0;

function command(executable, args, check = true) {
  const result = NodeChildProcess.spawnSync(executable, args, { encoding: "utf8" });
  if (check && result.status !== 0) {
    throw new Error(`${executable} failed: ${result.stderr}`);
  }
  return result;
}

function createIdentity(root, name) {
  const directory = NodePath.join(root, name);
  NodeFS.mkdirSync(directory);
  const certificatePath = NodePath.join(directory, "certificate.pem");
  const password = NodeCrypto.randomBytes(24).toString("hex");
  const passwordFile = NodePath.join(directory, "password");
  NodeFS.writeFileSync(passwordFile, password, { mode: 0o600 });
  const config = NodePath.join(directory, "openssl.cnf");
  NodeFS.writeFileSync(
    config,
    [
      "[req]",
      "distinguished_name=dn",
      "prompt=no",
      "x509_extensions=extensions",
      "[dn]",
      "CN=Doer Update Signing Test",
      "[extensions]",
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature",
      "extendedKeyUsage=critical,codeSigning",
      "",
    ].join("\n"),
  );
  command("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-config",
    config,
    "-keyout",
    NodePath.join(directory, "key.pem"),
    "-out",
    certificatePath,
  ]);
  const p12 = NodePath.join(directory, "identity.p12");
  command("openssl", [
    "pkcs12",
    "-export",
    "-keypbe",
    "PBE-SHA1-3DES",
    "-certpbe",
    "PBE-SHA1-3DES",
    "-macalg",
    "sha1",
    "-inkey",
    NodePath.join(directory, "key.pem"),
    "-in",
    certificatePath,
    "-out",
    p12,
    "-passout",
    `file:${passwordFile}`,
  ]);
  const fingerprint = new NodeCrypto.X509Certificate(
    NodeFS.readFileSync(certificatePath),
  ).fingerprint.replaceAll(":", "");
  return {
    certificatePath,
    fingerprint,
    environment: {
      DOER_MACOS_UPDATE_SIGNING_P12: NodeFS.readFileSync(p12).toString("base64"),
      DOER_MACOS_UPDATE_SIGNING_PASSWORD: password,
      DOER_REQUIRE_MACOS_UPDATE_SIGNING: "true",
    },
  };
}

function createBundle(parent, version, identifier = APP_ID) {
  const app = NodePath.join(parent, "Doer.app");
  const contents = NodePath.join(app, "Contents");
  NodeFS.mkdirSync(NodePath.join(contents, "MacOS"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(contents, "Resources"));
  NodeFS.copyFileSync(
    process.execPath,
    NodePath.join(contents, "MacOS/Doer"),
    NodeFS.constants.COPYFILE_FICLONE,
  );
  NodeFS.writeFileSync(
    NodePath.join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleExecutable</key><string>Doer</string>
<key>CFBundleName</key><string>Doer</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>${version}</string>
</dict></plist>`,
  );
  NodeFS.writeFileSync(NodePath.join(contents, "Resources/version.txt"), version);
  return app;
}

function context(directory, identifier = APP_ID) {
  return {
    appOutDir: directory,
    packager: { platform: { name: "mac" }, appInfo: { id: identifier } },
  };
}

describe("Mac update signing", () => {
  it("refuses incomplete release identities instead of falling back to ad-hoc signing", () => {
    assert.equal(readConfiguration({}), null);
    assert.throws(
      () => readConfiguration({ DOER_REQUIRE_MACOS_UPDATE_SIGNING: "true" }),
      /persistent/,
    );
    assert.throws(() => readConfiguration({ DOER_MACOS_UPDATE_SIGNING_P12: "YQ==" }), /Both/);
    assert.throws(
      () => readConfiguration({ DOER_MACOS_UPDATE_SIGNING_PASSWORD: "password" }),
      /Both/,
    );
    assert.throws(
      () =>
        readConfiguration({
          DOER_MACOS_UPDATE_SIGNING_P12: "not base64!",
          DOER_MACOS_UPDATE_SIGNING_PASSWORD: "password",
        }),
      /base64/,
    );
  });

  it("rejects invalid identifiers before creating a signing requirement", () => {
    assert.throws(() => updateRequirement("1234", 'bad" or true'), /identifier/);
  });

  it.skipIf(!canSign)(
    "accepts a new version from the pinned signer and rejects tampered content",
    async () => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doer-update-signing-test-"));
      const searchBefore = command("security", ["list-keychains", "-d", "user"]).stdout;
      try {
        const identity = createIdentity(root, "identity");
        const oldDirectory = NodePath.join(root, "old");
        const newDirectory = NodePath.join(root, "new");
        const oldApp = createBundle(oldDirectory, "1.0.0");
        const newApp = createBundle(newDirectory, "1.0.1");
        const helperParent = NodePath.join(newApp, "Contents/Frameworks");
        createBundle(helperParent, "1.0.1", `${APP_ID}.helper`);
        await signer.default(context(oldDirectory), identity.environment, identity.certificatePath);
        await signer.default(context(newDirectory), identity.environment, identity.certificatePath);
        const requirement = `=${updateRequirement(identity.fingerprint)}`;
        command("codesign", ["--verify", "--deep", "--strict", "-R", requirement, oldApp]);
        command("codesign", ["--verify", "--deep", "--strict", "-R", requirement, newApp]);
        NodeFS.writeFileSync(NodePath.join(newApp, "Contents/Resources/version.txt"), "tampered");
        assert.notEqual(
          command("codesign", ["--verify", "--deep", "--strict", "-R", requirement, newApp], false)
            .status,
          0,
        );
      } finally {
        assert.equal(command("security", ["list-keychains", "-d", "user"]).stdout, searchBefore);
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!canSign)(
    "rejects replacement keys even when their certificate names match",
    async () => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doer-update-key-test-"));
      try {
        const pinned = createIdentity(root, "pinned");
        const replacement = createIdentity(root, "replacement");
        const output = NodePath.join(root, "output");
        const app = createBundle(output, "1.0.1");
        await NodeAssert.rejects(
          signer.default(context(output), replacement.environment, pinned.certificatePath),
          /does not match the pinned certificate/,
        );
        await signer.default(context(output), replacement.environment, replacement.certificatePath);
        assert.notEqual(
          command(
            "codesign",
            [
              "--verify",
              "--deep",
              "--strict",
              "-R",
              `=${updateRequirement(pinned.fingerprint)}`,
              app,
            ],
            false,
          ).status,
          0,
        );
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!canSign)(
    "keeps local builds launchable and confirms ad-hoc installs need migration",
    async () => {
      const root = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "doer-update-migration-test-"),
      );
      try {
        const identity = createIdentity(root, "identity");
        const oldDirectory = NodePath.join(root, "old");
        const newDirectory = NodePath.join(root, "new");
        const oldApp = createBundle(oldDirectory, "1.0.0");
        const newApp = createBundle(newDirectory, "1.0.1");
        await signer.default(context(oldDirectory), {});
        adhoc.assertBundleAdhocSealed(oldApp);
        const described = command("codesign", ["-d", "-r-", oldApp]);
        const oldRequirement = /designated => ([^\r\n]+)/.exec(
          `${described.stdout}\n${described.stderr}`,
        )?.[1];
        assert.isString(oldRequirement);
        await signer.default(context(newDirectory), identity.environment, identity.certificatePath);
        assert.notEqual(
          command(
            "codesign",
            ["--verify", "--deep", "--strict", "-R", `=${oldRequirement}`, newApp],
            false,
          ).status,
          0,
        );
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
