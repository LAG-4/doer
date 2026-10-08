import { describe, expect, it } from "vite-plus/test";

import { buildSupportSummary } from "./buildSupportSummary";

describe("buildSupportSummary", () => {
  it("lists only the safe fields", () => {
    expect(
      buildSupportSummary({
        appVersion: "1.2.3",
        platform: "MacIntel",
        connection: "Connected (1 computer)",
      }),
    ).toBe(
      [
        "Doer support summary",
        "App version: 1.2.3",
        "Platform: MacIntel",
        "Connection: Connected (1 computer)",
        "Includes only: app version, platform, connection status.",
        "Includes no tokens, passwords, logs, file paths, or message contents.",
      ].join("\n"),
    );
  });

  it("keeps hostile input to one short line per field", () => {
    const summary = buildSupportSummary({
      appVersion: "1.2.3\nBearer secret-token",
      platform: "",
      connection: `ok\nsecond line ${"x".repeat(200)}`,
    });
    expect(summary).toContain("App version: 1.2.3");
    expect(summary).not.toContain("secret-token");
    expect(summary).toContain("Platform: unknown");
    for (const line of summary.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(120 + "Connection: ".length);
    }
  });
});
