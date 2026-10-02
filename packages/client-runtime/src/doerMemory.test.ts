import { describe, expect, it, vi } from "vite-plus/test";

import {
  createDoerMemory,
  DoerMemoryRequestError,
  forgetDoerMemory,
  listDoerMemories,
  updateDoerMemory,
  type DoerMemoryTransport,
} from "./doerMemory.ts";

const memory = {
  id: "mem_1",
  scope: "space",
  projectId: "project-1",
  content: "Garden budget is 4000",
  sourceThreadId: "thread-1",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const transport = (fetchFn: typeof fetch, authHeader?: string): DoerMemoryTransport => ({
  baseUrl: "http://doer.test:13773/",
  fetchFn,
  ...(authHeader ? { authHeader } : {}),
});

describe("doerMemory client", () => {
  it("lists memories through the environment-relative URL", async () => {
    const fetchFn = vi.fn(async () => ok({ memories: [memory] }));
    const memories = await listDoerMemories(transport(fetchFn), { projectId: "project-1" });
    expect(memories).toEqual([memory]);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://doer.test:13773/api/doer-memory?projectId=project-1");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("include");
  });

  it("sends the bearer header when the caller supplies one", async () => {
    const fetchFn = vi.fn(async () => ok({ memories: [] }));
    await listDoerMemories(transport(fetchFn, "Bearer token-1"), { scope: "about-you" });
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer token-1");
  });

  it("creates, updates, and forgets with friendly errors", async () => {
    const created = await createDoerMemory(
      transport(vi.fn(async () => ok({ memory })) as unknown as typeof fetch),
      { content: "Garden budget is 4000", scope: "space", projectId: "project-1" },
    );
    expect(created.id).toBe("mem_1");
    await expect(
      createDoerMemory(transport(vi.fn() as unknown as typeof fetch), {
        content: "   ",
        scope: "space",
      }),
    ).rejects.toBeInstanceOf(DoerMemoryRequestError);
    const updated = await updateDoerMemory(
      transport(vi.fn(async () => ok({ memory })) as unknown as typeof fetch),
      "mem_1",
      { content: "Changed", projectId: "project-1" },
    );
    expect(updated.content).toBe("Garden budget is 4000");
    const forgotten = await forgetDoerMemory(
      transport(vi.fn(async () => ok({ memoryId: "mem_1" })) as unknown as typeof fetch),
      "mem_1",
      { projectId: "project-1" },
    );
    expect(forgotten).toBe("mem_1");
  });

  it("surfaces server messages and connection failures kindly", async () => {
    const denied = transport(
      vi.fn(
        async () => new Response(JSON.stringify({ message: "Nope." }), { status: 403 }),
      ) as unknown as typeof fetch,
    );
    await expect(listDoerMemories(denied, {})).rejects.toThrow("Nope.");
    const offline = transport(
      vi.fn(async () => {
        throw new Error("down");
      }) as unknown as typeof fetch,
    );
    await expect(listDoerMemories(offline, {})).rejects.toThrow(/Could not reach Doer/);
  });
});
