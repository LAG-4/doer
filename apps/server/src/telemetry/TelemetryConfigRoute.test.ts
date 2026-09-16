import { afterEach, describe, expect, it } from "vite-plus/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";

import { TELEMETRY_CONFIG_ROUTE_PATH, telemetryConfigRouteLayer } from "./TelemetryConfigRoute.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const fixture = (env: Record<string, string | boolean>) => {
  const { handler, dispose } = HttpRouter.toWebHandler(
    telemetryConfigRouteLayer.pipe(
      Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return handler;
};

describe("telemetry config route", () => {
  it("publishes the ingest host and key when telemetry is configured", async () => {
    const handler = fixture({
      T3CODE_TELEMETRY_ENABLED: true,
      T3CODE_POSTHOG_KEY: "phc_test_key",
      T3CODE_POSTHOG_HOST: "https://analytics.example.test///",
    });

    const response = await handler(new Request(`http://t3.test${TELEMETRY_CONFIG_ROUTE_PATH}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      enabled: true,
      host: "https://analytics.example.test",
      key: "phc_test_key",
    });
  });

  it("reports disabled with blank host and key when the kill switch is off", async () => {
    const handler = fixture({
      T3CODE_TELEMETRY_ENABLED: false,
      T3CODE_POSTHOG_KEY: "phc_test_key",
      T3CODE_POSTHOG_HOST: "https://analytics.example.test",
    });

    const response = await handler(new Request(`http://t3.test${TELEMETRY_CONFIG_ROUTE_PATH}`));
    expect(await response.json()).toEqual({ enabled: false, host: "", key: "" });
  });
});
