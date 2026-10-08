import {
  decodeExperimentalConnectionsStatus,
  EXPERIMENTAL_CONNECTIONS_ROUTE_PATH,
} from "@t3tools/shared/experimentalConnections";

/**
 * Shared experimental-connections HTTP client for web, desktop, and mobile.
 *
 * Mirrors `doerMemory.ts`: the caller supplies the environment base URL plus
 * an authenticated fetch. Web passes plain `fetch` (session cookies travel
 * automatically); mobile passes a wrapper adding its environment bearer
 * token. Host-scoped: every client of one computer reads the same value.
 */
export interface ExperimentalConnectionsTransport {
  /** Environment origin, e.g. `http://192.168.1.5:13773` — no trailing slash. */
  readonly baseUrl: string;
  readonly fetchFn: typeof globalThis.fetch;
  /** e.g. `Bearer <token>` on mobile; omit on web where cookies authenticate. */
  readonly authHeader?: string | undefined;
}

export class ExperimentalConnectionsRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ExperimentalConnectionsRequestError";
    this.status = status;
  }
}

const statusUrl = (transport: ExperimentalConnectionsTransport) =>
  `${transport.baseUrl.replace(/\/+$/, "")}${EXPERIMENTAL_CONNECTIONS_ROUTE_PATH}`;

async function requestJson(
  transport: ExperimentalConnectionsTransport,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  // Native fetch requires its own receiver: invoking it as
  // `transport.fetchFn(...)` throws "Illegal invocation" in browsers, so the
  // request never leaves the page. Call it detached instead.
  const fetchFn = transport.fetchFn;
  try {
    response = await fetchFn(statusUrl(transport), {
      ...init,
      credentials: "include",
      headers: {
        "content-type": "application/json",
        ...(transport.authHeader ? { authorization: transport.authHeader } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ExperimentalConnectionsRequestError(
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
    throw new ExperimentalConnectionsRequestError(
      detail ?? `Doer could not complete this (status ${response.status}). Try again.`,
      response.status,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new ExperimentalConnectionsRequestError(
      "Doer sent back something unexpected. Try again.",
      502,
    );
  }
}

const toEnabled = (body: unknown): boolean => {
  try {
    return decodeExperimentalConnectionsStatus(body).enabled;
  } catch {
    throw new ExperimentalConnectionsRequestError(
      "Doer sent back something unexpected. Try again.",
      502,
    );
  }
};

export async function getExperimentalConnections(
  transport: ExperimentalConnectionsTransport,
): Promise<boolean> {
  return toEnabled(await requestJson(transport, { method: "GET" }));
}

export async function setExperimentalConnections(
  transport: ExperimentalConnectionsTransport,
  enabled: boolean,
): Promise<boolean> {
  return toEnabled(
    await requestJson(transport, { method: "POST", body: JSON.stringify({ enabled }) }),
  );
}
