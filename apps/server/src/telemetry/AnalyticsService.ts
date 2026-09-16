/**
 * PostHog product telemetry service.
 *
 * Persists an installation-scoped anonymous identifier, buffers events in
 * memory, and flushes batches over Effect's HTTP client to the Doer PostHog
 * Cloud project. The project key and ingest host below are public by design
 * (they also ship in client bundles) and can be overridden with
 * T3CODE_POSTHOG_KEY / T3CODE_POSTHOG_HOST.
 *
 * @module AnalyticsService
 */
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import type { ClientOs } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import { getTelemetryIdentifier } from "./Identify.ts";

interface BufferedAnalyticsEvent {
  readonly event: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly capturedAt: string;
}

/**
 * TelemetryPublicConfig - The subset of telemetry settings that is safe to
 * share with browsers: the feature flag plus the PostHog project key and
 * host, both of which are public by design (they ship in client bundles).
 * The browser SDK reads them from GET /api/telemetry/config at runtime so no
 * ingest URL is ever baked into a build.
 */
export const TelemetryPublicConfig = Config.all({
  posthogKey: Config.string("T3CODE_POSTHOG_KEY").pipe(
    Config.withDefault("phc_tZ8tQXasmJMxeE4HtdGgZy5jxaCxLTLBbGCR5utaKNVx"),
  ),
  posthogHost: Config.string("T3CODE_POSTHOG_HOST").pipe(
    Config.withDefault("https://us.i.posthog.com"),
  ),
  enabled: Config.boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.withDefault(true)),
});

const TelemetryEnvConfig = Config.all({
  public: TelemetryPublicConfig,
  processPersonProfile: Config.boolean("T3CODE_POSTHOG_PERSON_PROFILES").pipe(
    Config.withDefault(true),
  ),
  flushBatchSize: Config.number("T3CODE_TELEMETRY_FLUSH_BATCH_SIZE").pipe(Config.withDefault(20)),
  maxBufferedEvents: Config.number("T3CODE_TELEMETRY_MAX_BUFFERED_EVENTS").pipe(
    Config.withDefault(1_000),
  ),
  wslDistroName: Config.string("WSL_DISTRO_NAME").pipe(Config.option),
});

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    /** Record an anonymous event for best-effort buffered delivery. */
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;

    /**
     * Record an exception for PostHog error tracking as a `$exception`
     * event. Never throws; delivery is best-effort like any other event.
     */
    readonly captureException: (
      error: unknown,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;

    /** Flush all currently queued telemetry events. */
    readonly flush: Effect.Effect<void>;
  }
>()("@lag4/doer-cli/telemetry/AnalyticsService") {
  /** No-op layer for callers that intentionally disable telemetry. */
  static readonly layerTest = Layer.succeed(
    AnalyticsService,
    AnalyticsService.of({
      record: () => Effect.void,
      captureException: () => Effect.void,
      flush: Effect.void,
    }),
  );
}

function serverOsFromNodePlatform(platform: string): ClientOs {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    case "android":
      return "Android";
    default:
      return "other";
  }
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const telemetryConfig = yield* TelemetryEnvConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const identifier = yield* getTelemetryIdentifier;
  const bufferRef = yield* Ref.make<ReadonlyArray<BufferedAnalyticsEvent>>([]);
  const clientType = serverConfig.mode === "desktop" ? "desktop-app" : "cli-web-client";
  const hostPlatform = yield* HostProcessPlatform;
  const hostArchitecture = yield* HostProcessArchitecture;

  const enqueueBufferedEvent = (event: string, properties?: Readonly<Record<string, unknown>>) =>
    Effect.flatMap(DateTime.now, (now) =>
      Ref.modify(bufferRef, (current) => {
        const appended = [
          ...current,
          {
            event,
            ...(properties ? { properties } : {}),
            capturedAt: DateTime.formatIso(now),
          } satisfies BufferedAnalyticsEvent,
        ];

        const next =
          appended.length > telemetryConfig.maxBufferedEvents
            ? appended.slice(appended.length - telemetryConfig.maxBufferedEvents)
            : appended;

        return [
          {
            size: next.length,
            dropped: next.length !== appended.length,
          } as const,
          next,
        ] as const;
      }),
    );

  const sendBatch = Effect.fn("AnalyticsService.sendBatch")(function* (
    events: ReadonlyArray<BufferedAnalyticsEvent>,
  ) {
    const apiKey = telemetryConfig.public.posthogKey.trim();
    const apiHost = telemetryConfig.public.posthogHost.trim().replace(/\/+$/, "");
    // An unconfigured project key means the operator has not pointed this
    // build at their own PostHog instance yet: drop silently instead of
    // sending anywhere.
    if (!telemetryConfig.public.enabled || !identifier || apiKey === "" || apiHost === "") return;

    const payload = {
      api_key: apiKey,
      batch: events.map((event) => ({
        event: event.event,
        distinct_id: identifier,
        properties: {
          ...event.properties,
          $process_person_profile: telemetryConfig.processPersonProfile,
          platform: hostPlatform,
          wsl: Option.getOrUndefined(telemetryConfig.wslDistroName),
          arch: hostArchitecture,
          t3CodeVersion: packageJson.version,
          clientType,
          serverOs: serverOsFromNodePlatform(hostPlatform),
          serverArch: hostArchitecture,
          serverWslDistro: Option.getOrUndefined(telemetryConfig.wslDistroName),
          serverAppVersion: packageJson.version,
          serverMode: serverConfig.mode,
        },
        timestamp: event.capturedAt,
      })),
    };

    yield* HttpClientRequest.post(`${apiHost}/batch/`).pipe(
      HttpClientRequest.bodyJson(payload),
      Effect.flatMap(httpClient.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
    );
  });

  const flush: AnalyticsService["Service"]["flush"] = Effect.gen(function* () {
    while (true) {
      const batch = yield* Ref.modify(bufferRef, (current) => {
        if (current.length === 0) {
          return [[] as ReadonlyArray<BufferedAnalyticsEvent>, current] as const;
        }
        const nextBatch = current.slice(0, telemetryConfig.flushBatchSize);
        const remaining = current.slice(nextBatch.length);
        return [nextBatch, remaining] as const;
      });

      if (batch.length === 0) {
        return;
      }

      yield* sendBatch(batch).pipe(
        Effect.catch((error) =>
          Ref.update(bufferRef, (current) => [...batch, ...current]).pipe(
            Effect.flatMap(() => Effect.fail(error)),
          ),
        ),
      );
    }
  }).pipe(Effect.catch((cause) => Effect.logError("Failed to flush telemetry", { cause })));

  const record: AnalyticsService["Service"]["record"] = Effect.fn("AnalyticsService.record")(
    function* (event, properties) {
      if (!telemetryConfig.public.enabled || !identifier) return;

      const enqueueResult = yield* enqueueBufferedEvent(event, properties);
      if (enqueueResult.dropped) {
        yield* Effect.logDebug("analytics buffer full; dropping oldest event", {
          size: enqueueResult.size,
          event,
        });
      }
    },
  );

  const captureException: AnalyticsService["Service"]["captureException"] = Effect.fn(
    "AnalyticsService.captureException",
  )(function* (error, properties) {
    if (!telemetryConfig.public.enabled || !identifier) return;

    const message = error instanceof Error ? error.message : String(error);
    const type = error instanceof Error ? error.name : typeof error;
    yield* record("$exception", {
      $exception_message: message.slice(0, 2_000),
      $exception_type: type,
      $exception_fingerprint: `${type}:${message}`.slice(0, 2_000),
      ...properties,
    });
  });

  yield* Effect.forever(Effect.sleep(1000).pipe(Effect.flatMap(() => flush)), {
    disableYield: true,
  }).pipe(Effect.forkScoped);

  yield* Effect.addFinalizer(() => flush);

  return AnalyticsService.of({ record, captureException, flush });
});

export const layer = Layer.effect(AnalyticsService, make);

export const layerTest = AnalyticsService.layerTest;
