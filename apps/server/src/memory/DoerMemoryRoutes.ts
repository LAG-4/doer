// @effect-diagnostics nodeBuiltinImport:off
/**
 * DoerMemoryRoutes - Authenticated Settings UI routes for saved memories.
 *
 * `GET|POST /api/doer-memory` and `PATCH|DELETE /api/doer-memory?id=`
 * back the "What Doer remembers" controls in Settings (web, desktop, mobile)
 * without touching the typed wire contracts: these raw routes use
 * fork-owned schemas from `@t3tools/shared/doerMemory` and the standard
 * environment auth scopes (read for listing, operate for mutations).
 *
 * Space writes always carry the entry's project id and are rejected when it
 * does not match, so a caller cannot read or write another Space by id.
 *
 * @module DoerMemoryRoutes
 */
import * as NodeCrypto from "node:crypto";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ProjectId,
} from "@t3tools/contracts";
import {
  DOER_MEMORY_MAX_CONTENT_CHARS,
  DOER_MEMORY_MAX_COUNT_PER_SCOPE,
  DoerMemoryCreateRequest,
  type DoerMemoryCreateRequest as DoerMemoryCreateRequestType,
  DoerMemoryUpdateRequest,
  type DoerMemoryUpdateRequest as DoerMemoryUpdateRequestType,
  findDoerMemorySecretProblem,
  normalizeDoerMemoryContent,
  type DoerMemoryScope,
} from "@t3tools/shared/doerMemory";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";

import { authenticateRawRouteWithScope } from "../http.ts";
import * as ProjectionSnapshotQuery from "./DoerTaskContext.ts";
import { DoerMemoryStore } from "../persistence/Services/DoerMemoryStore.ts";

export const DOER_MEMORY_ROUTE_PATH = "/api/doer-memory";

// Private memories must never sit in a shared cache.
const privateJson = (
  body: unknown,
  options?: { readonly status?: number },
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(body, {
    ...(options?.status !== undefined ? { status: options.status } : {}),
    headers: { "cache-control": "no-store" },
  });

const badRequest = (message: string) =>
  privateJson({ error: "invalid_request", message }, { status: 400 });

const notFound = (message: string) => privateJson({ error: "not_found", message }, { status: 404 });

const serverError = (message: string) =>
  privateJson({ error: "internal_error", message }, { status: 500 });

const requestParam = (url: URL, name: string): string | null => {
  const value = url.searchParams.get(name)?.trim();
  return value === undefined || value === "" ? null : (value ?? null);
};

const decodeCreateRequest = Schema.decodeUnknownSync(DoerMemoryCreateRequest);
const decodeUpdateRequest = Schema.decodeUnknownSync(DoerMemoryUpdateRequest);

const decodeCreateBody = (body: unknown): DoerMemoryCreateRequestType | null => {
  try {
    return decodeCreateRequest(body);
  } catch {
    return null;
  }
};

const decodeUpdateBody = (body: unknown): DoerMemoryUpdateRequestType | null => {
  try {
    return decodeUpdateRequest(body);
  } catch {
    return null;
  }
};

/** Resolve a Space id against the authoritative project list. Null when rejected. */
const resolveSpace = Effect.fn("DoerMemoryRoutes.resolveSpace")(function* (
  projectId: string | null,
) {
  if (projectId === null) return null;
  const snapshots = yield* ProjectionSnapshotQuery.DoerTaskContext;
  const project = yield* snapshots
    .getProjectShellById(ProjectId.make(projectId))
    .pipe(Effect.orElseSucceed(() => Option.none()));
  return Option.isSome(project) ? projectId : null;
});

const checkContent = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const content = normalizeDoerMemoryContent(raw);
  if (content === "") return null;
  if (content.length > DOER_MEMORY_MAX_CONTENT_CHARS) return null;
  if (findDoerMemorySecretProblem(content) !== null) return null;
  return content;
};

const refusedReason = (raw: unknown): string => {
  if (typeof raw !== "string" || normalizeDoerMemoryContent(raw) === "") {
    return "Write the memory first.";
  }
  const content = normalizeDoerMemoryContent(raw);
  if (content.length > DOER_MEMORY_MAX_CONTENT_CHARS) {
    return `Memories hold up to ${DOER_MEMORY_MAX_CONTENT_CHARS} characters. Shorten it and try again.`;
  }
  const secret = findDoerMemorySecretProblem(content);
  if (secret !== null) return `${secret} Nothing was saved.`;
  return "Write the memory first.";
};

const authErrorResponses = {
  EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
  EnvironmentInternalError: HttpServerRespondable.toResponse,
  EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
} as const;

const withRouteErrors = (fallbackMessage: string) => (cause: unknown) =>
  Effect.logWarning("Saved-memory request failed.", { cause }).pipe(
    Effect.as(serverError(fallbackMessage)),
  );

const listRoute = Effect.gen(function* () {
  yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return badRequest("Bad request.");
  const scopeParam = requestParam(url.value, "scope");
  if (scopeParam !== null && scopeParam !== "about-you" && scopeParam !== "space") {
    return badRequest("Unknown scope.");
  }
  const scope = scopeParam as DoerMemoryScope | null;
  const store = yield* DoerMemoryStore;
  if (scope === "about-you") {
    return privateJson({ memories: yield* store.listAboutYou() });
  }
  const space = yield* resolveSpace(requestParam(url.value, "projectId"));
  if (space === null) {
    if (scope === null) {
      return privateJson({ memories: yield* store.listAboutYou() });
    }
    return notFound("This Space no longer exists.");
  }
  if (scope === "space") {
    return privateJson({
      memories: yield* store.listForSpace({ projectId: space }),
    });
  }
  return privateJson({
    memories: yield* store.listInScope({ projectId: space }),
  });
}).pipe(
  Effect.catchTags(authErrorResponses),
  Effect.catch(withRouteErrors("Could not load memories.")),
);

const createRoute = Effect.gen(function* () {
  yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const body: unknown = yield* request.json.pipe(Effect.orElseSucceed(() => null));
  const decoded = decodeCreateBody(body);
  if (decoded === null) return badRequest("Send the memory text and where to save it.");
  const content = checkContent(decoded.content);
  if (content === null) return badRequest(refusedReason(decoded.content));
  const scope = decoded.scope ?? "space";
  const projectId =
    scope === "about-you" ? null : yield* resolveSpace(decoded.projectId?.trim() || null);
  if (scope === "space" && projectId === null) {
    return notFound("This Space no longer exists.");
  }
  const store = yield* DoerMemoryStore;
  const occurredAt = DateTime.formatIso(yield* DateTime.now);
  const id = `mem_${NodeCrypto.randomUUID()}`;
  // The store enforces the bucket cap atomically: false means full.
  const inserted = yield* store.create({
    id,
    scope,
    projectId,
    content,
    sourceThreadId: "settings",
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
  if (!inserted) {
    return badRequest(
      scope === "about-you"
        ? `About you already holds ${DOER_MEMORY_MAX_COUNT_PER_SCOPE} memories. Forget one before saving another.`
        : `This Space already holds ${DOER_MEMORY_MAX_COUNT_PER_SCOPE} memories. Forget one before saving another.`,
    );
  }
  const saved = yield* store.getById({ id });
  if (Option.isNone(saved)) return serverError("The memory was not saved. Try again.");
  return privateJson({ memory: saved.value }, { status: 201 });
}).pipe(
  Effect.catchTags(authErrorResponses),
  Effect.catch(withRouteErrors("Could not save the memory.")),
);

const updateRoute = Effect.gen(function* () {
  yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return badRequest("Bad request.");
  const id = requestParam(url.value, "id");
  if (id === null) return badRequest("Choose a memory first.");
  const body: unknown = yield* request.json.pipe(Effect.orElseSucceed(() => null));
  const decoded = decodeUpdateBody(body);
  if (decoded === null) return badRequest("Send the corrected memory text.");
  const store = yield* DoerMemoryStore;
  const existing = yield* store.getById({ id });
  if (Option.isNone(existing)) return notFound("This memory no longer exists.");
  const entry = existing.value;
  if (entry.scope === "space" && entry.projectId !== (decoded.projectId?.trim() || null)) {
    return notFound("This memory no longer exists.");
  }
  const content = checkContent(decoded.content);
  if (content === null) return badRequest(refusedReason(decoded.content));
  const updatedAt = DateTime.formatIso(yield* DateTime.now);
  const updated = yield* store.updateById({ id, content, updatedAt });
  if (!updated) return notFound("This memory no longer exists.");
  const saved = yield* store.getById({ id });
  if (Option.isNone(saved)) return notFound("This memory no longer exists.");
  return privateJson({ memory: saved.value });
}).pipe(
  Effect.catchTags(authErrorResponses),
  Effect.catch(withRouteErrors("Could not update the memory.")),
);

const deleteRoute = Effect.gen(function* () {
  yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return badRequest("Bad request.");
  const id = requestParam(url.value, "id");
  if (id === null) return badRequest("Choose a memory first.");
  const store = yield* DoerMemoryStore;
  const existing = yield* store.getById({ id });
  if (Option.isNone(existing)) return notFound("This memory no longer exists.");
  if (
    existing.value.scope === "space" &&
    existing.value.projectId !== requestParam(url.value, "projectId")
  ) {
    return notFound("This memory no longer exists.");
  }
  const deleted = yield* store.deleteById({ id });
  if (!deleted) return notFound("This memory no longer exists.");
  return privateJson({ memoryId: id });
}).pipe(
  Effect.catchTags(authErrorResponses),
  Effect.catch(withRouteErrors("Could not forget the memory.")),
);

export const doerMemoryRouteLayer = Layer.mergeAll(
  HttpRouter.add("GET", DOER_MEMORY_ROUTE_PATH, listRoute),
  HttpRouter.add("POST", DOER_MEMORY_ROUTE_PATH, createRoute),
  HttpRouter.add("PATCH", DOER_MEMORY_ROUTE_PATH, updateRoute),
  HttpRouter.add("DELETE", DOER_MEMORY_ROUTE_PATH, deleteRoute),
);
