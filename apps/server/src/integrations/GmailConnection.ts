import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpServer } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  createGmailOAuthAttempt,
  exchangeGmailCode,
  readGmailAccount,
  refreshGmailToken,
  revokeGmailToken,
  GMAIL_SEND_SCOPE,
  GMAIL_MODIFY_SCOPE,
  sendGmailMessage,
  type GmailMessage,
} from "./gmailClient.ts";
import {
  searchGmailMessages,
  readGmailMessage,
  listGmailLabels,
  modifyGmailMessage,
  type MailSearch,
  type MailChange,
} from "./gmailMailbox.ts";
import {
  decryptTokens,
  encryptTokens,
  isEncryptedTokenFile,
  readEncryptionKey,
} from "./tokenEncryption.ts";

const SECRET_NAME = "integration-gmail";
const ATTEMPT_LIFETIME_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;
declare const __DOER_BUILD_GOOGLE_OAUTH_CLIENT_ID__: string | undefined;
declare const __DOER_BUILD_GOOGLE_OAUTH_CLIENT_SECRET__: string | undefined;

const StoredConnection = Schema.Struct({
  email: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Finite,
  clientId: Schema.optional(Schema.String),
  scopes: Schema.optional(Schema.Array(Schema.String)),
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
    readonly disconnect: Effect.Effect<void, GmailConnectionError>;
    readonly search: (
      input: MailSearch,
    ) => Effect.Effect<Awaited<ReturnType<typeof searchGmailMessages>>, GmailConnectionError>;
    readonly readMessage: (
      id: string,
      expectedEmail?: string,
    ) => Effect.Effect<Awaited<ReturnType<typeof readGmailMessage>>, GmailConnectionError>;
    readonly listLabels: Effect.Effect<
      Awaited<ReturnType<typeof listGmailLabels>>,
      GmailConnectionError
    >;
    readonly modify: (
      input: MailChange,
      expectedEmail: string,
    ) => Effect.Effect<Awaited<ReturnType<typeof modifyGmailMessage>>, GmailConnectionError>;
    readonly send: (
      message: GmailMessage,
      expectedEmail?: string,
    ) => Effect.Effect<{ id: string; threadId?: string }, GmailConnectionError>;
  }
>()("@lag4/doer-cli/integrations/GmailConnection") {}

export const layer = Layer.effect(
  GmailConnection,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const httpServer = yield* HttpServer.HttpServer;
    const settings = yield* ServerSettingsService;
    const clientId =
      process.env.DOER_GOOGLE_OAUTH_CLIENT_ID?.trim() ??
      (typeof __DOER_BUILD_GOOGLE_OAUTH_CLIENT_ID__ === "string"
        ? __DOER_BUILD_GOOGLE_OAUTH_CLIENT_ID__
        : "");
    const clientSecret =
      process.env.DOER_GOOGLE_OAUTH_CLIENT_SECRET?.trim() ??
      (typeof __DOER_BUILD_GOOGLE_OAUTH_CLIENT_SECRET__ === "string"
        ? __DOER_BUILD_GOOGLE_OAUTH_CLIENT_SECRET__
        : "");
    const encryptionKey = readEncryptionKey(process.env.DOER_GMAIL_ENCRYPTION_KEY);
    const mutex = yield* Semaphore.make(1);
    const address = httpServer.address;
    const redirectUri =
      typeof address !== "string" && "port" in address
        ? `http://127.0.0.1:${address.port}/api/integrations/gmail/callback`
        : null;
    const pending = new Map<string, { verifier: string; createdAt: number }>();
    const decoder = new TextDecoder();

    const save = (connection: StoredConnection) =>
      Effect.gen(function* () {
        if (!encryptionKey)
          return yield* new GmailConnectionError({
            message: "Secure Gmail storage is unavailable on this computer.",
          });
        const encrypted = yield* Effect.try({
          try: () => encryptTokens(encodeStoredConnection(connection), encryptionKey),
          catch: () =>
            new GmailConnectionError({ message: "Could not protect Gmail credentials." }),
        });
        yield* secrets
          .set(SECRET_NAME, encrypted)
          .pipe(
            Effect.mapError(
              () =>
                new GmailConnectionError({ message: "Could not save Gmail credentials securely." }),
            ),
          );
      });

    const read = Effect.gen(function* () {
      const stored = yield* secrets.get(SECRET_NAME);
      if (Option.isNone(stored)) return null;
      if (isEncryptedTokenFile(stored.value)) {
        if (!encryptionKey)
          return yield* new GmailConnectionError({
            message:
              "Secure Gmail storage is unavailable. Restore the encryption key before reconnecting.",
          });
        const plaintext = yield* Effect.try({
          try: () => decryptTokens(stored.value, encryptionKey),
          catch: () =>
            new GmailConnectionError({ message: "Gmail credentials could not be unlocked." }),
        });
        return yield* decodeStoredConnection(plaintext);
      }
      // Upgrade the development prototype's plaintext file before allowing any sends.
      const legacy = yield* decodeStoredConnection(decoder.decode(stored.value));
      if (encryptionKey) yield* save(legacy);
      return legacy;
    }).pipe(
      Effect.mapError(
        () =>
          new GmailConnectionError({
            message:
              "Gmail credentials could not be unlocked. Restore secure storage before reconnecting.",
          }),
      ),
    );

    const status = read.pipe(
      mutex.withPermit,
      Effect.map((connection): GmailConnectionStatus => ({
        configured:
          clientId.length > 0 &&
          clientSecret.length > 0 &&
          redirectUri !== null &&
          encryptionKey !== null,
        connected:
          encryptionKey !== null &&
          connection !== null &&
          (!connection.clientId || connection.clientId === clientId),
        email: encryptionKey !== null ? (connection?.email ?? null) : null,
      })),
      Effect.orElseSucceed(() => ({ configured: false, connected: false, email: null })),
    );

    const begin = Effect.gen(function* () {
      if (!clientId || !clientSecret || !redirectUri || !encryptionKey) {
        return yield* new GmailConnectionError({
          message: "Gmail sign-in is not configured on this computer.",
        });
      }
      if (yield* read)
        return yield* new GmailConnectionError({
          message: "Disconnect the current Gmail account before connecting again.",
        });
      const now = yield* Clock.currentTimeMillis;
      for (const [state, attempt] of pending) {
        if (now - attempt.createdAt > ATTEMPT_LIFETIME_MS) pending.delete(state);
      }
      const attempt = createGmailOAuthAttempt(clientId, redirectUri);
      if (pending.size >= 8) {
        return yield* new GmailConnectionError({
          message: "A Gmail sign-in is already pending. Finish it or try again in ten minutes.",
        });
      }
      pending.set(attempt.state, { verifier: attempt.verifier, createdAt: now });
      return attempt.authorizationUrl;
    }).pipe(mutex.withPermit);

    const complete = (state: string, code: string) =>
      Effect.gen(function* () {
        if (!clientId || !clientSecret || !redirectUri || !encryptionKey)
          return yield* new GmailConnectionError({ message: "Gmail sign-in is not configured." });
        const attempt = pending.get(state);
        pending.delete(state);
        const now = yield* Clock.currentTimeMillis;
        if (!attempt || now - attempt.createdAt > ATTEMPT_LIFETIME_MS) {
          return yield* new GmailConnectionError({
            message: "Gmail sign-in expired. Start again in Doer.",
          });
        }
        if (yield* read)
          return yield* new GmailConnectionError({
            message: "Gmail is already connected. Disconnect before changing accounts.",
          });
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
        if (
          !tokens.scopes.includes(GMAIL_SEND_SCOPE) &&
          !tokens.scopes.includes(GMAIL_MODIFY_SCOPE)
        ) {
          yield* Effect.tryPromise({
            try: () => revokeGmailToken(tokens.refreshToken ?? tokens.accessToken),
            catch: () =>
              new GmailConnectionError({
                message:
                  "Permission was declined. Remove Doer from your Google account's third-party connections.",
              }),
          });
          return yield* new GmailConnectionError({
            message:
              "Gmail send permission was not granted. Connect again when you want to enable sending.",
          });
        }
        const revokeUnusedGrant = Effect.tryPromise({
          try: () => revokeGmailToken(tokens.refreshToken ?? tokens.accessToken),
          catch: () =>
            new GmailConnectionError({
              message:
                "Remove Doer from your Google account's third-party connections before retrying.",
            }),
        });
        if (!tokens.refreshToken) {
          yield* revokeUnusedGrant;
          return yield* new GmailConnectionError({
            message: "Google did not grant background access. Disconnect and try again.",
          });
        }
        const email = yield* Effect.tryPromise({
          try: () => readGmailAccount(tokens.accessToken),
          catch: () =>
            new GmailConnectionError({ message: "Google did not return the connected account." }),
        }).pipe(Effect.tapError(() => revokeUnusedGrant));
        yield* save({ ...tokens, refreshToken: tokens.refreshToken, email, clientId }).pipe(
          Effect.tapError(() => revokeUnusedGrant),
        );
        pending.clear();
        return email;
      }).pipe(mutex.withPermit);

    const disconnect = Effect.gen(function* () {
      // Publish the same switch change to every client before revoking access.
      // If Google is offline, access stays paused and Disconnect can be retried.
      yield* settings.updateSettings({ enableGmailAccess: false }).pipe(
        Effect.mapError(
          () =>
            new GmailConnectionError({
              message: "Could not switch Gmail off. Try Disconnect again.",
            }),
        ),
      );
      pending.clear();
      const connection = yield* read;
      if (connection) {
        yield* Effect.tryPromise({
          try: () => revokeGmailToken(connection.refreshToken),
          catch: () =>
            new GmailConnectionError({
              message: "Google access could not be revoked. Try Disconnect again while online.",
            }),
        });
      } else if (
        Option.isSome(
          yield* secrets.get(SECRET_NAME).pipe(Effect.orElseSucceed(() => Option.none())),
        )
      ) {
        return yield* new GmailConnectionError({
          message:
            "Gmail credentials could not be unlocked. Restore secure storage, or revoke Doer in your Google account before removing local credentials.",
        });
      }
      yield* secrets.remove(SECRET_NAME).pipe(
        Effect.mapError(
          () =>
            new GmailConnectionError({
              message: "Could not remove Gmail credentials. Try Disconnect again.",
            }),
        ),
      );
    }).pipe(mutex.withPermit);

    const withToken = <A>(
      permission: "send" | "read" | "modify",
      operation: (token: string) => Promise<A>,
      failureMessage: string,
      expectedEmail?: string,
    ) =>
      Effect.gen(function* () {
        if (!clientId || !clientSecret || !encryptionKey)
          return yield* new GmailConnectionError({ message: "Gmail is not configured." });
        let connection = yield* read;
        if (!connection)
          return yield* new GmailConnectionError({ message: "Connect Gmail in Settings first." });
        if (
          (connection.clientId && connection.clientId !== clientId) ||
          (expectedEmail && connection.email !== expectedEmail)
        ) {
          return yield* new GmailConnectionError({
            message: "The Gmail account changed. Reconnect or review a new Gmail request.",
          });
        }
        const now = yield* Clock.currentTimeMillis;
        if (connection.expiresAt - now <= TOKEN_REFRESH_MARGIN_MS) {
          const refreshToken = connection.refreshToken;
          const email = connection.email;
          const refreshed = yield* Effect.tryPromise({
            try: () => refreshGmailToken(clientId, clientSecret, refreshToken),
            catch: (cause) =>
              new GmailConnectionError({
                message:
                  cause instanceof Error && cause.message.includes("invalid_grant")
                    ? "Gmail access expired or was revoked. Disconnect and reconnect in Settings."
                    : "Google could not refresh Gmail access. Check your connection and try again.",
              }),
          }).pipe(
            Effect.tapError((error) =>
              error.message.startsWith("Gmail access expired")
                ? secrets.remove(SECRET_NAME).pipe(Effect.ignore)
                : Effect.void,
            ),
          );
          connection = {
            ...connection,
            ...refreshed,
            email,
            scopes: refreshed.scopes.length > 0 ? refreshed.scopes : connection.scopes,
          };
          yield* save(connection);
        }
        const scopes = connection.scopes ?? [];
        const permitted =
          scopes.includes(GMAIL_MODIFY_SCOPE) ||
          (permission === "send" &&
            (scopes.includes(GMAIL_SEND_SCOPE) || connection.scopes === undefined)) ||
          (permission === "read" &&
            scopes.includes("https://www.googleapis.com/auth/gmail.readonly"));
        if (!permitted)
          return yield* new GmailConnectionError({
            message: `Gmail ${permission} permission is missing. Disconnect and reconnect Gmail in Settings to grant read and organize access.`,
          });
        const accessToken = connection.accessToken;
        return yield* Effect.tryPromise({
          try: () => operation(accessToken),
          catch: () => new GmailConnectionError({ message: failureMessage }),
        });
      }).pipe(mutex.withPermit);

    const send = (message: GmailMessage, expectedEmail?: string) =>
      withToken(
        "send",
        (token) => sendGmailMessage(token, message),
        "Gmail did not confirm delivery. The email may have been sent. Check Gmail's Sent folder before trying again; Doer will not retry automatically.",
        expectedEmail,
      );
    const readFailure =
      "Gmail could not return this mail. Check your connection and permissions; the message may be unavailable or too large.";
    return GmailConnection.of({
      status,
      begin,
      complete,
      disconnect,
      send,
      search: (input) =>
        withToken("read", (token) => searchGmailMessages(token, input), readFailure),
      readMessage: (id, expectedEmail) =>
        withToken("read", (token) => readGmailMessage(token, id), readFailure, expectedEmail),
      listLabels: withToken("read", (token) => listGmailLabels(token), readFailure),
      modify: (input, expectedEmail) =>
        withToken(
          "modify",
          (token) => modifyGmailMessage(token, input),
          "Gmail did not confirm the change. Check the message in Gmail before retrying; Doer will not retry automatically.",
          expectedEmail,
        ),
    });
  }),
);
