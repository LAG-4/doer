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
import { HttpClient, HttpClientRequest } from "effect/http";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { EnvironmentHttpAuthHeaders } from "./environmentHttpAuth.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { layerRemoteHttpClient, type RemoteEnvironmentRequestError } from "../rpc/http.ts";

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

const runMicrosoftRequest = Effect.fn("ConnectedAppsHttp.microsoftRequest")(function* (
  input: typeof MicrosoftAction.Type,
  headers: EnvironmentHttpAuthHeaders,
  requestUrl: string,
) {
  const client = yield* HttpClient.HttpClient;
  const request = yield* HttpClientRequest.bodyJson(
    HttpClientRequest.post(requestUrl).pipe(HttpClientRequest.setHeaders({ ...headers })),
    input,
  );
  const response = yield* client.execute(request);
  return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(MicrosoftResponse)));
});

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
      // Typed client decodes endpoint errors itself; 409 stays in-band so the
      // normalizer preserves DPoP and transport semantics.
      gmailStatus: Effect.fn("ConnectedAppsHttp.gmailStatus")((prepared) =>
        executeAuthenticatedEnvironmentHttpRequest({
          prepared,
          signer,
          remoteAuthorization,
          method: "GET",
          url: (urls) => urls.gmailStatus(),
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
            layerRemoteHttpClient((input, init) =>
              globalThis.fetch(input, { ...init, credentials: "include" }),
            ),
          ),
          Effect.flatMap(gmailResultToEffect),
        ),
      ),
      gmailBegin: Effect.fn("ConnectedAppsHttp.gmailBegin")((prepared) =>
        executeAuthenticatedEnvironmentHttpRequest({
          prepared,
          signer,
          remoteAuthorization,
          method: "POST",
          url: (urls) => urls.gmailBegin(),
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
            layerRemoteHttpClient((input, init) =>
              globalThis.fetch(input, { ...init, credentials: "include" }),
            ),
          ),
          Effect.flatMap(gmailResultToEffect),
        ),
      ),
      gmailDisconnect: Effect.fn("ConnectedAppsHttp.gmailDisconnect")((prepared) =>
        executeAuthenticatedEnvironmentHttpRequest({
          prepared,
          signer,
          remoteAuthorization,
          method: "POST",
          url: (urls) => urls.gmailDisconnect(),
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
            layerRemoteHttpClient((input, init) =>
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
      ),
      microsoft: Effect.fn("ConnectedAppsHttp.microsoft")((prepared, input) =>
        executeAuthenticatedEnvironmentHttpRequest({
          prepared,
          signer,
          remoteAuthorization,
          method: "POST",
          url: (urls) => new URL("/api/doer/microsoft", urls.descriptor()).toString(),
          timeoutMs: 35_000,
          group: "metadata",
          request: ({ headers, requestUrl }) => runMicrosoftRequest(input, headers, requestUrl),
        }).pipe(
          Effect.provide(
            layerRemoteHttpClient((input, init) =>
              globalThis.fetch(input, { ...init, credentials: "include" }),
            ),
          ),
        ),
      ),
    });
  }),
);
