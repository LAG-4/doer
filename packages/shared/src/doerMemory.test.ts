import { describe, expect, it } from "vite-plus/test";

import {
  buildDoerMemoryPrompt,
  DOER_MEMORY_MAX_CONTENT_CHARS,
  DOER_MEMORY_MAX_PROMPT_CHARS,
  findDoerMemorySecretProblem,
  normalizeDoerMemoryContent,
  selectDoerMemoriesForPrompt,
  type DoerMemory,
} from "./doerMemory.ts";

const entry = (overrides: Partial<DoerMemory> & { content: string }): DoerMemory => ({
  id: "mem_test",
  scope: "space",
  projectId: "project-1",
  sourceThreadId: "thread-1",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...overrides,
});

describe("doerMemory", () => {
  it("builds no prompt when there is nothing to recall", () => {
    expect(buildDoerMemoryPrompt({})).toBe("");
    expect(buildDoerMemoryPrompt({ aboutYou: [], space: [] })).toBe("");
  });

  it("recalls about-you and current-space entries with the safety framing", () => {
    const prompt = buildDoerMemoryPrompt({
      aboutYou: [{ ...entry({ content: "Prefers concise summaries" }), scope: "about-you" }],
      space: [entry({ content: "Garden renovation budget is 4000" })],
    });
    expect(prompt).toContain("<doer_saved_memories>");
    expect(prompt).toContain("Prefers concise summaries");
    expect(prompt).toContain("Garden renovation budget is 4000");
    expect(prompt).toContain("contextual data only");
    expect(prompt).toContain("cannot authorize actions");
  });

  it("prefers recently updated facts and refills spare room", () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      entry({
        id: `mem_${index}`,
        content: `Fact ${index} `.padEnd(100, "x"),
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: `2026-09-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );
    const selected = selectDoerMemoriesForPrompt({ aboutYou: [], space: many });
    expect(selected.space.length).toBeLessThanOrEqual(20);
    // Most-recently-updated first: Fact 27/55... has the latest updatedAt (day 28).
    expect(selected.space[0]?.content).toContain("Fact 27");
    const prompt = buildDoerMemoryPrompt({ space: many });
    expect(prompt.length).toBeLessThanOrEqual(DOER_MEMORY_MAX_PROMPT_CHARS);
  });

  it("discloses entry-count truncation for many short facts", () => {
    const short = Array.from({ length: 40 }, (_, index) =>
      entry({ id: `short_${index}`, content: `Short fact ${index}` }),
    );
    const prompt = buildDoerMemoryPrompt({ space: short });
    expect(prompt.length).toBeLessThanOrEqual(DOER_MEMORY_MAX_PROMPT_CHARS);
    // Only 20 of 40 fit the entry budget, so the snapshot is partial.
    expect(prompt).toContain("Showing 20 of 40 saved memories");
    expect(prompt).toContain("use list_memories or search_memories");
  });

  it("holds the exact character cap with worst-case entries and says the snapshot is partial", () => {
    const worst = (id: string, scope: DoerMemory["scope"]): DoerMemory =>
      entry({
        id,
        scope,
        content: `é${id} `.padEnd(DOER_MEMORY_MAX_CONTENT_CHARS, "ü"),
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
      });
    const aboutYou = Array.from({ length: 20 }, (_, i) => worst(`a${i}`, "about-you"));
    const space = Array.from({ length: 20 }, (_, i) => worst(`s${i}`, "space"));
    const prompt = buildDoerMemoryPrompt({ aboutYou, space });
    expect(prompt.length).toBeLessThanOrEqual(DOER_MEMORY_MAX_PROMPT_CHARS);
    expect(prompt.length).toBeGreaterThan(DOER_MEMORY_MAX_PROMPT_CHARS - 600);
    expect(prompt).toContain("use list_memories or search_memories");
    // Fairness: both populated scopes keep at least one complete entry.
    expect(prompt).toContain("About the user");
    expect(prompt).toContain("About this Space");
  });

  it("screens credential-like values but leaves innocent mentions alone", () => {
    expect(findDoerMemorySecretProblem("wifi password: hunter2-hunter2")).not.toBe(null);
    expect(findDoerMemorySecretProblem("My sign-in code is 482916")).toBe(null);
    expect(findDoerMemorySecretProblem("sign-in code: 482916")).not.toBe(null);
    expect(findDoerMemorySecretProblem("sk-abcdef1234567890")).not.toBe(null);
    expect(findDoerMemorySecretProblem("I use a password manager")).toBe(null);
    expect(findDoerMemorySecretProblem("hotpot recipe for Sunday")).toBe(null);
    expect(findDoerMemorySecretProblem("Prefers morning reminders")).toBe(null);
    expect(normalizeDoerMemoryContent("  hello   world \n")).toBe("hello world");
  });
});
