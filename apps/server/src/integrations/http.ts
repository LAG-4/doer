import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentHttpConflictError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
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
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
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
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          yield* gmail.disconnect;
          return { disconnected: true };
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
      return HttpServerResponse.text("Gmail sign-in was cancelled.", { status: 400 });
    const gmail = yield* GmailConnection;
    const completed = yield* gmail.complete(state, code).pipe(
      Effect.map(() => true),
      Effect.tapError((error) =>
        Effect.logWarning("Gmail OAuth callback failed", { reason: error.message }),
      ),
      Effect.orElseSucceed(() => false),
    );
    return completed
      ? HttpServerResponse.text(
          "<!doctype html><title>Gmail connected</title><p>Gmail is connected. Return to Doer.</p>",
          { contentType: "text/html; charset=utf-8", headers: { "cache-control": "no-store" } },
        )
      : HttpServerResponse.text(
          "<!doctype html><title>Gmail connection failed</title><p>Gmail sign-in failed. Return to Doer and try again.</p>",
          {
            status: 400,
            contentType: "text/html; charset=utf-8",
            headers: { "cache-control": "no-store" },
          },
        );
  }),
);
