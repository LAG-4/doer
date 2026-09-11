import { describe, expect, it } from "@effect/vitest";

import { resolveSimpleModeEnabled } from "./simple-mode";

describe("resolveSimpleModeEnabled", () => {
  it("stays on by default, including while preferences load", () => {
    expect(resolveSimpleModeEnabled({ preference: undefined, preferencesLoaded: false })).toBe(
      true,
    );
    expect(resolveSimpleModeEnabled({ preference: undefined, preferencesLoaded: true })).toBe(true);
  });

  it("hides git controls until the device explicitly opts out", () => {
    expect(resolveSimpleModeEnabled({ preference: true, preferencesLoaded: true })).toBe(true);
    expect(resolveSimpleModeEnabled({ preference: false, preferencesLoaded: true })).toBe(false);
  });
});
