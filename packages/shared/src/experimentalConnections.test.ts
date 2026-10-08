import { describe, expect, it } from "vite-plus/test";

import {
  decodeExperimentalConnectionsStatus,
  EXPERIMENTAL_CONNECTIONS_COPY,
  EXPERIMENTAL_CONNECTIONS_ROUTE_PATH,
} from "./experimentalConnections.ts";

describe("experimentalConnections", () => {
  it("decodes the host status payload", () => {
    expect(decodeExperimentalConnectionsStatus({ enabled: true })).toEqual({ enabled: true });
    expect(decodeExperimentalConnectionsStatus({ enabled: false })).toEqual({ enabled: false });
  });

  it("rejects non-boolean payloads", () => {
    expect(() => decodeExperimentalConnectionsStatus({ enabled: "yes" })).toThrow();
    expect(() => decodeExperimentalConnectionsStatus({})).toThrow();
  });

  it("keeps the route host-scoped under /api", () => {
    expect(EXPERIMENTAL_CONNECTIONS_ROUTE_PATH).toBe("/api/doer-experimental-connections");
  });

  it("explains the single toggle without naming providers as ready", () => {
    expect(EXPERIMENTAL_CONNECTIONS_COPY.description).toMatch(/experimental/i);
    expect(EXPERIMENTAL_CONNECTIONS_COPY.toolDenied).toMatch(
      /Settings → Connected apps → Experimental connections/,
    );
  });
});
