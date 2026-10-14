import { describe, expect, it } from "vite-plus/test";

import { shouldHandleAppLink } from "./appLinking";

describe("shouldHandleAppLink", () => {
  it.each([
    "doer://",
    "doer:///",
    "doer-dev://",
    "doer-preview://",
    "t3code://",
    "t3code:///",
    "t3code-dev://",
    "t3code-preview://",
  ])(
    "ignores scheme-only URL %s",
    (url) => {
      expect(shouldHandleAppLink(url)).toBe(false);
    },
  );

  it.each([
    "doer://threads/env-1/thread-1",
    "doer://new?prompt=hello",
    "doer-preview://settings/usage?tab=limits",
    "t3code://threads/env-1/thread-1",
    "t3code://pair?pairingUrl=x",
    "t3code-dev://settings/usage?tab=limits",
  ])("handles path-bearing URL %s", (url) => {
    expect(shouldHandleAppLink(url)).toBe(true);
  });

  it.each([
    "doer-dev://expo-development-client/?url=x",
    "doer://expo-sharing/anything",
    "t3code://expo-development-client/?url=x",
    "t3code://expo-sharing/anything",
  ])(
    "ignores lifecycle URL %s",
    (url) => {
      expect(shouldHandleAppLink(url)).toBe(false);
    },
  );
});
