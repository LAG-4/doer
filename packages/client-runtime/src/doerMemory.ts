import {
  DOER_MEMORY_MAX_CONTENT_CHARS,
  DoerMemory,
  type DoerMemoryScope,
} from "@t3tools/shared/doerMemory";
import * as Schema from "effect/Schema";

/**
 * Shared saved-memory HTTP client for web, desktop, and mobile.
 *
 * The caller supplies the environment base URL plus an authenticated fetch:
 * web passes plain `fetch` (session cookies travel automatically), mobile
 * passes a wrapper that adds its environment bearer token. URLs stay relative
 * to the connected environment so remote connections work unchanged.
 */
export interface DoerMemoryTransport {
  /** Environment origin, e.g. `http://192.168.1.5:13773` — no trailing slash. */
  readonly baseUrl: string;
  readonly fetchFn: typeof globalThis.fetch;
  /** e.g. `Bearer <token>` on mobile; omit on web where cookies authenticate. */
  readonly authHeader?: string | undefined;
}

export class DoerMemoryRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "DoerMemoryRequestError";
    this.status = status;
  }
}

const decodeMemories = Schema.decodeUnknownSync(
  Schema.Struct({ memories: Schema.Array(DoerMemory) }),
);
const decodeMemory = Schema.decodeUnknownSync(Schema.Struct({ memory: DoerMemory }));

const memoryUrl = (transport: DoerMemoryTransport, query: string) =>
  `${transport.baseUrl.replace(/\/+$/, "")}/api/doer-memory${query}`;

async function requestJson(
  transport: DoerMemoryTransport,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  // Native fetch requires its own receiver: invoking it as
  // `transport.fetchFn(...)` throws "Illegal invocation" in browsers, so the
  // request never leaves the page. Call it detached instead.
  const fetchFn = transport.fetchFn;
  try {
    response = await fetchFn(url, {
      ...init,
      credentials: "include",
      headers: {
        "content-type": "application/json",
        ...(transport.authHeader ? { authorization: transport.authHeader } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new DoerMemoryRequestError(
      "Could not reach Doer. Check the connection and try again.",
      0,
    );
  }
  if (!response.ok) {
    let detail: string | undefined;
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body.message === "string") detail = body.message;
    } catch {
      detail = undefined;
    }
    throw new DoerMemoryRequestError(
      detail ?? `Doer could not complete this (status ${response.status}). Try again.`,
      response.status,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new DoerMemoryRequestError("Doer sent back something unexpected. Try again.", 502);
  }
}

const toMemories = (body: unknown) => {
  try {
    return decodeMemories(body).memories;
  } catch {
    throw new DoerMemoryRequestError("Doer sent back something unexpected. Try again.", 502);
  }
};

const toMemory = (body: unknown) => {
  try {
    return decodeMemory(body).memory;
  } catch {
    throw new DoerMemoryRequestError("Doer sent back something unexpected. Try again.", 502);
  }
};

export async function listDoerMemories(
  transport: DoerMemoryTransport,
  query: { readonly scope?: DoerMemoryScope; readonly projectId?: string },
) {
  const params = new URLSearchParams();
  if (query.scope) params.set("scope", query.scope);
  if (query.projectId) params.set("projectId", query.projectId);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return toMemories(await requestJson(transport, memoryUrl(transport, suffix), { method: "GET" }));
}

export async function createDoerMemory(
  transport: DoerMemoryTransport,
  input: { readonly content: string; readonly scope: DoerMemoryScope; readonly projectId?: string },
) {
  if (input.content.trim() === "") {
    throw new DoerMemoryRequestError("Write the memory first.", 400);
  }
  if (input.content.trim().length > DOER_MEMORY_MAX_CONTENT_CHARS) {
    throw new DoerMemoryRequestError(
      `Memories hold up to ${DOER_MEMORY_MAX_CONTENT_CHARS} characters. Shorten it and try again.`,
      400,
    );
  }
  return toMemory(
    await requestJson(transport, memoryUrl(transport, ""), {
      method: "POST",
      body: JSON.stringify({
        content: input.content,
        scope: input.scope,
        ...(input.projectId ? { projectId: input.projectId } : {}),
      }),
    }),
  );
}

export async function updateDoerMemory(
  transport: DoerMemoryTransport,
  id: string,
  input: { readonly content: string; readonly projectId?: string },
) {
  return toMemory(
    await requestJson(transport, memoryUrl(transport, `?id=${encodeURIComponent(id)}`), {
      method: "PATCH",
      body: JSON.stringify({
        content: input.content,
        ...(input.projectId ? { projectId: input.projectId } : {}),
      }),
    }),
  );
}

export async function forgetDoerMemory(
  transport: DoerMemoryTransport,
  id: string,
  query: { readonly projectId?: string } = {},
) {
  const params = new URLSearchParams({ id });
  if (query.projectId) params.set("projectId", query.projectId);
  const body = (await requestJson(transport, memoryUrl(transport, `?${params.toString()}`), {
    method: "DELETE",
  })) as { memoryId?: unknown };
  if (typeof body.memoryId !== "string") {
    throw new DoerMemoryRequestError("Doer sent back something unexpected. Try again.", 502);
  }
  return body.memoryId;
}
