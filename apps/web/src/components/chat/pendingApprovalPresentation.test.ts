import { describe, expect, it } from "vite-plus/test";

import { describeBuiltInToolApproval } from "./pendingApprovalPresentation";

describe("describeBuiltInToolApproval", () => {
  it.each([
    ["t3-code create document", "Create a document", "create a document"],
    ["t3-code create spreadsheet", "Create a spreadsheet", "create a spreadsheet"],
    ["t3-code create presentation", "Create a presentation", "create a presentation"],
  ])("names the built-in action %s plainly", (detail, title, phrase) => {
    const presentation = describeBuiltInToolApproval({ requestKind: "command", detail });

    expect(presentation?.title).toBe(title);
    expect(presentation?.description).toContain(phrase);
    expect(presentation?.description).not.toContain("run a command");
  });

  it("ignores the same detail on non-command kinds", () => {
    expect(
      describeBuiltInToolApproval({
        requestKind: "file-change",
        detail: "t3-code create document",
      }),
    ).toBeNull();
  });

  it.each([
    "bun run release -- create_document",
    "t3-code create document --extra-flag",
    "run t3-code create document now",
    "echo t3-code create document",
  ])("keeps honest command wording for longer shell text %s", (detail) => {
    expect(describeBuiltInToolApproval({ requestKind: "command", detail })).toBeNull();
  });

  it.each(["", "   ", undefined])("returns null when there is no detail (%s)", (detail) => {
    expect(describeBuiltInToolApproval({ requestKind: "command", detail })).toBeNull();
  });

  it("returns null for unknown commands", () => {
    expect(
      describeBuiltInToolApproval({ requestKind: "command", detail: "bun run lint" }),
    ).toBeNull();
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"])(
    "never matches inherited object properties (%s)",
    (detail) => {
      expect(describeBuiltInToolApproval({ requestKind: "command", detail })).toBeNull();
    },
  );
});
