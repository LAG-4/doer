import { describe, expect, it, vi } from "vite-plus/test";

import {
  ExperimentalConnectionsRequestError,
  getExperimentalConnections,
  setExperimentalConnections,
  type ExperimentalConnectionsTransport,
} from "./experimentalConnections.ts";

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const transport = (fetchFn: typeof fetch): ExperimentalConnectionsTransport => ({
  baseUrl: "http://doer.test:13773/",
  fetchFn,
});

describe("experimentalConnections client", () => {
  it("reads the host toggle through the environment-relative URL", async () => {
    const fetchFn = vi.fn(async () => ok({ enabled: false }));
    await expect(getExperimentalConnections(transport(fetchFn))).resolves.toBe(false);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://doer.test:13773/api/doer-experimental-connections");
    expect(init.method).toBe("GET");
  });

  it("writes the host toggle", async () => {
    const fetchFn = vi.fn(async () => ok({ enabled: true }));
    await expect(setExperimentalConnections(transport(fetchFn), true)).resolves.toBe(true);
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ enabled: true }));
  });

  it("reports unreachable hosts in plain language", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("down");
    });
    await expect(getExperimentalConnections(transport(fetchFn))).rejects.toBeInstanceOf(
      ExperimentalConnectionsRequestError,
    );
  });

  it("calls fetch without a receiver so browser native fetch works", async () => {
    // Native fetch throws "Illegal invocation" when invoked as a method with
    // the wrong receiver. The client must never depend on the receiver.
    const fetchFn = function (this: unknown) {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      return Promise.resolve(ok({ enabled: true }));
    } as typeof fetch;
    await expect(getExperimentalConnections(transport(fetchFn))).resolves.toBe(true);
  });
});
