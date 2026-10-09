// Safe, user-approved diagnostic summary for support requests.
//
// The summary pulls only known safe fields (app version, platform,
// connection status). Anything sensitive (tokens, queries, logs, paths,
// message contents) is never collected here in the first place.

export interface SupportSummaryInput {
  readonly appVersion: string;
  readonly platform: string;
  readonly connection: string;
}

function oneLine(value: string): string {
  const first = value.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return first.slice(0, 120) || "unknown";
}

export function buildSupportSummary(input: SupportSummaryInput): string {
  return [
    "Doer support summary",
    `App version: ${oneLine(input.appVersion)}`,
    `Platform: ${oneLine(input.platform)}`,
    `Connection: ${oneLine(input.connection)}`,
    "Includes only: app version, platform, connection status.",
    "Includes no tokens, passwords, logs, file paths, or message contents.",
  ].join("\n");
}
