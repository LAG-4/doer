# Product analytics

The server owns PostHog delivery, opt-out, and identity for every connected client.
[Identity selection](../../apps/server/src/telemetry/Identify.ts) hashes an available
provider account ID, falling back to an installation-scoped ID. This identity can
span several clients; it does not identify a browser session. Delivery targets the
Doer PostHog Cloud project (`T3CODE_POSTHOG_HOST`, default
`https://us.i.posthog.com`) with the project key from
`T3CODE_POSTHOG_KEY`. Blank key or host values are treated as missing by
Effect's config provider and fall back to these defaults; the supported way
to silence a build is the kill switch below.

`T3CODE_POSTHOG_PERSON_PROFILES` (default true) controls the
`$process_person_profile` flag on server events. `T3CODE_TELEMETRY_ENABLED=false`
is the single kill switch: it stops server recording and tells browsers not to
start the SDK.

## Browser SDK

Web and desktop clients load posthog-js (the self-contained `module.full`
bundle, so no third-party CDN is involved) with session replay, autocapture,
pageviews, and exception autocapture. The SDK reads its host and key at runtime
from [GET /api/telemetry/config](../../apps/server/src/telemetry/TelemetryConfigRoute.ts),
resolved against the connected environment, so ingest URLs are never baked into
a build and desktop/remote/tunneled clients all work. Mobile does not load the
browser SDK.

Server and browser events use different identities (hashed installation ID vs.
browser-generated ID) and are not joined into one person. URL query strings and
fragments are scrubbed from browser events in `sanitize_properties` because
pairing tokens travel in the URL hash; form inputs are masked in recordings.
Rendered on-screen content is not masked, which is an intentional trade-off for
debugging real sessions and is disclosed in [user telemetry docs](../user/telemetry.md).

## Attribution boundaries

Client dimensions belong to the event's WebSocket connection. A server-global
"current client" would misattribute simultaneous web, desktop, and mobile use.
Provider execution has its own events because a turn can outlive the requesting
connection.

Keep client and server dimensions separate. A desktop host can serve a phone or a
remote browser, and a direct connection can cross a network. Older clients omit
metadata. Missing client values must stay unknown rather than being backfilled
from server properties. The legacy `clientType` property describes how the server
runs; use `surface` for the connected client.

## Interpreting events

Use `client.turn.requested` for active-use reports. `client.connected` counts
reconnects, so network behavior can inflate it. One identity can appear in several
client groups during a period; adding those groups double-counts users.

Provider send and completion counts need not match. Providers can emit synthetic
turns without a send request. Collection is best effort, with no scan or backfill
of provider history.

Token totals cover the main agent. Child agents and model rerouting prevent a turn
from representing one provider/model combination's full cost. For provider
comparisons, require complete usage, no observed subagents, and no mixed models;
compare matching model, effort, interaction mode, and terminal status. Aggregate
output/input ratios should divide the summed totals. Averaging per-turn ratios
lets small-input turns dominate.

Unknown counts stay absent. Partial usage contains valid observed counts but
cannot establish a whole-turn total. Keep these distinctions when changing token
normalization or building reports.

## Collection boundary

Keep analytics payloads to product metadata and normalized measurements. Do not
send prompts, authentication material, raw provider payloads, user-assigned device
names, or conversation identifiers. Client metadata is best effort; invalid values
must not reject a connection. PostHog person profiles remain disabled.
