// @effect-diagnostics globalFetch:off - The browser fetch supplies the connection's HttpClient transport.
import { MicrosoftAction, MicrosoftResponse } from "@t3tools/shared/microsoftConnection";
import {
  EnvironmentHttpConflictError,
  GmailAuthorizationResult,
  GmailConnectionStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import {
  makeEnvironmentHttpApiUrlBuilder,
  remoteHttpClientLayer,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";

export class ConnectedAppsHttp extends Context.Service<
  ConnectedAppsHttp,
  {
    readonly microsoft: (
      prepared: PreparedConnection,
      input: typeof MicrosoftAction.Type,
    ) => Effect.Effect<MicrosoftResponse, RemoteEnvironmentRequestError>;
    readonly gmailStatus: (
      prepared: PreparedConnection,
    ) => Effect.Effect<GmailConnectionStatus, RemoteEnvironmentRequestError | GmailHttpError>;
    readonly gmailBegin: (
      prepared: PreparedConnection,
    ) => Effect.Effect<
      typeof GmailAuthorizationResult.Type,
      RemoteEnvironmentRequestError | GmailHttpError
    >;
    readonly gmailDisconnect: (
      prepared: PreparedConnection,
    ) => Effect.Effect<
      { readonly disconnected: boolean },
      RemoteEnvironmentRequestError | GmailHttpError
    >;
  }
>()("@t3tools/client-runtime/state/connectedAppsHttp") {}

export class GmailHttpError extends Schema.TaggedError<GmailHttpError>()("GmailHttpError", {
  message: Schema.String,
}) {}

/** Bounded server-provided conflict message. */
const boundConflictMessage = (message: string): string => {
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 300) : "Gmail reported a conflict on this computer.";
};

type GmailEndpointResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string };

const checkGmailConflict = Schema.is(EnvironmentHttpConflictError);

const isGmailConflict = (error: unknown): error is EnvironmentHttpConflictError =>
  checkGmailConflict(error);

const gmailResultToEffect = <A>(
  result: GmailEndpointResult<A>,
): Effect.Effect<A, GmailHttpError> =>
  result.ok
    ? Effect.succeed(result.value)
    : Effect.fail(new GmailHttpError({ message: result.message }));

export const connectedAppsHttpLayer = Layer.effect(
  ConnectedAppsHttp,
  Effect.gen(function* () {
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return ConnectedAppsHttp.of({
      // The typed client decodes declared endpoint errors itself. A 409
      // conflict becomes a success-channel value inside the request callback
      // so the shared normalizer never wraps it; common errors (401
      // invalid_credential, timeouts) pass through untouched, preserving DPoP
      // refresh and transport semantics. GmailHttpError is only raised
      // outside the normalizer, where the UI can match it.
      gmailStatus: (prepared) =>
        executeAuthenticatedEnvironmentHttpRequest({
          prepared,
          signer,
          remoteAuthorization,
          method: "GET",
          url: (base: string) =>
            String(makeEnvironmentHttpApiUrlBuilder(base).integrations.gmailStatus()),
          timeoutMs: 35_000,
          group: "integrations",
          request: ({ client, headers }) =>
            client.gmailStatus({ headers }).pipe(
              Effect.map((value): GmailEndpointResult<GmailConnectionStatus> => ({
                ok: true as const,
                value,
              })),
              Effect.catchIf(isGmailConflict, (cause) =>
                Effect.succeed({
                  ok: false as const,
                  message: boundConflictMessage(cause.message),
                }),
              ),
            ),
        }).pipe(
          Effect.provide(
            remoteHttpClientLayer((input, init) =>
              globalThis.fetch(input, { ...init, credentials: "include" }),
            ),
          ),
          Effect.flatMap(gmailResultToEffect),
        ),
      gmailBegin: (prepared) =>
        executeAuthenticatedEnvironmentHttpRequest({
          prepared,
          signer,
          remoteAuthorization,
          method: "POST",
          url: (base: string) =>
            String(makeEnvironmentHttpApiUrlBuilder(base).integrations.gmailBegin()),
          timeoutMs: 35_000,
          group: "integrations",
          request: ({ client, headers }) =>
            client.gmailBegin({ headers }).pipe(
              Effect.map((value): GmailEndpointResult<typeof GmailAuthorizationResult.Type> => ({
                ok: true as const,
                value,
              })),
              Effect.catchIf(isGmailConflict, (cause) =>
                Effect.succeed({
                  ok: false as const,
                  message: boundConflictMessage(cause.message),
                }),
              ),
            ),
        }).pipe(
          Effect.provide(
            remoteHttpClientLayer((input, init) =>
              globalThis.fetch(input, { ...init, credentials: "include" }),
            ),
          ),
          Effect.flatMap(gmailResultToEffect),
        ),
      gmailDisconnect: (prepared) =>
        executeAuthenticatedEnvironmentHttpRequest({
          prepared,
          signer,
          remoteAuthorization,
          method: "POST",
          url: (base: string) =>
            String(makeEnvironmentHttpApiUrlBuilder(base).integrations.gmailDisconnect()),
          timeoutMs: 35_000,
          group: "integrations",
          request: ({ client, headers }) =>
            client.gmailDisconnect({ headers }).pipe(
              Effect.map((value): GmailEndpointResult<{ readonly disconnected: boolean }> => ({
                ok: true as const,
                value,
              })),
              Effect.catchIf(isGmailConflict, (cause) =>
                Effect.succeed({
                  ok: false as const,
                  message: boundConflictMessage(cause.message),
                }),
              ),
            ),
        }).pipe(
          Effect.provide(
            remoteHttpClientLayer((input, init) =>
              globalThis.fetch(input, { ...init, credentials: "include" }),
            ),
          ),
          Effect.flatMap((result) =>
            result.ok
              ? result.value.disconnected
                ? Effect.succeed(result.value)
                : Effect.fail(
                    new GmailHttpError({ message: "Disconnect did not complete. Try again." }),
                  )
              : Effect.fail(new GmailHttpError({ message: result.message })),
          ),
        ),
      microsoft: (prepared, input) => {
        const url = (base: string) => new URL("/api/doer/microsoft", base).toString();
        return executeAuthenticatedEnvironmentHttpRequest({
          prepared,
          signer,
          remoteAuthorization,
          method: "POST",
          url,
          timeoutMs: 35_000,
          group: "metadata",
          request: ({ headers, requestUrl }) =>
            Effect.gen(function* () {
              const client = yield* HttpClient.HttpClient;
              const request = yield* HttpClientRequest.bodyJson(
                HttpClientRequest.post(requestUrl).pipe(
                  HttpClientRequest.setHeaders({ ...headers }),
                ),
                input,
              );
              const response = yield* client.execute(request);
              return yield* response.json.pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(MicrosoftResponse)),
              );
            }),
        }).pipe(
          Effect.provide(
            remoteHttpClientLayer((input, init) =>
              globalThis.fetch(input, { ...init, credentials: "include" }),
            ),
          ),
        );
      },
    });
  }),
);
