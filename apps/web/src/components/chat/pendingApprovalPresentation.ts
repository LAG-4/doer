import type { PendingApproval } from "../../session-logic";

export interface BuiltInToolApprovalPresentation {
  readonly title: string;
  readonly description: string;
}

// OpenCode surfaces Doer bundled-tool permissions as command approvals whose
// detail is the permission name with underscores replaced by spaces (for
// example the `t3-code_create_document` permission arrives as
// "t3-code create document"). These are product-native actions, not shell
// commands, so they get plain words. Matching uses a switch on the exact
// full detail only: a longer shell command that merely mentions one of these
// names must keep the honest generic command wording. A switch (rather than
// a record lookup) also avoids inherited properties such as
// "constructor" or "__proto__" ever matching as a known action.

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
