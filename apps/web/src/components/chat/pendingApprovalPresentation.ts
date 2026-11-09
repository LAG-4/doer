import type { PendingApproval } from "../../session-logic";

export interface BuiltInToolApprovalPresentation {
  readonly title: string;
  readonly description: string;
}

// Doer bundled-tool approvals arrive as command approvals; match on the
// exact full detail so longer shell commands keep generic wording.

/** Plain presentation for known Doer built-in tool approvals, else null. */
export function describeBuiltInToolApproval(approval: {
  readonly requestKind: PendingApproval["requestKind"];
  readonly detail?: string | undefined;
}): BuiltInToolApprovalPresentation | null {
  if (approval.requestKind !== "command") return null;
  switch ((approval.detail ?? "").trim()) {
    case "t3-code create document":
      return {
        title: "Create a document",
        description:
          "Doer wants to create a document for this Task. Nothing happens until you approve.",
      };
    case "t3-code create spreadsheet":
      return {
        title: "Create a spreadsheet",
        description:
          "Doer wants to create a spreadsheet for this Task. Nothing happens until you approve.",
      };
    case "t3-code create presentation":
      return {
        title: "Create a presentation",
        description:
          "Doer wants to create a presentation for this Task. Nothing happens until you approve.",
      };
    default:
      return null;
  }
}
