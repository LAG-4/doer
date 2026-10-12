import {
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentHttpConflictError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import { isEnabled as isExperimentalEnabled } from "./ExperimentalConnections.ts";
import { EXPERIMENTAL_CONNECTIONS_COPY } from "@t3tools/shared/experimentalConnections";
import { GmailConnection } from "./GmailConnection.ts";

export const integrationsHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "integrations",
  Effect.fnUntraced(function* (handlers) {
    const gmail = yield* GmailConnection;
    return handlers
      .handle(
        "gmailStatus",
        Effect.fn("integrations.gmailStatus")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* gmail.status;
        }),
      )
      .handle(
        "gmailBegin",
        Effect.fn("integrations.gmailBegin")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          // Disconnect and status stay available while the master switch is
          // off; beginning a new connection does not.
          if (!(yield* isExperimentalEnabled))
            return yield* new EnvironmentHttpConflictError({
              message: EXPERIMENTAL_CONNECTIONS_COPY.connectDenied,
            });
          const authorizationUrl = yield* gmail.begin.pipe(
            Effect.mapError(
              (error) => new EnvironmentHttpConflictError({ message: error.message }),
            ),
          );
          return { authorizationUrl };
        }),
      )
      .handle(
        "gmailDisconnect",
        Effect.fn("integrations.gmailDisconnect")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          return yield* gmail.disconnect.pipe(
            Effect.as({ disconnected: true }),
            Effect.mapError(
              (error) => new EnvironmentHttpConflictError({ message: error.message }),
            ),
          );
        }),
      );
  }),
);

/** Google calls this unauthenticated route; one-use state authorizes the callback. */
export const gmailCallbackRouteLayer = HttpRouter.add(
  "GET",
  "/api/integrations/gmail/callback",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url))
      return HttpServerResponse.text("Invalid Gmail callback.", { status: 400 });
    const state = url.value.searchParams.get("state");
    const code = url.value.searchParams.get("code");
    if (!state || !code)
      return HttpServerResponse.text("Gmail sign-in was cancelled. Return to Doer to try again.", {
        status: 400,
        headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
      });
    const gmail = yield* GmailConnection;
    // A stale OAuth redirect can arrive after the switch was turned off.
    // Refuse the exchange; the user can disconnect or re-enable and retry.
    let completed = false;
    if (yield* isExperimentalEnabled) {
      completed = yield* gmail.complete(state, code).pipe(
        Effect.map(() => true),
        Effect.tapError((error) =>
          Effect.logWarning("Gmail OAuth callback failed", { reason: error.message }),
        ),
        Effect.orElseSucceed(() => false),
      );
    }
    return completed
      ? HttpServerResponse.text(
          "<!doctype html><title>Gmail connected</title><p>Gmail is connected. Return to Doer.</p>",
          {
            contentType: "text/html; charset=utf-8",
            headers: {
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
              "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
            },
          },
        )
      : HttpServerResponse.text(
          "<!doctype html><title>Gmail connection failed</title><p>Gmail sign-in failed. Return to Doer and try again.</p>",
          {
            status: 400,
            contentType: "text/html; charset=utf-8",
            headers: {
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
              "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
            },
          },
        );
  }).pipe(HttpMiddleware.withLoggerDisabled),
);
