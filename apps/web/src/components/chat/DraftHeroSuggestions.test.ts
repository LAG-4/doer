import { describe, expect, it } from "vite-plus/test";

import { DRAFT_HERO_SUGGESTIONS, shouldShowHeroSuggestions } from "./DraftHeroSuggestions";

describe("DraftHeroSuggestions", () => {
  it("offers eight spoonfeeding starters with usable prompts", () => {
    expect(DRAFT_HERO_SUGGESTIONS).toHaveLength(8);
    const titles = DRAFT_HERO_SUGGESTIONS.map((suggestion) => suggestion.title);
    expect(new Set(titles).size).toBe(8);
    for (const suggestion of DRAFT_HERO_SUGGESTIONS) {
      expect(suggestion.description.trim().length).toBeGreaterThan(0);
      expect(suggestion.prompt.trim().length).toBeGreaterThan(40);
      // Every starter tells the agent to keep things simple for a first-time user.
      expect(suggestion.prompt.toLowerCase()).toContain("simple words");
    }
  });

  it("covers jobs, trips, documents, browser work and everyday computer chores", () => {
    const haystack = DRAFT_HERO_SUGGESTIONS.map((suggestion) =>
      `${suggestion.title} ${suggestion.prompt}`.toLowerCase(),
    ).join("\n");
    expect(haystack).toContain("job");
    expect(haystack).toContain("trip");
    expect(haystack).toContain("browser");
    expect(haystack).toContain("printer");
    expect(haystack).toContain("wi-fi");
    expect(haystack).toContain("driver");
    expect(haystack).toContain("form");
  });

  it("asks for the user's OK before touching the computer or submitting anything", () => {
    const computerChores = DRAFT_HERO_SUGGESTIONS.filter((suggestion) =>
      [
        "Fix my printer or Wi-Fi",
        "Set up my computer",
        "Fix a slow computer",
        "Fill a boring form",
      ].includes(suggestion.title),
    );
    expect(computerChores).toHaveLength(4);
    for (const suggestion of computerChores) {
      expect(suggestion.prompt.toLowerCase()).toContain("ask for my ok");
    }
  });

  it("hides the cards once the composer holds a prompt", () => {
    expect(shouldShowHeroSuggestions("")).toBe(true);
    expect(shouldShowHeroSuggestions("   ")).toBe(true);
    expect(shouldShowHeroSuggestions("I am looking for a better job")).toBe(false);
  });
});
