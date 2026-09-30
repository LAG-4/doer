import type { Automation } from "@t3tools/contracts";

/** Makes a firing distinguishable from a request to create another reminder. */
export function buildAutomationRunPrompt(input: {
  readonly automation: Automation;
  readonly firedAt: string;
  readonly occurrenceKey: string;
  readonly manual?: boolean;
}): string {
  const { automation, firedAt, occurrenceKey } = input;
  return [
    `Run the existing reminder ${JSON.stringify(automation.title)} now.`,
    `Reminder ID: ${automation.id}. ${input.manual ? "Manual run" : "Scheduled run"}: ${occurrenceKey}. Requested at: ${firedAt}.`,
    "The reminder is already set up. Carry out the work below; do not create, duplicate, reschedule, or pause a reminder unless the work explicitly asks for that.",
    "Use the available files and tools, and leave the actual result in this task. Do not promise to do the work later. If access, approval, or missing information prevents completion, explain exactly what is blocked; do not claim success.",
    "",
    automation.prompt,
  ].join("\n");
}
