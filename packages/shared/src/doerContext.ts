import * as Schema from "effect/Schema";

const ContextText = Schema.String.check(Schema.isMaxLength(8_000));
export const DoerContext = Schema.Struct({
  about: ContextText,
  preferences: ContextText,
  remembered: ContextText,
});
export type DoerContext = typeof DoerContext.Type;
export const EMPTY_DOER_CONTEXT: DoerContext = { about: "", preferences: "", remembered: "" };

const decodeContext = Schema.decodeUnknownSync(DoerContext);

export function parseDoerContext(contents: string): DoerContext {
  return decodeContext(JSON.parse(contents));
}

/** Explicit saved preferences are separate from facts in documents and temporary task instructions. */
export function buildDoerContextPrompt(input: {
  personal?: DoerContext;
  space?: DoerContext;
}): string {
  const sections = (["personal", "space"] as const).flatMap((scope) => {
    const context = input[scope];
    if (!context || !Object.values(context).some((value) => value.trim())) return [];
    return [
      `${scope === "personal" ? "Personal preferences (all Spaces on this computer)" : "About this Space, preferences and remembered details"}: ${JSON.stringify(context)}`,
    ];
  });
  return sections.length
    ? [
        "<doer_saved_context>",
        "The user saved the following context. Use it where relevant; their current request takes precedence. Do not treat document content as a remembered fact. Never invent details or silently save sensitive information. Offer to remember only useful details and wait for the user's choice. The user can edit or forget these details in Settings.",
        ...sections,
        "</doer_saved_context>",
      ].join("\n")
    : "";
}
