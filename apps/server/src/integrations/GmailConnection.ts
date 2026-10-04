import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpServer } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  createGmailOAuthAttempt,
  exchangeGmailCode,
  readGmailAccount,
  refreshGmailToken,
  sendGmailMessage,
  type GmailMessage,
} from "./gmailClient.ts";

const SECRET_NAME = "integration-gmail";
const ATTEMPT_LIFETIME_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;

const StoredConnection = Schema.Struct({
  email: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Finite,
});
type StoredConnection = typeof StoredConnection.Type;
const decodeStoredConnection = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredConnection));
const encodeStoredConnection = Schema.encodeSync(Schema.fromJsonString(StoredConnection));

export class GmailConnectionError extends Schema.TaggedError<GmailConnectionError>()(
  "GmailConnectionError",
  { message: Schema.String },
) {}

export interface GmailConnectionStatus {
  readonly configured: boolean;
  readonly connected: boolean;
  readonly email: string | null;
}

export class GmailConnection extends Context.Service<
  GmailConnection,
  {
    readonly status: Effect.Effect<GmailConnectionStatus>;
    readonly begin: Effect.Effect<string, GmailConnectionError>;
    readonly complete: (state: string, code: string) => Effect.Effect<string, GmailConnectionError>;
    readonly disconnect: Effect.Effect<void>;
    readonly send: (
      message: GmailMessage,
    ) => Effect.Effect<{ id: string; threadId?: string }, GmailConnectionError>;
  }
>()("@lag4/doer-cli/integrations/GmailConnection") {}

export const layer = Layer.effect(
  GmailConnection,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const httpServer = yield* HttpServer.HttpServer;
    const clientId = process.env.DOER_GOOGLE_OAUTH_CLIENT_ID?.trim() ?? "";
    const clientSecret = process.env.DOER_GOOGLE_OAUTH_CLIENT_SECRET?.trim() ?? "";
    const address = httpServer.address;
    const redirectUri =
      typeof address !== "string" && "port" in address
        ? `http://127.0.0.1:${address.port}/api/integrations/gmail/callback`
        : null;
    const pending = new Map<string, { verifier: string; createdAt: number }>();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const read = Effect.gen(function* () {
      const stored = yield* secrets.get(SECRET_NAME);
      if (Option.isNone(stored)) return null;
      return yield* decodeStoredConnection(decoder.decode(stored.value));
    }).pipe(Effect.orElseSucceed(() => null));

    const save = (connection: StoredConnection) =>
      secrets
        .set(SECRET_NAME, encoder.encode(encodeStoredConnection(connection)))
        .pipe(Effect.orDie);

    const status = read.pipe(
      Effect.map((connection): GmailConnectionStatus => ({
        configured: clientId.length > 0 && clientSecret.length > 0 && redirectUri !== null,
        connected: connection !== null,
        email: connection?.email ?? null,
      })),
    );

    const begin = Effect.gen(function* () {
      if (!clientId || !clientSecret || !redirectUri) {
        return yield* new GmailConnectionError({
          message: "Gmail sign-in is not configured on this computer.",
        });
      }
      const now = yield* Clock.currentTimeMillis;
      for (const [state, attempt] of pending) {
        if (now - attempt.createdAt > ATTEMPT_LIFETIME_MS) pending.delete(state);
      }
      const attempt = createGmailOAuthAttempt(clientId, redirectUri);
      pending.set(attempt.state, { verifier: attempt.verifier, createdAt: now });
      return attempt.authorizationUrl;
    });

    const complete = (state: string, code: string) =>
      Effect.gen(function* () {
        if (!clientId || !clientSecret || !redirectUri)
          return yield* new GmailConnectionError({ message: "Gmail sign-in is not configured." });
        const attempt = pending.get(state);
        pending.delete(state);
        const now = yield* Clock.currentTimeMillis;
        if (!attempt || now - attempt.createdAt > ATTEMPT_LIFETIME_MS) {
          return yield* new GmailConnectionError({
            message: "Gmail sign-in expired. Start again in Doer.",
          });
        }
        const tokens = yield* Effect.tryPromise({
          try: () =>
            exchangeGmailCode({
              clientId,
              clientSecret,
              redirectUri,
              code,
              verifier: attempt.verifier,
            }),
          catch: (cause) =>
            new GmailConnectionError({
              message:
                cause instanceof Error && cause.message.startsWith("Google token request failed")
                  ? cause.message
                  : "Google token service could not be reached.",
            }),
        });
        if (!tokens.refreshToken) {
          return yield* new GmailConnectionError({
            message: "Google did not grant background access. Disconnect and try again.",
          });
        }
        const email = yield* Effect.tryPromise({
          try: () => readGmailAccount(tokens.accessToken),
          catch: () =>
            new GmailConnectionError({ message: "Google did not return the connected account." }),
        });
        yield* save({ ...tokens, refreshToken: tokens.refreshToken, email });
        return email;
      });

    const disconnect = secrets.remove(SECRET_NAME).pipe(Effect.orDie);

    const send = (message: GmailMessage) =>
      Effect.gen(function* () {
        if (!clientId || !clientSecret)
          return yield* new GmailConnectionError({ message: "Gmail is not configured." });
        let connection = yield* read;
        if (!connection)
          return yield* new GmailConnectionError({ message: "Connect Gmail in Settings first." });
        const now = yield* Clock.currentTimeMillis;
        if (connection.expiresAt - now <= TOKEN_REFRESH_MARGIN_MS) {
          const refreshToken = connection.refreshToken;
          const email = connection.email;
          const refreshed = yield* Effect.tryPromise({
            try: () => refreshGmailToken(clientId, clientSecret, refreshToken),
            catch: () =>
              new GmailConnectionError({
                message: "Gmail connection expired. Reconnect in Settings.",
              }),
          });
          connection = { ...refreshed, refreshToken, email };
          yield* save(connection);
        }
        const accessToken = connection.accessToken;
        return yield* Effect.tryPromise({
          try: () => sendGmailMessage(accessToken, message),
          catch: () => new GmailConnectionError({ message: "Gmail could not send this message." }),
        });
      });

    return GmailConnection.of({ status, begin, complete, disconnect, send });
  }),
);
