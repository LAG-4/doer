import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

// FORK (Doer): pins the fork's marketing identity. Upstream's marketing pages
// constantly gain T3-branded content (hero copy, endorsement marquee, store
// links, t3.codes canonical URLs) that must never ship on doer.lagaryan.click.
// Every upstream catch-up merge touches apps/marketing, so this test fails
// loudly when a conflict resolution accidentally keeps the upstream side.

const marketingDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readSource(relativePath: string): string {
  return readFileSync(join(marketingDir, relativePath), "utf8");
}

describe("doer marketing identity", () => {
  it("serves the Doer homepage, not the upstream T3 page", () => {
    const index = readSource("src/pages/index.astro");
    expect(index).toContain("boring work");
    expect(index).toContain("Doer is free forever");
    expect(index).toContain("What can you hand to Doer?");
    expect(index).not.toContain("control plane for coding agents");
    expect(index).not.toContain("pingdotgg/t3code");
    expect(index).not.toContain("MARKETING_STATS");
    expect(index).not.toContain("../lib/tweets");
    expect(index).not.toContain("Tolerated by over");
  });

  it("brands the layout as Doer with a fork credit, not T3 stats", () => {
    const layout = readSource("src/layouts/Layout.astro");
    expect(layout).toContain('title = "Doer"');
    expect(layout).toContain('content="Doer"');
    expect(layout).toContain('nav-brand-name">doer');
    expect(layout).toContain("Built on top of");
    expect(layout).not.toContain("MARKETING_STATS");
    expect(layout).not.toContain("twitter:site");
    expect(layout).not.toContain("GitHub stars");
  });

  it("points links and metadata at the fork, never upstream", () => {
    const site = readSource("src/lib/site.ts");
    expect(site).toContain("LAG-4/t3code");
    expect(site).not.toContain("pingdotgg");

    const astroConfig = readSource("astro.config.mjs");
    expect(astroConfig).toContain("doer.lagaryan.click");
    expect(astroConfig).not.toContain("t3.codes");

    const releases = readSource("src/lib/releases.ts");
    expect(releases).toContain("LAG-4/t3code");
    expect(releases).not.toContain("pingdotgg");

    // Deleted on purpose: upstream's endorsement marquee has no place on the
    // Doer site. A bad merge re-adds it alongside the T3 hero.
    expect(existsSync(join(marketingDir, "src/lib/tweets.ts"))).toBe(false);
  });

  it("keeps the download page fork-specific, without store listings", () => {
    const download = readSource("src/pages/download.astro");
    expect(download).toContain("Download Doer");
    expect(download).toContain("@lag4/doer-cli");
    expect(download).not.toContain("apps.apple.com");
    expect(download).not.toContain("play.google.com");
    expect(download).not.toContain("IOS_APP_STORE_URL");
    expect(download).not.toContain("ANDROID_PLAY_STORE_URL");
  });
});
