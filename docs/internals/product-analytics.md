# Product analytics

The server owns analytics delivery, opt-out, and identity for every connected client.
Clients do not load the PostHog browser SDK. Client-use events require an
authenticated connection, so visiting the hosted app without connecting does not
count as product use.

## Installs and owners

`distinct_id` keeps the rule every build has used: the hashed Codex workspace,
else the Claude machine id, else the install's anonymous id. It can change when
someone logs in, and a Codex Team shares one, but keeping it means PostHog charts
and history never break. Do not change it; add a field instead.

Every event also carries `installId` when the server can save its state: the hash
of a random id in the state directory, which never changes for the install. If
that file cannot be written, events still go out under `distinct_id`, as before. Count installs
with it. Who an install belongs to is a separate fact, sent as
`install.owner_observed`. Owners are resolved at query time in our own store, so
a rule can change and apply to all history.

[Owner sources](../../apps/server/src/telemetry/Identify.ts), strongest first:
T3 Connect, then the OpenAI and Claude person ids, then the client device. The
server reports what it can read itself: the linked Connect account and provider
logins. A connecting client reports its signed-in Connect account and its device,
which links every environment opened from one phone, browser, or desktop. Use the
OpenAI `user_id` claim, not the Codex `account_id` (the ChatGPT workspace, which a
whole Team shares) or the token `sub` (one per login method). Two Connect accounts are never the same person, whatever
weaker ids they share.

Every id is SHA-256 hashed with [one helper](../../packages/shared/src/telemetryId.ts)
on both sides, so a Connect account hashes the same on the client and the server.
The server accepts only hashes from clients.

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

## Delivery

A send can fail after PostHog has stored the batch, so every retry is a copy.
[Delivery](../../apps/server/src/telemetry/AnalyticsService.ts) gives each event a
uuid when it is recorded, backs off after a failed send, and drops a batch after a
few tries. Without these limits, one stuck batch was sent every second for days.

## Collection boundary

Keep analytics payloads to product metadata and normalized measurements. Do not
send prompts, authentication material, raw provider payloads, user-assigned device
names, or conversation identifiers. Client metadata is best effort; invalid values
must not reject a connection. PostHog person profiles remain disabled.
