import { ApprovalRequestId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

describe("ComposerPendingApprovalPanel", () => {
  it("keeps the complete command readable in the compact row", () => {
    const detail = `bun run release -- ${"x".repeat(500)}\nsecond line`;
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-1"),
          requestKind: "command",
          createdAt: "2026-07-18T00:00:00.000Z",
          detail,
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain(detail);
    expect(markup).not.toContain("Command approval requested");
  });

  it("falls back to the approval kind when the provider sends an empty detail", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-2"),
          requestKind: "file-read",
          createdAt: "2026-07-18T00:00:00.000Z",
          detail: "",
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain("File read approval");
  });

  it("shows the app name and message for an MCP access request", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-safari"),
          requestKind: "mcp-elicitation",
          createdAt: "2026-08-24T00:00:00.000Z",
          appName: "Safari",
          detail: "Allow ChatGPT to use Safari?",
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain(">Safari<");
    expect(markup).toContain("Allow ChatGPT to use Safari?");
  });

  it("preserves the full app name and approval message", () => {
    const appName = "A".repeat(200);
    const detail = "Allow ChatGPT to access the selected application?";
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-long-app-name"),
          requestKind: "mcp-elicitation",
          createdAt: "2026-08-24T00:00:00.000Z",
          appName,
          detail,
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain(appName);
    expect(markup).toContain(detail);
  });

  it("names a known built-in document action plainly but keeps the raw detail under Advanced", () => {
    const detail = "t3-code create document";
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-doc"),
          requestKind: "command",
          createdAt: "2026-07-18T00:00:00.000Z",
          detail,
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain("Create a document");
    expect(markup).toContain("Doer wants to create a document for this Task");
    expect(markup).not.toContain("Doer wants to run a command");
    expect(markup).toContain("Advanced");
    expect(markup).toContain(detail);
  });

  it("keeps honest command wording for shell text that merely mentions the tool", () => {
    const detail = "bun run release -- create_document";
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-shell"),
          requestKind: "command",
          createdAt: "2026-07-18T00:00:00.000Z",
          detail,
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain("Command approval");
    expect(markup).toContain("Doer wants to run a command");
    expect(markup).not.toContain("Create a document");
    expect(markup).toContain(detail);
  });
});
