import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { DoerTaskContext as ProjectionSnapshotQuery } from "./DoerTaskContext.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { DoerMemoryStoreLive } from "../persistence/Layers/DoerMemoryStore.ts";
import { DOER_MEMORY_ROUTE_PATH, doerMemoryRouteLayer } from "./DoerMemoryRoutes.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

/**
 * Test auth reads scopes from a header: `x-test-scopes: read` grants the read
 * scope, `x-test-scopes: operate` grants both, anything else is unauthenticated.
 */
const fixture = () => {
  const authLayer = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: (request) => {
      const scopes = request.headers["x-test-scopes"];
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
  const snapshotLayer = Layer.mock(ProjectionSnapshotQuery)({
    getProjectShellById: (projectId) =>
      Effect.succeed(
        String(projectId) === "project-1" ? Option.some({ id: projectId } as never) : Option.none(),
      ),
  });
  const { handler, dispose } = HttpRouter.toWebHandler(
    doerMemoryRouteLayer.pipe(
      Layer.provideMerge(authLayer),
      Layer.provideMerge(snapshotLayer),
      Layer.provideMerge(DoerMemoryStoreLive.pipe(Layer.provide(SqlitePersistenceMemory))),
      Layer.provideMerge(SqlitePersistenceMemory),
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
  query = "",
) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (scopes !== undefined) headers["x-test-scopes"] = scopes;
  return handler(
    new Request(`http://t3.test${DOER_MEMORY_ROUTE_PATH}${query}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
};

describe("doer memory routes", () => {
  it("blocks unauthenticated requests and private responses carry no-store", async () => {
    const handler = fixture();
    const denied = await json(handler, "GET", undefined, undefined, "?projectId=project-1");
    expect(denied.status).toBe(401);
    const listed = await json(handler, "GET", undefined, "read", "?projectId=project-1");
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(await listed.json()).toEqual({ memories: [] });
  });

  it("lets a read-only session list but not mutate", async () => {
    const handler = fixture();
    const created = await json(
      handler,
      "POST",
      { content: "Garden budget is 4000", scope: "space", projectId: "project-1" },
      "read",
    );
    expect(created.status).toBe(403);
    const deleted = await json(
      handler,
      "DELETE",
      undefined,
      "read",
      "?id=mem_x&projectId=project-1",
    );
    expect(deleted.status).toBe(403);
  });

  it("creates, updates, and forgets memories with an operate session", async () => {
    const handler = fixture();
    const createdResponse = await json(
      handler,
      "POST",
      { content: "Garden budget is 4000", scope: "space", projectId: "project-1" },
      "operate",
    );
    expect(createdResponse.status).toBe(201);
    expect(createdResponse.headers.get("cache-control")).toBe("no-store");
    const created = (await createdResponse.json()) as { memory: { id: string; content: string } };
    expect(created.memory.content).toBe("Garden budget is 4000");

    const listed = (await (
      await json(handler, "GET", undefined, "operate", "?scope=space&projectId=project-1")
    ).json()) as { memories: Array<{ id: string }> };
    expect(listed.memories.map((row) => row.id)).toEqual([created.memory.id]);

    const updatedResponse = await json(
      handler,
      "PATCH",
      { content: "Garden budget is 5000", projectId: "project-1" },
      "operate",
      `?id=${created.memory.id}`,
    );
    expect(updatedResponse.status).toBe(200);
    expect(((await updatedResponse.json()) as { memory: { content: string } }).memory.content).toBe(
      "Garden budget is 5000",
    );

    const deleted = await json(
      handler,
      "DELETE",
      undefined,
      "operate",
      `?id=${created.memory.id}&projectId=project-1`,
    );
    expect(deleted.status).toBe(200);
    const relisted = (await (
      await json(handler, "GET", undefined, "operate", "?projectId=project-1")
    ).json()) as { memories: Array<unknown> };
    expect(relisted.memories).toEqual([]);
  });

  it("rejects invalid bodies, unknown spaces, and foreign space ids", async () => {
    const handler = fixture();
    const empty = await json(
      handler,
      "POST",
      { content: "   ", scope: "space", projectId: "project-1" },
      "operate",
    );
    expect(empty.status).toBe(400);
    const secret = await json(
      handler,
      "POST",
      { content: "api key: sk-abcdef1234567890", scope: "space", projectId: "project-1" },
      "operate",
    );
    expect(secret.status).toBe(400);
    const unknownSpace = await json(
      handler,
      "POST",
      { content: "Hello", scope: "space", projectId: "project-gone" },
      "operate",
    );
    expect(unknownSpace.status).toBe(404);
    const created = (await (
      await json(
        handler,
        "POST",
        { content: "Mine", scope: "space", projectId: "project-1" },
        "operate",
      )
    ).json()) as { memory: { id: string } };
    const foreignUpdate = await json(
      handler,
      "PATCH",
      { content: "Hijacked", projectId: "project-other" },
      "operate",
      `?id=${created.memory.id}`,
    );
    expect(foreignUpdate.status).toBe(404);
    const foreignDelete = await json(
      handler,
      "DELETE",
      undefined,
      "operate",
      `?id=${created.memory.id}&projectId=project-other`,
    );
    expect(foreignDelete.status).toBe(404);
    const missingUpdate = await json(
      handler,
      "PATCH",
      { content: "Ghost", projectId: "project-1" },
      "operate",
      "?id=mem_missing",
    );
    expect(missingUpdate.status).toBe(404);
  });
});
