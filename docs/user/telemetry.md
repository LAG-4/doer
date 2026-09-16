# Product usage data

The Doer server sends product usage events to the Doer PostHog Cloud project
(US cloud), associated with a hashed account or
installation identifier. Events include the provider, model, reasoning effort,
permission mode, turn result, duration, and main-agent token totals when
available.

Events do not include prompts, responses, file contents, authentication tokens,
conversation IDs, raw provider events, or child-agent output. Child-agent token
use is excluded from the totals.

When telemetry is enabled, the web and desktop apps additionally load the
PostHog browser SDK, which captures anonymized interaction events, pageviews,
session recordings, and unhandled errors so real-world issues can be found and
fixed. Form inputs are masked in recordings, and URL query strings and
fragments (where pairing tokens travel) are stripped from every event before it
leaves the browser. Rendered on-screen content can still appear in session
recordings. The mobile app does not load the browser SDK; its usage is covered
by the server events.

No data goes to any other analytics vendor: the SDK bundle is served
with the app and all traffic goes to the Doer PostHog Cloud project above. Honoring
Do Not Track in the browser also disables the SDK.

To disable all collection, set `T3CODE_TELEMETRY_ENABLED=false` in the server's
environment before starting it. This stops product events from being recorded
or sent and tells connected browsers not to start the SDK.
