import { useCallback, useState } from "react";

import { APP_VERSION } from "../../branding";
import { buildSupportSummary } from "../../support/buildSupportSummary";
import { SettingsSectionBody } from "./settingsLayout";
import { Button } from "../ui/button";

const SUPPORT_ISSUES_URL = "https://github.com/LAG-4/doer/issues";

function readPlatform(): string {
  if (typeof navigator === "undefined") return "unknown";
  return navigator.platform || navigator.userAgent || "unknown";
}

// Help entry for Settings → General → About. Nothing leaves the machine on
// its own: the user reads the troubleshooting steps, and only a deliberate
// copy puts the safe summary on the clipboard for a GitHub issue.
export function HelpSupportSection({ connection = "unknown" }: { readonly connection?: string }) {
  const [feedback, setFeedback] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);

  const summary = buildSupportSummary({
    appVersion: APP_VERSION,
    platform: readPlatform(),
    connection,
  });

  const handleCopy = useCallback(async () => {
    try {
      const clipboard = navigator.clipboard;
      if (!clipboard || typeof clipboard.writeText !== "function") {
        throw new Error("clipboard unavailable");
      }
      await clipboard.writeText(summary);
      setCopyFailed(false);
      setFeedback("Summary copied. Paste it into your issue — nothing was sent automatically.");
    } catch {
      setCopyFailed(true);
      setFeedback("Copy failed. Select the summary text yourself instead — nothing was sent.");
    }
  }, [summary]);

  return (
    <SettingsSectionBody className="gap-4">
      <div className="max-w-prose space-y-1.5">
        <div className="text-sm font-medium">Help & support</div>
        <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-muted-foreground">
          <li>
            The AI does not answer or looks disconnected: open Settings → AI services for that
            computer, re-enable the provider or sign in again, then start a new task.
          </li>
          <li>Setup failed: open Settings → AI services and choose Try setup again.</li>
          <li>
            Your work is preserved: when available, History lets you review or restore saved file
            changes. Review the task before retrying.
          </li>
          <li>
            An email send looks uncertain: check Gmail before retrying. A lost network response can
            leave delivery uncertain, so never retry blindly.
          </li>
        </ul>
      </div>

      <div className="max-w-prose space-y-2">
        <div className="text-sm font-medium">Report a problem</div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          This report sends nothing automatically.{" "}
          <a
            href={SUPPORT_ISSUES_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            Open a Doer issue on GitHub
          </a>{" "}
          and, only if you choose to share it, copy this summary. It holds just the app version,
          platform, and connection status — never tokens, logs, file contents, or your messages.
        </p>
        <pre
          aria-label="Diagnostic summary preview"
          className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-2xs leading-relaxed text-muted-foreground"
        >
          {summary}
        </pre>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={handleCopy}>
            Copy summary
          </Button>
        </div>
        {feedback ? (
          <p
            role="status"
            className={
              copyFailed
                ? "text-xs text-destructive-foreground"
                : "max-w-prose text-xs text-muted-foreground"
            }
          >
            {feedback}
          </p>
        ) : null}
      </div>
    </SettingsSectionBody>
  );
}
