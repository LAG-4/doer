/**
 * Browser product analytics backed by the operator's own PostHog instance.
 *
 * The ingest host and project key are fetched at runtime from
 * `GET /api/telemetry/config` (resolved against the connected environment, so
 * desktop, remote, and tunneled clients all work) instead of being baked into
 * the build. When the server reports telemetry disabled or unconfigured — or
 * the fetch fails — this module stays completely silent and the app behaves
 * exactly as if analytics did not exist.
 *
 * What the SDK captures once enabled: autocaptured interactions, pageviews,
 * session recordings (form inputs masked), and unhandled errors. Pairing
 * tokens and other URL query/hash material are scrubbed from every event
 * before it leaves the browser.
 */
import { APP_VERSION } from "../branding";
import { isElectron } from "../env";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";

interface TelemetryConfig {
  readonly enabled: boolean;
  readonly host: string;
  readonly key: string;
}

const CONFIG_FETCH_TIMEOUT_MS = 5_000;

let initStarted = false;

/**
 * Starts browser analytics in the background. Never throws and never blocks
 * rendering: call once during boot.
 */
export function initProductAnalytics(): void {
  if (initStarted) {
    return;
  }
  initStarted = true;
  void boot().catch(() => {
    // Telemetry must never break the app; failures stay silent by design.
  });
}

async function boot(): Promise<void> {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return;
  }
  if (navigator.doNotTrack === "1") {
    return;
  }
  const config = await readTelemetryConfig();
  if (!config) {
    return;
  }
  // The full bundle keeps every extension (session replay, exception
  // autocapture) local: nothing is fetched from a third-party CDN, so all
  // traffic goes to the operator's own PostHog host.
  const { default: posthog } = await import("posthog-js/dist/module.full.js");
  posthog.init(config.key, {
    api_host: config.host,
    defaults: "2026-05-30",
    // No login exists to identify against; always-on person profiles keep
    // anonymous usage, replays, and errors attributable per browser.
    person_profiles: "always",
    autocapture: true,
    capture_pageview: true,
    capture_pageleave: true,
    capture_exceptions: true,
    session_recording: {
      maskAllInputs: true,
    },
    sanitize_properties: scrubUrlSecrets,
  });
  posthog.register({
    appVersion: APP_VERSION,
    surface: isElectron ? "desktop" : "web",
  });
}

async function readTelemetryConfig(): Promise<TelemetryConfig | null> {
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/telemetry/config"), {
    signal: AbortSignal.timeout(CONFIG_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    return null;
  }
  const body = (await response.json()) as Partial<TelemetryConfig>;
  if (
    body.enabled !== true ||
    typeof body.host !== "string" ||
    body.host === "" ||
    typeof body.key !== "string" ||
    body.key === ""
  ) {
    return null;
  }
  return { enabled: true, host: body.host, key: body.key };
}

/**
 * Drops the query string and fragment from a URL, keeping origin + path.
 * Pairing tokens travel in the URL hash and must never reach analytics.
 */
export function stripUrlSecrets(value: string): string {
  const queryIndex = value.search(/[?#]/);
  return queryIndex === -1 ? value : value.slice(0, queryIndex);
}

function scrubUrlSecrets(
  properties: Record<string, unknown>,
  _eventName: string,
): Record<string, unknown> {
  const scrubbed = { ...properties };
  for (const name of ["$current_url", "$referrer"] as const) {
    const value = scrubbed[name];
    if (typeof value === "string") {
      scrubbed[name] = stripUrlSecrets(value);
    }
  }
  return scrubbed;
}
