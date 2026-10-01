import {
  MessageId,
  ThreadId,
  TurnId,
  type AutomationRun,
  type OrchestrationLatestTurn,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { scheduledRunStatus } from "./scheduledTaskStatus";

const firedAt = "2026-10-01T03:30:00.000Z";
const run: AutomationRun = {
  occurrenceKey: "practice-once",
  threadId: ThreadId.make("practice"),
  firedAt,
  outcome: "manual",
};
function thread(state: OrchestrationLatestTurn["state"], result = false) {
  return {
    latestTurn: {
      turnId: TurnId.make("practice-turn"),
      state,
      requestedAt: firedAt,
      startedAt: firedAt,
      completedAt: state === "running" ? null : firedAt,
      assistantMessageId: result ? MessageId.make("practice-result") : null,
    },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: null,
  };
}
describe("reminder results", () => {
  it("does not call a fired or exhausted schedule successful before work finishes", () => {
    expect(scheduledRunStatus(undefined, null)).toBe("Not run yet");
    expect(scheduledRunStatus(run, thread("running", true))).toBe("Running");
    expect(scheduledRunStatus(run, thread("completed", true))).toBe("Finished · open result");
    expect(scheduledRunStatus(run, thread("completed"))).toBe(
      "Finished without a result · check Task",
    );
    expect(scheduledRunStatus(run, thread("error", true))).toBe("Failed · open Task to retry");
    expect(scheduledRunStatus(run, thread("interrupted", true))).toBe(
      "Stopped · open Task to retry",
    );
  });
  it("shows approvals and unanswered questions as actionable attention", () => {
    expect(scheduledRunStatus(run, { ...thread("running"), hasPendingApprovals: true })).toBe(
      "Needs your attention",
    );
    expect(scheduledRunStatus(run, { ...thread("running"), hasPendingUserInput: true })).toBe(
      "Needs your attention",
    );
  });
  it("never assigns a later turn's result to an earlier reminder", () => {
    const later = thread("completed", true);
    later.latestTurn.requestedAt = "2026-10-01T04:30:00.000Z";
    expect(scheduledRunStatus(run, later)).toBe("Open Task for this run’s result");
    expect(scheduledRunStatus(run, null)).toBe("Open Task for this run’s result");
  });
});
