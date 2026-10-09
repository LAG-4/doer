import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ExperimentalConnections from "./ExperimentalConnections.ts";
import { EXPERIMENTAL_CONNECTIONS_ROUTE_PATH } from "@t3tools/shared/experimentalConnections";
import { experimentalConnectionsRouteLayer } from "./ExperimentalConnectionsRoutes.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

/**
 * Test auth reads scopes from a header: `x-test-scopes: read` grants read,
 * `operate` grants read+operate (not access-write), `write` grants
 * read+access-write, anything else is unauthenticated.
 */
const fixture = (
  serviceLayer: Layer.Layer<ExperimentalConnections.ExperimentalConnections> = ExperimentalConnections.layerTest(
    false,
  ),
) => {
  const authLayer = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: (request) => {
      const scopes = request.headers["x-test-scopes"];
      if (scopes === "write") {
        return Effect.succeed({
          sessionId: AuthSessionId.make("session-write"),
          subject: "test",
          method: "bearer-access-token",
          scopes: [AuthOrchestrationReadScope, AuthAccessWriteScope],
        });
      }
      if (scopes === "operate") {
        return Effect.succeed({
          sessionId: AuthSessionId.make("session-operate"),
          subject: "test",
          method: "bearer-access-token",
          scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
        });
      }
      if (scopes === "read") {
        return Effect.succeed({
          sessionId: AuthSessionId.make("session-read"),
          subject: "test",
          method: "bearer-access-token",
          scopes: [AuthOrchestrationReadScope],
        });
      }
      return Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError());
    },
  });
  const { handler, dispose } = HttpRouter.toWebHandler(
    experimentalConnectionsRouteLayer.pipe(
      Layer.provideMerge(authLayer),
      Layer.provideMerge(serviceLayer),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return handler;
};

const json = (
  handler: (request: Request) => Promise<Response>,
  method: string,
  body?: unknown,
  scopes?: string,
) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (scopes !== undefined) headers["x-test-scopes"] = scopes;
  return handler(
    new Request(`http://t3.test${EXPERIMENTAL_CONNECTIONS_ROUTE_PATH}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
};

describe("experimental connections routes", () => {
  it("blocks unauthenticated status reads", async () => {
    const handler = fixture();
    const denied = await json(handler, "GET");
    expect(denied.status).toBe(401);
    const listed = await json(handler, "GET", undefined, "read");
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(await listed.json()).toEqual({ enabled: false });
  });

  it("requires access-write for the toggle, not operate or read", async () => {
    const handler = fixture();
    expect((await json(handler, "POST", { enabled: true })).status).toBe(401);
    expect((await json(handler, "POST", { enabled: true }, "read")).status).toBe(403);
    expect((await json(handler, "POST", { enabled: true }, "operate")).status).toBe(403);
  });

  it("rejects bad toggle bodies with 400", async () => {
    const handler = fixture();
    for (const body of [{}, { enabled: "yes" }, { enabled: 1 }, null]) {
      const response = await json(handler, "POST", body, "write");
      expect(response.status).toBe(400);
    }
    // Nothing was persisted by the rejected writes.
    expect(await (await json(handler, "GET", undefined, "read")).json()).toEqual({
      enabled: false,
    });
  });

  it("persists the toggle and reports it back", async () => {
    const handler = fixture();
    const saved = await json(handler, "POST", { enabled: true }, "write");
    expect(saved.status).toBe(200);
    expect(saved.headers.get("cache-control")).toBe("no-store");
    expect(await saved.json()).toEqual({ enabled: true });
    expect(await (await json(handler, "GET", undefined, "read")).json()).toEqual({
      enabled: true,
    });
  });

  it("reports storage failures instead of claiming success", async () => {
    const handler = fixture(
      Layer.succeed(
        ExperimentalConnections.ExperimentalConnections,
        ExperimentalConnections.ExperimentalConnections.of({
          get: Effect.succeed(false),
          setEnabled: () =>
            Effect.fail(
              new ExperimentalConnections.ExperimentalConnectionsStoreError({
                message: "Could not save the experimental-connections setting.",
              }),
            ),
        }),
      ),
    );
    const response = await json(handler, "POST", { enabled: true }, "write");
    expect(response.status).toBe(500);
    const body = (await response.json()) as { message?: unknown };
    expect(body.message).toContain("Could not save");
  });
});
