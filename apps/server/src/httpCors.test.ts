import { describe, expect, it } from "vite-plus/test";

import { browserApiCorsAllowedHeaders, browserApiCorsAllowedMethods } from "./httpCors.ts";

describe("browser api cors", () => {
  it("permits the settings memory methods remote browsers need", () => {
    // The memory Settings UI issues credentialed GET/POST/PATCH/DELETE from
    // remote browsers; a missing method fails preflight before auth runs.
    for (const method of ["GET", "POST", "PATCH", "DELETE", "OPTIONS"] as const) {
      expect(browserApiCorsAllowedMethods).toContain(method);
    }
    expect(browserApiCorsAllowedHeaders).toContain("authorization");
    expect(browserApiCorsAllowedHeaders).toContain("content-type");
  });
});
