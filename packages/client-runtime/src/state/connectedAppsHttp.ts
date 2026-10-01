import { MicrosoftAction, MicrosoftResponse } from "@t3tools/shared/microsoftConnection";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { remoteHttpClientLayer, type RemoteEnvironmentRequestError } from "../rpc/http.ts";

export class ConnectedAppsHttp extends Context.Service<
  ConnectedAppsHttp,
  {
    readonly microsoft: (
      prepared: PreparedConnection,
      input: typeof MicrosoftAction.Type,
    ) => Effect.Effect<typeof MicrosoftResponse.Type, RemoteEnvironmentRequestError>;
  }
>()("@t3tools/client-runtime/state/ConnectedAppsHttp") {}

export const connectedAppsHttpLayer = Layer.effect(
  ConnectedAppsHttp,
  Effect.gen(function* () {
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return ConnectedAppsHttp.of({
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
