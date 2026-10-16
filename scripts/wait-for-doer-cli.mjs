import * as NodeAssert from "node:assert/strict";

const version = process.argv[2];
NodeAssert.match(version ?? "", /^[0-9]+\.[0-9]+\.[0-9]+$/, "Expected a stable release version.");

// npm scans accepted publishes before they become installable:
// https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/
const deadline = Date.now() + 20 * 60 * 1000;
while (true) {
  const response = await fetch(
    "https://registry.npmjs.org/@lag4%2fdoer-cli?availability=" + Date.now(),
    {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (response.ok) {
    const pkg = (await response.json()).versions?.[version];
    if (pkg) {
      NodeAssert.equal(pkg.name, "@lag4/doer-cli");
      NodeAssert.equal(pkg.version, version);
      NodeAssert.ok(pkg.bin?.doer && pkg.bin?.["doer-cli"]);
      console.log("Matching CLI version is publicly available.");
      break;
    }
  }
  if (Date.now() >= deadline) {
    throw new Error(
      "Matching CLI is still unavailable after npm publication; check npm review notifications.",
    );
  }
  console.log("Waiting for npm publication scanning and registry availability...");
  await new Promise((resolve) => setTimeout(resolve, 20_000));
}
