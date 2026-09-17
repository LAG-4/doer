import { describe, expect, it } from "vite-plus/test";

import {
  markInboxProvisioning,
  readInboxProvisioning,
  unmarkInboxProvisioning,
} from "./inboxProvisioning";

describe("readInboxProvisioning", () => {
  it("is idle without marks", () => {
    expect(readInboxProvisioning("probe-idle")).toBe(false);
    expect(readInboxProvisioning(null)).toBe(false);
  });

  it("reflects mark and unmark", () => {
    markInboxProvisioning("probe-flip");
    try {
      expect(readInboxProvisioning("probe-flip")).toBe(true);
      expect(readInboxProvisioning("probe-other")).toBe(false);
      expect(readInboxProvisioning(null)).toBe(false);
    } finally {
      unmarkInboxProvisioning("probe-flip");
    }
    expect(readInboxProvisioning("probe-flip")).toBe(false);
  });

  it("tolerates duplicate marks and stray unmarks", () => {
    markInboxProvisioning("probe-dupe");
    markInboxProvisioning("probe-dupe");
    unmarkInboxProvisioning("probe-dupe");
    expect(readInboxProvisioning("probe-dupe")).toBe(false);
    unmarkInboxProvisioning("probe-never-marked");
    expect(readInboxProvisioning("probe-never-marked")).toBe(false);
  });
});
