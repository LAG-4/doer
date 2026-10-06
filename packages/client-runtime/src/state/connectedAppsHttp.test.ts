import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi, afterEach } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";import {
  BearerConnectionTarget,
  RelayConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  ConnectedAppsHttp,
  connectedAppsHttpLayer,
  GmailHttpError,
} from "./connectedAppsHttp.ts";

const SECONDARY_TARGET = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("environment-secondary"),
  label: "Secondary computer",
  connectionId: "connection-2",
});
const PREPARED_SECONDARY: PreparedConnection = {
  environmentId: SECONDARY_TARGET.environmentId,
  label: SECONDARY_TARGET.label,
  httpBaseUrl: "https://secondary.example.test",
  socketUrl: "wss://secondary.example.test/ws",
  httpAuthorization: { _tag: "Bearer", token: "secondary-token" },
  target: SECONDARY_TARGET,
};

const RELAY_TARGET = new RelayConnectionTarget({
  environmentId: EnvironmentId.make("environment-relay"),
  label: "Relay computer",
});
const PREPARED_RELAY: PreparedConnection = {
  environmentId: RELAY_TARGET.environmentId,
  label: RELAY_TARGET.label,
  httpBaseUrl: "https://relay-current.example.test",
  socketUrl: "wss://relay-current.example.test/ws",
  httpAuthorization: { _tag: "Dpop", accessToken: "current-token", expiresAtEpochMs: 3_600_000 },
  target: RELAY_TARGET,
};

const STATUS = { configured: true, connected: true, email: "user@example.com" };

function stubFetch(reply: (callNumber: number) => Response | Promise<Response>) {
  const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return reply(calls.length);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ConnectedAppsHttp Gmail transport", () => {
  it.effect("routes status to the prepared secondary URL with its bearer auth", () =>
    Effect.gen(function* () {
      const calls = stubFetch(() => Response.json(STATUS));
      const apps = yield* ConnectedAppsHttp.pipe(Effect.provide(connectedAppsHttpLayer));
      const status = yield* apps.gmailStatus(PREPARED_SECONDARY);

      expect(status).toEqual(STATUS);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("https://secondary.example.test/api/integrations/gmail");
      expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(
        "Bearer secondary-token",
      );
    }),
  );

  it.effect("rejects a 409 with the readable bounded server message", () =>
    Effect.gen(function* () {
      const calls = stubFetch(() =>
        Response.json(
          { _tag: "EnvironmentHttpConflictError", message: "Google revoked access." },
          { status: 409 },
        ),
      );
      const apps = yield* ConnectedAppsHttp.pipe(Effect.provide(connectedAppsHttpLayer));
      const error = yield* apps.gmailBegin(PREPARED_SECONDARY).pipe(Effect.flip);

      expect(Schema.is(GmailHttpError)(error)).toBe(true);
      expect(error).toMatchObject({ _tag: "GmailHttpError", message: "Google revoked access." });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("https://secondary.example.test/api/integrations/gmail/connect");
    }),
  );

  it.effect("never reports success when disconnect answers disconnected:false", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json({ disconnected: false }));
      const apps = yield* ConnectedAppsHttp.pipe(Effect.provide(connectedAppsHttpLayer));
      const error = yield* apps.gmailDisconnect(PREPARED_SECONDARY).pipe(Effect.flip);

      expect(Schema.is(GmailHttpError)(error)).toBe(true);
    }),
  );

  it.effect("rejects a disconnect 409 with the bounded revocation message", () =>
    Effect.gen(function* () {
      const longMessage = `Revocation failed: ${"detail ".repeat(100)}`;
      const calls = stubFetch(() =>
        Response.json(
          { _tag: "EnvironmentHttpConflictError", message: longMessage },
          { status: 409 },
        ),
      );
      const apps = yield* ConnectedAppsHttp.pipe(Effect.provide(connectedAppsHttpLayer));
      const error = yield* apps.gmailDisconnect(PREPARED_SECONDARY).pipe(Effect.flip);

      expect(Schema.is(GmailHttpError)(error)).toBe(true);
      expect(error).toMatchObject({ _tag: "GmailHttpError" });
      if (error._tag === "GmailHttpError") {
        expect(error.message).toHaveLength(300);
        expect(error.message).toBe(longMessage.trim().slice(0, 300));
      }
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(
        "https://secondary.example.test/api/integrations/gmail/disconnect",
      );
    }),
  );

  it.effect("rejects a malformed successful response instead of succeeding", () =>
    Effect.gen(function* () {
      stubFetch(() => Response.json({ unexpected: true }));
      const apps = yield* ConnectedAppsHttp.pipe(Effect.provide(connectedAppsHttpLayer));
      const error = yield* apps.gmailStatus(PREPARED_SECONDARY).pipe(Effect.flip);

      expect(error._tag).toBe("RemoteEnvironmentAuthInvalidJsonError");
      expect(Schema.is(GmailHttpError)(error)).toBe(false);
    }),
  );

  it.effect("refreshes DPoP credentials on 401 invalid_credential and retries once", () =>
    Effect.gen(function* () {
      let proofs = 0;
      const authorizations: Array<{ readonly rejectedAccessToken?: string }> = [];
      const signer = ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed("test-thumbprint"),
        createProof: () => Effect.sync(() => `proof-${(proofs += 1)}`),
      });
      const remoteAuthorization = RemoteEnvironmentAuthorization.of({
        authorizeBearer: () => Effect.die("Unexpected bearer preparation."),
        authorizeDpop: () => Effect.die("Unexpected websocket preparation."),
        authorizeDpopHttp: (input) =>
          Effect.sync(() => {
            authorizations.push({
              rejectedAccessToken: input.rejectedAccessToken,
            });
            const renewed = input.rejectedAccessToken !== undefined;
            return {
              environmentId: RELAY_TARGET.environmentId,
              label: RELAY_TARGET.label,
              httpBaseUrl: renewed
                ? "https://relay-renewed.example.test"
                : "https://relay-current.example.test",
              httpAuthorization: {
                _tag: "Dpop" as const,
                accessToken: renewed ? "renewed-token" : "current-token",
                expiresAtEpochMs: 3_600_000,
              },
            };
          }),
      });
      const calls = stubFetch((callNumber) =>
        callNumber === 1
          ? Response.json(
              {
                _tag: "EnvironmentAuthInvalidError",
                code: "auth_invalid",
                reason: "invalid_credential",
                traceId: "trace-rejected",
              },
              { status: 401 },
            )
          : Response.json(STATUS),
      );
      const apps = yield* ConnectedAppsHttp.pipe(
        Effect.provide(
          connectedAppsHttpLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ManagedRelayDpopSigner, signer),
                Layer.succeed(RemoteEnvironmentAuthorization, remoteAuthorization),
              ),
            ),
          ),
        ),
      );
      const status = yield* apps.gmailStatus(PREPARED_RELAY);

      expect(status).toEqual(STATUS);
      expect(calls.map((call) => call.url)).toEqual([
        "https://relay-current.example.test/api/integrations/gmail",
        "https://relay-renewed.example.test/api/integrations/gmail",
      ]);
      expect(
        calls.map((call) => new Headers(call.init.headers).get("authorization")),
      ).toEqual(["DPoP current-token", "DPoP renewed-token"]);
      expect(authorizations).toHaveLength(2);
    }),
  );
});
