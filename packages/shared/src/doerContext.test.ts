import { describe, expect, it } from "vite-plus/test";
import { buildDoerContextPrompt, EMPTY_DOER_CONTEXT, parseDoerContext } from "./doerContext.ts";
describe("saved Doer context", () => {
  it("forgets empty context and preserves scope and explicit preferences", () => {
    expect(buildDoerContextPrompt({ personal: EMPTY_DOER_CONTEXT })).toBe("");
    const prompt = buildDoerContextPrompt({
      personal: { ...EMPTY_DOER_CONTEXT, preferences: "Use rupees" },
      space: { ...EMPTY_DOER_CONTEXT, about: "Work reports" },
    });
    expect(prompt).toContain("Personal preferences (all Spaces");
    expect(prompt).toContain("Work reports");
    expect(prompt).toContain("current request takes precedence");
  });
  it("rejects malformed or oversized saved details instead of silently inventing defaults", () => {
    expect(() => parseDoerContext("bad json")).toThrow();
    expect(() =>
      parseDoerContext(JSON.stringify({ ...EMPTY_DOER_CONTEXT, remembered: "x".repeat(8001) })),
    ).toThrow();
    expect(parseDoerContext(JSON.stringify({ ...EMPTY_DOER_CONTEXT, about: "Trip" }))).toEqual({
      ...EMPTY_DOER_CONTEXT,
      about: "Trip",
    });
  });
});
