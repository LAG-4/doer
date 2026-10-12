/**
 * ExperimentalConnectionsRoutes - Authenticated host setting for the
 * experimental-connections master switch.
 *
 * `GET|POST /api/doer-experimental-connections` backs the single toggle in
 * Settings → Tools (web, desktop, paired clients) without touching the typed
 * wire contracts: raw routes with a fork-owned schema from
 * `@t3tools/shared/experimentalConnections` and the standard environment auth
 * scopes (read for status, operate for changes).
 *
 * @module ExperimentalConnectionsRoutes
 */
import { AuthAccessWriteScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import {
  EXPERIMENTAL_CONNECTIONS_ROUTE_PATH,
  ExperimentalConnectionsUpdate,
} from "@t3tools/shared/experimentalConnections";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";

import { authenticateRawRouteWithScope } from "../http.ts";
import { ExperimentalConnections } from "./ExperimentalConnections.ts";

const privateJson = (body: unknown): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(body, { headers: { "cache-control": "no-store" } });

const badRequest = (message: string) =>
  HttpServerResponse.jsonUnsafe(
    { error: "invalid_request", message },
    { status: 400, headers: { "cache-control": "no-store" } },
  );

const serverError = (message: string) =>
  HttpServerResponse.jsonUnsafe(
    { error: "internal_error", message },
    { status: 500, headers: { "cache-control": "no-store" } },
  );

const decodeUpdate = Schema.decodeUnknownSync(ExperimentalConnectionsUpdate);

const authErrorResponses = {
  EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
  EnvironmentInternalError: HttpServerRespondable.toResponse,
  EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
} as const;

const withRouteErrors = (fallbackMessage: string) => (cause: unknown) =>
  Effect.logWarning("Experimental-connections request failed.", { cause }).pipe(
    Effect.as(serverError(fallbackMessage)),
  );

const statusRoute = Effect.gen(function* () {
  yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
  const service = yield* ExperimentalConnections;
  return privateJson({ enabled: yield* service.get });
}).pipe(
  Effect.catchTags(authErrorResponses),
  Effect.catch(withRouteErrors("Could not load the experimental-connections setting.")),
);

const updateRoute = Effect.gen(function* () {
  // Flipping connection availability is access management: it needs
  // access:write, the same bar as Gmail connect — orchestration operate
  // alone is not enough.
  yield* authenticateRawRouteWithScope(AuthAccessWriteScope);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const body: unknown = yield* request.json.pipe(Effect.orElseSucceed(() => null));
  let enabled: boolean;
  try {
    enabled = decodeUpdate(body).enabled;
  } catch {
    return badRequest("Send whether experimental connections are on or off.");
  }
  const service = yield* ExperimentalConnections;
  yield* service.setEnabled(enabled);
  return privateJson({ enabled: yield* service.get });
}).pipe(
  Effect.catchTags(authErrorResponses),
  Effect.catch(withRouteErrors("Could not save the experimental-connections setting.")),
);

export const experimentalConnectionsRouteLayer = Layer.mergeAll(
  HttpRouter.add("GET", EXPERIMENTAL_CONNECTIONS_ROUTE_PATH, statusRoute),
  HttpRouter.add("POST", EXPERIMENTAL_CONNECTIONS_ROUTE_PATH, updateRoute),
);
