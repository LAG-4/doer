import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("posthog-js/dist/module.full.js", () => ({
  default: { init: vi.fn(), register: vi.fn() },
}));

async function loadModule() {
  const analytics = await import("./productAnalytics");
  const posthog = (
    (await import("posthog-js/dist/module.full.js")) as unknown as {
      default: {
        init: ReturnType<typeof vi.fn>;
        register: ReturnType<typeof vi.fn>;
      };
    }
  ).default;
  return { analytics, posthog };
}

function stubBrowser(options?: { readonly doNotTrack?: string }) {
  vi.stubGlobal("window", {
    location: new URL("http://localhost:3773/"),
  });
  vi.stubGlobal("navigator", { doNotTrack: options?.doNotTrack ?? null });
}

function stubFetchJson(body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function flushAnalyticsStart() {
  // initProductAnalytics boots through fetch + a dynamic import; two macrotask
  // turns settle both legs deterministically.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.resetModules();
  stubBrowser();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("productAnalytics", () => {
  it("stays silent when the server reports telemetry disabled", async () => {
    stubFetchJson({ enabled: false, host: "", key: "" });
    const { analytics, posthog } = await loadModule();

    analytics.initProductAnalytics();
    await flushAnalyticsStart();

    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.register).not.toHaveBeenCalled();
  });

  it("stays silent when the config fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const { analytics, posthog } = await loadModule();

    analytics.initProductAnalytics();
    await flushAnalyticsStart();

    expect(posthog.init).not.toHaveBeenCalled();
  });

  it("respects Do Not Track without contacting the server", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    stubBrowser({ doNotTrack: "1" });
    const { analytics, posthog } = await loadModule();

    analytics.initProductAnalytics();
    await flushAnalyticsStart();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(posthog.init).not.toHaveBeenCalled();
  });

  it("initializes replay, autocapture, and exception capture when enabled", async () => {
    stubFetchJson({
      enabled: true,
      host: "https://analytics.example.test",
      key: "phc_test_key",
    });
    const { analytics, posthog } = await loadModule();

    analytics.initProductAnalytics();
    await flushAnalyticsStart();

    expect(posthog.init).toHaveBeenCalledOnce();
    const [key, options] = posthog.init.mock.calls[0] as [string, Record<string, unknown>];
    expect(key).toBe("phc_test_key");
    expect(options).toMatchObject({
      api_host: "https://analytics.example.test",
      person_profiles: "always",
      autocapture: true,
      capture_pageview: true,
      capture_pageleave: true,
      capture_exceptions: true,
    });
    expect(options["session_recording"]).toMatchObject({ maskAllInputs: true });
    expect(typeof options["sanitize_properties"]).toBe("function");
    expect(posthog.register).toHaveBeenCalledWith(expect.objectContaining({ surface: "web" }));
  });

  it("scrubs query strings and fragments from tracked URLs", async () => {
    stubFetchJson({
      enabled: true,
      host: "https://analytics.example.test",
      key: "phc_test_key",
    });
    const { analytics, posthog } = await loadModule();

    analytics.initProductAnalytics();
    await flushAnalyticsStart();

    const options = posthog.init.mock.calls[0]?.[1] as {
      sanitize_properties: (
        properties: Record<string, unknown>,
        eventName: string,
      ) => Record<string, unknown>;
    };
    expect(
      options.sanitize_properties(
        {
          $current_url: "http://localhost:3773/?token=secret#/thread/1",
          $referrer: "http://localhost:3773/pair?next=/settings",
          clicked: "save",
        },
        "$autocapture",
      ),
    ).toEqual({
      $current_url: "http://localhost:3773/",
      $referrer: "http://localhost:3773/pair",
      clicked: "save",
    });
    expect(analytics.stripUrlSecrets("http://localhost:3773/")).toBe("http://localhost:3773/");
  });
});
