import { useState } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useComposerHandleContext } from "~/composerHandleContext";
import { useThreadShell } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadTurnInterruptInput } from "../ChatView.logic";
import { Button } from "../ui/button";

/** Users sign in on the site itself, then continue the same Task with its existing work. */
export function BrowserHandoff({ threadRef }: { threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(threadRef);
  const composer = useComposerHandleContext();
  const interrupt = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const running = thread?.session?.status === "running" || thread?.latestTurn?.state === "running";
  async function pause() {
    if (!thread || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await interrupt({
        environmentId: threadRef.environmentId,
        input: buildThreadTurnInterruptInput(thread),
      });
      setMessage(
        result._tag === "Failure"
          ? "Could not pause Doer. Check the connection before taking control."
          : "Pausing Doer. Wait for it to stop before signing in.",
      );
    } finally {
      setBusy(false);
    }
  }
  function continueWith(text: string) {
    if (!composer?.current?.insertTextAtEnd(text, { ensureLeadingBoundary: true })) {
      setMessage("Tell Doer in the message box when you are ready to continue.");
      return;
    }
    composer.current.focusAtEnd();
    setMessage("Review the continuation request in the message box, then send it.");
  }
  return (
    <details className="shrink-0 border-t px-3 py-2 text-xs">
      <summary className="cursor-pointer font-medium">Sign-in and site problems</summary>
      <div className="flex flex-col gap-2 pt-2">
        <p className="text-muted-foreground">
          Pause Doer before taking control. Sign in or complete verification on the site; keep
          passwords and codes out of chat. Return here to continue the same Task.
        </p>
        <div className="flex flex-wrap gap-2">
          {running ? (
            <Button size="xs" variant="outline" disabled={busy} onClick={() => void pause()}>
              Pause and take control
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            disabled={busy || running}
            onClick={() =>
              continueWith(
                "I'm ready to continue on the open browser page. Verify that sign-in or verification succeeded, keep the work already completed in this Task, and continue from the last successful step. Ask me again if the site still needs my input.",
              )
            }
          >
            I'm ready to continue
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy || running}
            onClick={() =>
              continueWith(
                "This site is blocked or its session was lost. Keep the work already completed in this Task. Explain what is still missing and offer a manual handoff or another source. Do not restart everything or submit anything without my review.",
              )
            }
          >
            This site isn't working
          </Button>
        </div>
        {message ? <p role="status">{message}</p> : null}
      </div>
    </details>
  );
}
