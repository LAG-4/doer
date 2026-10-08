import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ExperimentalConnectionsTransport } from "@t3tools/client-runtime/experimental-connections";

import {
  readExperimentalConnectionsSnapshot,
  refreshExperimentalConnections,
  resetExperimentalConnectionsStore,
  saveExperimentalConnections,
  subscribeExperimentalConnections,
} from "./experimentalConnectionsStore";

const KEY = "computer-1";

function transport(fetchFn: typeof fetch): ExperimentalConnectionsTransport {
  return { baseUrl: "http://doer.test:13773", fetchFn };
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const failing = () =>
  new Response(JSON.stringify({ error: "internal_error", message: "Disk is unavailable." }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  resetExperimentalConnectionsStore();
});

describe("experimentalConnectionsStore", () => {
  it("starts unknown and notifies every subscriber after a successful save", async () => {
    expect(readExperimentalConnectionsSnapshot(KEY).enabled).toBeNull();
    const seen: Array<boolean | null> = [];
    const first = subscribeExperimentalConnections(KEY, () => {
      seen.push(readExperimentalConnectionsSnapshot(KEY).enabled);
    });
    const second = subscribeExperimentalConnections(KEY, () => {
      seen.push(readExperimentalConnectionsSnapshot(KEY).enabled);
    });
    try {
      const fetchFn = vi.fn(async () => ok({ enabled: true }));
      expect(await saveExperimentalConnections(KEY, transport(fetchFn), true)).toBe(true);
      const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("http://doer.test:13773/api/doer-experimental-connections");
      expect(init.method).toBe("POST");
      expect(readExperimentalConnectionsSnapshot(KEY).enabled).toBe(true);
      // Both mounted consumers observed the change.
      expect(seen).toContain(true);
    } finally {
      first();
      second();
    }
  });

  it("ignores a stale load that resolves after a newer save", async () => {
    let resolveSlow: ((response: Response) => void) | null = null;
    const slow = new Promise<Response>((resolve) => {
      resolveSlow = resolve;
    });
    const fetchFn = vi.fn(async () => slow);
    const load = refreshExperimentalConnections(KEY, transport(fetchFn));
    // A newer save wins while the first GET is still in flight.
    const saveFetch = vi.fn(async () => ok({ enabled: true }));
    expect(await saveExperimentalConnections(KEY, transport(saveFetch), true)).toBe(true);
    resolveSlow!(ok({ enabled: false }));
    await load;
    expect(readExperimentalConnectionsSnapshot(KEY).enabled).toBe(true);
  });

  it("clears to unknown and reports save failures", async () => {
    const loadFetch = vi.fn(async () => ok({ enabled: false }));
    await refreshExperimentalConnections(KEY, transport(loadFetch));
    expect(readExperimentalConnectionsSnapshot(KEY).enabled).toBe(false);
    const saveFetch = vi.fn(async () => failing());
    expect(await saveExperimentalConnections(KEY, transport(saveFetch), true)).toBe(false);
    // Fail closed: unknown until revalidation, never a guessed `true`.
    // The error stays visible instead of vanishing.
    expect(readExperimentalConnectionsSnapshot(KEY).enabled).toBeNull();
    expect(readExperimentalConnectionsSnapshot(KEY).error).toContain("Disk is unavailable");
    // Revalidation restores the confirmed value and clears the error.
    const reloadFetch = vi.fn(async () => ok({ enabled: false }));
    await refreshExperimentalConnections(KEY, transport(reloadFetch));
    expect(readExperimentalConnectionsSnapshot(KEY).enabled).toBe(false);
    expect(readExperimentalConnectionsSnapshot(KEY).error).toBeNull();
  });

  it("never implies enabled after a failed disable", async () => {
    // The service fails closed to off on storage failure, so a stale
    // `true` must not survive a failed disable in plugin menus or search.
    const loadFetch = vi.fn(async () => ok({ enabled: true }));
    await refreshExperimentalConnections(KEY, transport(loadFetch));
    expect(readExperimentalConnectionsSnapshot(KEY).enabled).toBe(true);
    const saveFetch = vi.fn(async () => failing());
    expect(await saveExperimentalConnections(KEY, transport(saveFetch), false)).toBe(false);
    expect(readExperimentalConnectionsSnapshot(KEY).enabled).toBeNull();
    expect(readExperimentalConnectionsSnapshot(KEY).error).toContain("Disk is unavailable");
  });
});
