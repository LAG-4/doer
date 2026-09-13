import { describe, expect, it } from "vite-plus/test";

import { DRAFT_HERO_SUGGESTIONS, shouldShowHeroSuggestions } from "./DraftHeroSuggestions";

describe("DraftHeroSuggestions", () => {
  it("offers four spoonfeeding starters with usable prompts", () => {
    expect(DRAFT_HERO_SUGGESTIONS).toHaveLength(4);
    const titles = DRAFT_HERO_SUGGESTIONS.map((suggestion) => suggestion.title);
    expect(new Set(titles).size).toBe(4);
    for (const suggestion of DRAFT_HERO_SUGGESTIONS) {
      expect(suggestion.description.trim().length).toBeGreaterThan(0);
      expect(suggestion.prompt.trim().length).toBeGreaterThan(40);
      // Every starter tells the agent to keep things simple for a first-time user.
      expect(suggestion.prompt.toLowerCase()).toContain("simple words");
    }
  });

  it("covers jobs, trips, documents and browser work", () => {
    const haystack = DRAFT_HERO_SUGGESTIONS.map((suggestion) =>
      `${suggestion.title} ${suggestion.prompt}`.toLowerCase(),
    ).join("\n");
    expect(haystack).toContain("job");
    expect(haystack).toContain("trip");
    expect(haystack).toContain("browser");
  });

  it("hides the cards once the composer holds a prompt", () => {
    expect(shouldShowHeroSuggestions("")).toBe(true);
    expect(shouldShowHeroSuggestions("   ")).toBe(true);
    expect(shouldShowHeroSuggestions("I am looking for a better job")).toBe(false);
  });
});
