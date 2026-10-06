import { PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@t3tools/contracts";

/**
 * Pure helpers for the first-task onboarding experience.
 *
 * A first task only counts as a success when the turn finishes with
 * substantive assistant output and no terminal failure. Starting a task,
 * finishing setup, or dismissing onboarding never counts.
 */

export type FirstTaskTurnOutcome = "waiting" | "running" | "succeeded" | "failed";

/** Assistant text shorter than this never counts as a first-task result. */
export const FIRST_TASK_MIN_ASSISTANT_CHARS = 20;

export interface FirstTaskTurnSnapshot {
  readonly latestTurn: {
    readonly turnId: string;
    readonly state: "running" | "interrupted" | "completed" | "error";
    readonly assistantMessageId: string | null;
  } | null;
  readonly session: { readonly status: string } | null;
  readonly messages: ReadonlyArray<{
    readonly role: string;
    readonly text: string;
    readonly turnId: string | null;
  }>;
}

/**
 * Classifies the first turn of an onboarding task. Mirrors the sidebar's
 * failure rule (turn error or session error is terminal) and additionally
 * requires real assistant text before reporting success, so a completed
 * turn whose detail is still syncing reads as waiting rather than done.
 */
export function getFirstTaskTurnOutcome(
  thread: FirstTaskTurnSnapshot | null,
): FirstTaskTurnOutcome {
  if (thread === null) return "waiting";
  if (thread.latestTurn?.state === "error" || thread.session?.status === "error") {
    return "failed";
  }
  const turn = thread.latestTurn;
  if (turn === null) return "waiting";
  if (turn.state === "completed") {
    const assistantText = thread.messages
      .filter(
        (message) =>
          (message.role === "assistant" || message.role === "reasoning") &&
          message.turnId === turn.turnId,
      )
      .map((message) => message.text.trim())
      .join("\n")
      .trim();
    return assistantText.length >= FIRST_TASK_MIN_ASSISTANT_CHARS ? "succeeded" : "waiting";
  }
  if (turn.state === "running" || thread.session?.status === "running") {
    return "running";
  }
  return "waiting";
}

export type FirstTaskFileCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/**
 * Rejects files the send path would refuse, with wording a new user can
 * act on. The upload pipeline caps files at
 * PROVIDER_SEND_TURN_MAX_FILE_BYTES and refuses empty files.
 */
export function checkFirstTaskFile(file: { readonly size: number }): FirstTaskFileCheck {
  if (file.size <= 0) {
    return { ok: false, message: "That file is empty. Choose a file with content in it." };
  }
  if (file.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
    const maxMb = Math.round(PROVIDER_SEND_TURN_MAX_FILE_BYTES / (1024 * 1024));
    return {
      ok: false,
      message: `That file is too large to explain (limit ${maxMb} MB). Try a smaller document.`,
    };
  }
  return { ok: true };
}

/** "1.2 MB" style size for the review screen's file chip. */
export function formatFirstTaskFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}
