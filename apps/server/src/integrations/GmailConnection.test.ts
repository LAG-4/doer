import { describe, expect, it } from "@effect/vitest";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { ProjectId } from "@t3tools/contracts";
import { GmailConnection, layer } from "./GmailConnection.ts";
import { GMAIL_SEND_SCOPE, GMAIL_MODIFY_SCOPE } from "./gmailClient.ts";
import { decryptTokens, encryptTokens, isEncryptedTokenFile } from "./tokenEncryption.ts";

const key = Buffer.alloc(32, 4);
const connection = {
  email: "sender@example.com",
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: 0,
  clientId: "client",
  scopes: [GMAIL_SEND_SCOPE],
};
const message = { to: ["recipient@example.com"], subject: "Test", body: "Test body" };
const jsonCodec = Schema.fromJsonString(Schema.Unknown);
const connectionJson = Schema.encodeSync(jsonCodec)(connection);
const decodeJson = Schema.decodeUnknownSync(jsonCodec);

function harness(initial?: Uint8Array) {
  let stored = initial;
  const secrets = Layer.mock(ServerSecretStore)({
    get: () => Effect.sync(() => Option.fromNullishOr(stored)),
    set: (_name, value) =>
      Effect.sync(() => {
        stored = Uint8Array.from(value);
      }),
    remove: () =>
      Effect.sync(() => {
        stored = undefined;
      }),
  });
  const testLayer = layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        secrets,
        Layer.mock(HttpServer.HttpServer)({
          address: NetAddress.inetAddressUnsafe(NetAddress.ipv4Loopback, 9000),
        }),
        NodeServices.layer,
      ),
    ),
    Layer.provideMerge(
      ServerSettingsService.layerTest({
        enableGmailAccess: true,
        projectSettingsOverrides: { [ProjectId.make("legacy-space")]: { enableGmailAccess: true } },
      }),
    ),
  );
  return {
    stored: () => stored,
    run: <A, E>(program: Effect.Effect<A, E, GmailConnection | ServerSettingsService>) =>
      program.pipe(Effect.provide(testLayer)),
  };
}

beforeEach(() => {
  vi.stubEnv("DOER_GOOGLE_OAUTH_CLIENT_ID", "client");
  vi.stubEnv("DOER_GOOGLE_OAUTH_CLIENT_SECRET", "client-secret");
  vi.stubEnv("DOER_GMAIL_ENCRYPTION_KEY", key.toString("base64"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Gmail connection lifecycle", () => {
  it.effect("publishes Gmail off even when revocation fails, and permits a disconnect retry", () =>
    Effect.gen(function* () {
      const test = harness(encryptTokens(connectionJson, key));
      const request = vi.fn(async () => new Response(null, { status: 503 }));
      vi.stubGlobal("fetch", request);
      yield* test.run(
        Effect.gen(function* () {
          const gmail = yield* GmailConnection;
          const settings = yield* ServerSettingsService;
          expect((yield* settings.getSettings).enableGmailAccess).toBe(true);
          yield* gmail.disconnect.pipe(Effect.flip);
          const paused = yield* settings.getSettings;
          expect(paused.enableGmailAccess).toBe(false);
          expect(
            resolveProjectSettings(paused, ProjectId.make("legacy-space")).settings
              .enableGmailAccess,
          ).toBe(false);
          expect(test.stored()).toBeDefined();
          request.mockImplementation(async () => new Response(null, { status: 200 }));
          yield* gmail.disconnect;
          expect((yield* gmail.status).connected).toBe(false);
          expect((yield* settings.getSettings).enableGmailAccess).toBe(false);
        }),
      );
      expect(test.stored()).toBeUndefined();
    }),
  );
  it.effect("requires renewed consent before a send-only account can read or organize mail", () =>
    Effect.gen(function* () {
      const test = harness(
        encryptTokens(
          yield* Schema.encodeEffect(jsonCodec)({
            ...connection,
            expiresAt: Number.MAX_SAFE_INTEGER,
          }),
          key,
        ),
      );
      const request = vi.fn(async () => Response.json({ id: "abc123" }));
      vi.stubGlobal("fetch", request);
      yield* test.run(
        Effect.gen(function* () {
          const gmail = yield* GmailConnection;
          expect((yield* gmail.search({ query: "is:unread" }).pipe(Effect.flip)).message).toContain(
            "Disconnect and reconnect",
          );
          expect(
            (yield* gmail
              .modify({ messageId: "abc123", action: "archive" }, connection.email)
              .pipe(Effect.flip)).message,
          ).toContain("permission is missing");
        }),
      );
      expect(request).not.toHaveBeenCalled();
    }),
  );
  it.effect(
    "uses the encrypted modify grant for API reads and rejects changes to a different account",
    () =>
      Effect.gen(function* () {
        const test = harness(
          encryptTokens(
            yield* Schema.encodeEffect(jsonCodec)({
              ...connection,
              expiresAt: Number.MAX_SAFE_INTEGER,
              scopes: [GMAIL_MODIFY_SCOPE],
            }),
            key,
          ),
        );
        const request = vi.fn(async () =>
          Response.json({
            id: "abc123",
            payload: {
              mimeType: "text/plain",
              body: { data: Buffer.from("hello").toString("base64url") },
            },
          }),
        );
        vi.stubGlobal("fetch", request);
        yield* test.run(
          Effect.gen(function* () {
            const gmail = yield* GmailConnection;
            expect((yield* gmail.readMessage("abc123")).body).toBe("hello");
            expect(
              (yield* gmail
                .modify({ messageId: "abc123", action: "archive" }, "other@example.com")
                .pipe(Effect.flip)).message,
            ).toContain("account changed");
            yield* gmail.modify({ messageId: "abc123", action: "archive" }, connection.email);
          }),
        );
        expect(request).toHaveBeenCalledTimes(2);
      }),
  );
  it.effect("revokes an unused grant if account identification fails", () =>
    Effect.gen(function* () {
      const test = harness();
      const calls: string[] = [];
      vi.stubGlobal("fetch", async (url: string) => {
        calls.push(url);
        if (url.endsWith("/token"))
          return Response.json({
            access_token: "access",
            refresh_token: "refresh",
            expires_in: 3600,
            scope: `openid email ${GMAIL_SEND_SCOPE}`,
          });
        return new Response(null, { status: url.endsWith("/revoke") ? 200 : 503 });
      });
      yield* test.run(
        Effect.gen(function* () {
          const gmail = yield* GmailConnection;
          const state = new URL(yield* gmail.begin).searchParams.get("state")!;
          expect((yield* gmail.complete(state, "code").pipe(Effect.flip)).message).toContain(
            "connected account",
          );
        }),
      );
      expect(calls.at(-1)).toBe("https://oauth2.googleapis.com/revoke");
      expect(test.stored()).toBeUndefined();
    }),
  );
  it.effect("clears revoked credentials after invalid_grant and permits reconnecting", () =>
    Effect.gen(function* () {
      const test = harness(encryptTokens(connectionJson, key));
      vi.stubGlobal("fetch", async () =>
        Response.json({ error: "invalid_grant" }, { status: 400 }),
      );
      yield* test.run(
        Effect.gen(function* () {
          const gmail = yield* GmailConnection;
          expect((yield* gmail.send(message).pipe(Effect.flip)).message).toContain("revoked");
          expect(yield* gmail.status).toMatchObject({ connected: false });
          expect(yield* gmail.begin).toContain("accounts.google.com");
        }),
      );
      expect(test.stored()).toBeUndefined();
    }),
  );
  it.effect("migrates plaintext credentials into authenticated encryption before reuse", () =>
    Effect.gen(function* () {
      const test = harness(Buffer.from(connectionJson));
      expect(
        yield* test.run(Effect.flatMap(GmailConnection, (gmail) => gmail.status)),
      ).toMatchObject({
        connected: true,
        email: connection.email,
      });
      expect(isEncryptedTokenFile(test.stored()!)).toBe(true);
      expect(decodeJson(decryptTokens(test.stored()!, key))).toEqual(connection);
    }),
  );
  it.effect(
    "disables sign-in without a vault key and refuses to overwrite unreadable credentials",
    () =>
      Effect.gen(function* () {
        vi.stubEnv("DOER_GMAIL_ENCRYPTION_KEY", "");
        const test = harness(encryptTokens(connectionJson, key));
        expect(
          yield* test.run(Effect.flatMap(GmailConnection, (gmail) => gmail.status)),
        ).toMatchObject({
          configured: false,
          connected: false,
        });
        const error = yield* test.run(
          Effect.flatMap(GmailConnection, (gmail) => gmail.begin).pipe(Effect.flip),
        );
        expect(error.message).toContain("not configured");
        expect(test.stored()).toBeDefined();
      }),
  );
  it.effect("revokes remotely before deleting and keeps credentials when revocation fails", () =>
    Effect.gen(function* () {
      const test = harness(encryptTokens(connectionJson, key));
      const request = vi.fn(async () => new Response(null, { status: 503 }));
      vi.stubGlobal("fetch", request);
      const error = yield* test.run(
        Effect.flatMap(GmailConnection, (gmail) => gmail.disconnect).pipe(Effect.flip),
      );
      expect(error.message).toContain("could not be revoked");
      expect(test.stored()).toBeDefined();
      request.mockImplementation(async () => new Response(null, { status: 200 }));
      yield* test.run(Effect.flatMap(GmailConnection, (gmail) => gmail.disconnect));
      expect(test.stored()).toBeUndefined();
    }),
  );
  it.effect("serializes refreshes and never sends from a changed account", () =>
    Effect.gen(function* () {
      const test = harness(encryptTokens(connectionJson, key));
      const calls: string[] = [];
      vi.stubGlobal("fetch", async (url: string) => {
        calls.push(url);
        return url.endsWith("/token")
          ? Response.json({ access_token: "new-access", expires_in: 3600, scope: GMAIL_SEND_SCOPE })
          : Response.json({ id: "sent" });
      });
      yield* test.run(
        Effect.gen(function* () {
          const gmail = yield* GmailConnection;
          yield* Effect.all(
            [gmail.send(message, connection.email), gmail.send(message, connection.email)],
            { concurrency: "unbounded" },
          );
          yield* gmail.send(message, "different@example.com").pipe(Effect.flip);
        }),
      );
      expect(calls.filter((url) => url.endsWith("/token"))).toHaveLength(1);
      expect(calls.filter((url) => url.endsWith("/send"))).toHaveLength(2);
    }),
  );
  it.effect("rejects missing Gmail permission and consumes OAuth state exactly once", () =>
    Effect.gen(function* () {
      const test = harness();
      const request = vi.fn(async (url: string) =>
        url.endsWith("/token")
          ? Response.json({
              access_token: "access",
              refresh_token: "refresh",
              expires_in: 3600,
              scope: "openid email",
            })
          : new Response(null, { status: 200 }),
      );
      vi.stubGlobal("fetch", request);
      yield* test.run(
        Effect.gen(function* () {
          const gmail = yield* GmailConnection;
          const state = new URL(yield* gmail.begin).searchParams.get("state")!;
          expect((yield* gmail.complete(state, "code").pipe(Effect.flip)).message).toContain(
            "not granted",
          );
          expect((yield* gmail.complete(state, "code").pipe(Effect.flip)).message).toContain(
            "expired",
          );
        }),
      );
      expect(request).toHaveBeenCalledTimes(2);
      expect(test.stored()).toBeUndefined();
    }),
  );
});
