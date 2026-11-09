import * as Schema from "effect/Schema";

/** Fork-owned experimental-connections opt-in (Doer). Master toggle defaults off; each connection needs its own opt-in. */

/** Authenticated host-scoped setting endpoint backing the toggle. */
export const EXPERIMENTAL_CONNECTIONS_ROUTE_PATH = "/api/doer-experimental-connections";

export const ExperimentalConnectionsStatus = Schema.Struct({
  enabled: Schema.Boolean,
});
export type ExperimentalConnectionsStatus = typeof ExperimentalConnectionsStatus.Type;

export const ExperimentalConnectionsUpdate = Schema.Struct({
  enabled: Schema.Boolean,
});
export type ExperimentalConnectionsUpdate = typeof ExperimentalConnectionsUpdate.Type;

export const decodeExperimentalConnectionsStatus = Schema.decodeUnknownSync(
  ExperimentalConnectionsStatus,
);

/** Single-toggle behavior, in one place so UI, errors, and docs agree. */
export const EXPERIMENTAL_CONNECTIONS_COPY = {
  title: "Experimental connections",
  description:
    "Show Google, Microsoft, and local Office connections. These are experimental: turn this on only if you want to try them. Each connection still needs your separate approval.",
  offHint: "Experimental connections are hidden until you turn them on here.",
  toolDenied:
    "Experimental connections are off. Turn them on in Settings → Connected apps → Experimental connections to use this connection.",
  connectDenied:
    "Experimental connections are off. Turn them on in Settings → Connected apps → Experimental connections before connecting.",
} as const;
