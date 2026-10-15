// Free update signing establishes continuity between Doer releases. It does not
// provide Developer ID, notarization, or an Apple-verified publisher identity.
"use strict";

const { spawnSync } = require("node:child_process");
const { randomBytes, X509Certificate } = require("node:crypto");
const {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const adhoc = require("./adhoc-sign-macos-bundle.cjs");

const APP_ID = "click.lagaryan.doer";
const CERTIFICATE_PATH = join(__dirname, "resources/macos-update-signing.pem");

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000 });
  // execFileSync's default error includes arguments, including keychain and
  // PKCS#12 passwords. Never propagate it into CI logs.
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} failed: ${result.stderr?.trim() || result.error?.message || "unknown error"}`,
    );
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function readConfiguration(environment, certificatePath = CERTIFICATE_PATH) {
  const p12 = environment.DOER_MACOS_UPDATE_SIGNING_P12;
  const password = environment.DOER_MACOS_UPDATE_SIGNING_PASSWORD;
  if (!p12 && !password) {
    if (environment.DOER_REQUIRE_MACOS_UPDATE_SIGNING === "true") {
      throw new Error("Mac releases require the persistent Doer update-signing identity.");
    }
    return null;
  }
  if (!p12 || !password) {
    throw new Error("Both Doer macOS update-signing secrets are required.");
  }
  const encoded = p12.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error("The Doer update-signing PKCS#12 must be base64 encoded.");
  }
  const certificate = new X509Certificate(readFileSync(certificatePath));
  if (Date.parse(certificate.validTo) <= Date.now()) {
    throw new Error("The pinned Doer update-signing certificate has expired.");
  }
  return {
    p12: Buffer.from(encoded, "base64"),
    password,
    fingerprint: certificate.fingerprint.replaceAll(":", ""),
  };
}

/** Bundle seals follow their binaries, with nested bundles sealed first. */
function collectBundles(appPath) {
  const bundles = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      const child = join(directory, name);
      if (!lstatSync(child).isDirectory()) continue;
      visit(child);
    }
    if (/\.(?:app|framework|xpc|appex)$/.test(directory)) bundles.push(directory);
  };
  visit(appPath);
  return bundles;
}

function updateRequirement(fingerprint, identifier = APP_ID) {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(identifier)) {
    throw new Error("Invalid macOS update-signing bundle identifier.");
  }
  return `identifier "${identifier}" and certificate leaf = H"${fingerprint.toLowerCase()}"`;
}

function verifyUpdateSignature(appPath, fingerprint, identifier = APP_ID) {
  run("codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--all-architectures",
    "-R",
    `=${updateRequirement(fingerprint, identifier)}`,
    appPath,
  ]);
  const requirement = run("codesign", ["-d", "-r-", appPath]);
  if (
    requirement.includes("cdhash") ||
    !requirement.toLowerCase().includes(fingerprint.toLowerCase())
  ) {
    throw new Error("Mac update signature has no persistent certificate requirement.");
  }
}

async function signMacosUpdateBundleAfterPack(
  context,
  environment = process.env,
  certificatePath = CERTIFICATE_PATH,
) {
  if (!context || typeof context.appOutDir !== "string") {
    throw new Error("Mac update-signing hook received no appOutDir.");
  }
  const platformName = context.packager?.platform?.name;
  if (platformName !== undefined && platformName !== "mac") return;
  const configuration = readConfiguration(environment, certificatePath);
  if (!configuration) return adhoc.default(context);
  const identifier = context.packager?.appInfo?.id ?? APP_ID;
  const apps = adhoc.findAppBundles(context.appOutDir);
  if (apps.length === 0) throw new Error("Mac update-signing hook found no app bundle.");

  const directory = mkdtempSync(join(tmpdir(), "doer-update-signing-"));
  chmodSync(directory, 0o700);
  const keychain = join(directory, "signing.keychain-db");
  const p12Path = join(directory, "identity.p12");
  const keychainPassword = randomBytes(32).toString("base64url");
  let created = false;
  try {
    writeFileSync(p12Path, configuration.p12, { mode: 0o600 });
    run("security", ["create-keychain", "-p", keychainPassword, keychain]);
    created = true;
    run("security", ["unlock-keychain", "-p", keychainPassword, keychain]);
    run("security", [
      "import",
      p12Path,
      "-k",
      keychain,
      "-P",
      configuration.password,
      "-T",
      "/usr/bin/codesign",
    ]);
    run("security", [
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:,codesign:",
      "-s",
      "-k",
      keychainPassword,
      keychain,
    ]);
    const imported = run("security", ["find-certificate", "-a", "-Z", keychain]);
    if (!imported.toUpperCase().includes(configuration.fingerprint.toUpperCase())) {
      throw new Error("The Mac update-signing secret does not match the pinned certificate.");
    }
    const sign = (target, requirement) =>
      run("codesign", [
        "--force",
        "--sign",
        configuration.fingerprint,
        "--keychain",
        keychain,
        "--timestamp=none",
        ...(requirement ? ["--requirements", `=designated => ${requirement}`] : []),
        target,
      ]);
    for (const app of apps) {
      for (const binary of adhoc.sortMachOFilesDeepestFirst(adhoc.collectMachOFiles(app)))
        sign(binary);
      for (const bundle of collectBundles(app)) {
        sign(
          bundle,
          bundle === app ? updateRequirement(configuration.fingerprint, identifier) : undefined,
        );
      }
      verifyUpdateSignature(app, configuration.fingerprint, identifier);
    }
  } finally {
    try {
      if (created) run("security", ["delete-keychain", keychain]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

module.exports = {
  collectBundles,
  readConfiguration,
  updateRequirement,
  verifyUpdateSignature,
  default: signMacosUpdateBundleAfterPack,
};
