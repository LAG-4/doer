/**
 * TelemetryConfigRoute - Public product-analytics configuration.
 *
 * `GET /api/telemetry/config` tells browsers where to send product analytics
 * (the operator's own PostHog instance) without baking an ingest URL into any
 * build. The project key and host are public by design: PostHog project keys
 * ship in client bundles. No identity, token, or secret is ever exposed here.
 *
 * When telemetry is disabled or no project key is configured, the route
 * reports `enabled: false` with blank host/key and browsers stay silent.
 *
 * @module TelemetryConfigRoute
 */
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { TelemetryPublicConfig } from "./AnalyticsService.ts";

export const TELEMETRY_CONFIG_ROUTE_PATH = "/api/telemetry/config";

export const telemetryConfigRouteLayer = HttpRouter.add(
  "GET",
  TELEMETRY_CONFIG_ROUTE_PATH,
  Effect.gen(function* () {
    const publicConfig = yield* TelemetryPublicConfig;
    const host = publicConfig.posthogHost.trim().replace(/\/+$/, "");
    const key = publicConfig.posthogKey.trim();
    const enabled = publicConfig.enabled && key !== "" && host !== "";
    return HttpServerResponse.jsonUnsafe({
      enabled,
      host: enabled ? host : "",
      key: enabled ? key : "",
    });
  }),
);
