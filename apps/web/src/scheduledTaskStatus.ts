import type { AutomationRun, OrchestrationThreadShell } from "@t3tools/contracts";

/** Schedule exhaustion is independent of the associated work's outcome. */
export function scheduledRunStatus(
  run: AutomationRun | undefined,
  thread: Pick<
    OrchestrationThreadShell,
    "latestTurn" | "hasPendingApprovals" | "hasPendingUserInput" | "session"
  > | null,
): string {
  if (!run) return "Not run yet";
  const turn = thread?.latestTurn;
  // Another turn can follow this run in a shared Task. Do not attribute its outcome to the reminder.
  if (!turn || turn.requestedAt !== run.firedAt) return "Open Task for this run’s result";
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "Needs your attention";
  if (turn.state === "error" || thread.session?.status === "error")
    return "Failed · open Task to retry";
  if (turn.state === "interrupted") return "Stopped · open Task to retry";
  if (turn.state === "running") return "Running";
  return turn.assistantMessageId
    ? "Finished · open result"
    : "Finished without a result · check Task";
}
