import { memo } from "react";
import { type PendingApproval } from "../../session-logic";
import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "~/lib/utils";
import { describeBuiltInToolApproval } from "./pendingApprovalPresentation";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  className?: string;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
  className,
}: ComposerPendingApprovalPanelProps) {
  const Detail = approval.requestKind === "mcp-elicitation" ? "span" : "code";
  const isEmail = approval.requestId.startsWith("gmail-send:");
  const isMailChange = approval.requestId.startsWith("gmail-change:");
  // Known Doer built-in tool actions arrive as command approvals (the backend
  // only maps read/edit vs command). Name them plainly instead of showing a
  // generic "run a command" explanation for product-native work.
  const builtIn = describeBuiltInToolApproval(approval);
  const fallbackLabel = builtIn
    ? builtIn.title
    : isEmail
      ? "Review email before sending"
      : isMailChange
        ? "Review Gmail change"
        : approval.requestKind === "mcp-elicitation"
          ? "App access approval"
          : approval.requestKind === "command"
            ? "Command approval"
            : approval.requestKind === "file-read"
              ? "File read approval"
              : approval.requestKind === "permission"
                ? "App permission approval"
                : "File change approval";
  const detailAriaLabel = builtIn
    ? builtIn.title
    : isEmail
      ? "Email to send"
      : isMailChange
        ? "Gmail change to apply"
        : approval.requestKind === "mcp-elicitation"
          ? "App access request"
          : approval.requestKind === "command"
            ? "Command"
            : approval.requestKind === "file-read"
              ? "File to read"
              : approval.requestKind === "permission"
                ? "Permission request"
                : "File change";
  // Simple mode keeps raw commands behind an Advanced disclosure: plain
  // words first, with the complete command still mounted for inspection.
  const simpleModeEnabled = useClientSettings((settings) => settings.simpleModeEnabled);
  const collapseCommand =
    simpleModeEnabled &&
    approval.requestKind === "command" &&
    (approval.detail ?? "").trim() !== "";

  return (
    <span
      aria-label={fallbackLabel}
      className={cn("flex min-w-0 flex-1 flex-col items-start gap-1", className)}
      role="group"
    >
      <span className="flex w-full min-w-0 items-center gap-2 text-2xs text-muted-foreground">
        <span className="shrink-0 font-medium text-warning">{fallbackLabel}</span>
        {approval.appName ? <span className="min-w-0 truncate">{approval.appName}</span> : null}
        {pendingCount > 1 ? (
          <span className="ml-auto shrink-0 tabular-nums">1/{pendingCount}</span>
        ) : null}
      </span>
      <Detail
        aria-label={detailAriaLabel}
        className={cn(
          "block max-h-20 w-full min-w-0 overflow-auto text-xs text-foreground [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 [&::-webkit-scrollbar]:h-1.5",
          (isEmail || isMailChange) && "max-h-64",
          approval.requestKind === "mcp-elicitation"
            ? "whitespace-pre-wrap font-sans wrap-break-word"
            : "whitespace-pre font-mono",
        )}
        data-approval-detail="complete"
        tabIndex={0}
      >
        {builtIn ? (
          <>
            <span className="font-sans whitespace-pre-wrap wrap-break-word">
              {builtIn.description}
            </span>{" "}
            <details className="mt-1 font-mono whitespace-pre">
              <summary className="cursor-pointer text-muted-foreground">Advanced</summary>
              {approval.detail}
            </details>
          </>
        ) : collapseCommand ? (
          <>
            <span className="font-sans whitespace-pre-wrap wrap-break-word">
              Doer wants to run a command for this task. Nothing runs until you approve it.
            </span>{" "}
            <details className="mt-1 font-mono whitespace-pre">
              <summary className="cursor-pointer text-muted-foreground">Advanced</summary>
              {approval.detail}
            </details>
          </>
        ) : (
          approval.detail || fallbackLabel
        )}
      </Detail>
    </span>
  );
});
