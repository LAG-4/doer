import { PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@t3tools/contracts";

/**
 * Pure helpers for the first-task onboarding experience.
 *
 * A first task only counts as a success when the turn finishes with
 * substantive visible assistant output and no terminal failure. Starting a
 * task, finishing setup, or dismissing onboarding never counts.
 */

export type FirstTaskTurnOutcome = "waiting" | "running" | "succeeded" | "failed" | "stopped";

/** Assistant text shorter than this never counts as a first-task result. */
export const FIRST_TASK_MIN_ASSISTANT_CHARS = 20;

export interface FirstTaskTurnSnapshot {
  readonly latestTurn: {
    readonly turnId: string;
    readonly state: "running" | "interrupted" | "completed" | "error";
    readonly assistantMessageId: string | null;
  } | null;
  readonly session: { readonly status: OrchestrationSessionStatus } | null;
  readonly messages: ReadonlyArray<{
    readonly role: string;
    readonly text: string;
    readonly turnId: string | null;
  }>;
}

/** Visible final assistant text for one turn. Reasoning/thinking never counts. */
export function firstTaskAssistantText(
  messages: FirstTaskTurnSnapshot["messages"],
  turnId: string,
): string {
  return messages
    .filter((message) => message.role === "assistant" && message.turnId === turnId)
    .map((message) => message.text.trim())
    .join("\n")
    .trim();
}

/**
 * The session is still catching up: a finished turn's detail may not have
 * landed yet, since the turn checkpoint and the session update arrive in
 * separate projection events.
 */
function isSessionSyncing(status: OrchestrationSessionStatus | null | undefined): boolean {
  return status === "running" || status === "starting";
}

/** The user stopped the run: retry lives in the same task. */
function isSessionStopped(status: OrchestrationSessionStatus | null | undefined): boolean {
  return status === "stopped" || status === "interrupted";
}

/**
 * Classifies the latest turn of an onboarding task. Mirrors the sidebar's
 * failure rule (turn error or session error is terminal) and additionally
 * requires real visible assistant text before reporting success.
 *
 * Projection order: content streams in while the session runs, then the turn
 * checkpoint marks the turn completed and the session settles to ready in a
 * separate event — so `completed` while the session still shows
 * running/starting reads as `waiting` (detail still syncing). `completed`
 * with no useful text once the session is ready/idle/stopped/interrupted, or
 * with no session left to sync, reads as `failed`, so the follow-up can offer
 * the existing retry path instead of waiting forever. `interrupted` (turn or
 * session) reads as `stopped`. Only the latest turn is classified, so a retry
 * in the same task naturally replaces a previous stopped/failed outcome.
 */
export function getFirstTaskTurnOutcome(
  thread: FirstTaskTurnSnapshot | null,
): FirstTaskTurnOutcome {
  if (thread === null) return "waiting";
  if (thread.latestTurn?.state === "error" || thread.session?.status === "error") {
    return "failed";
  }
  const turn = thread.latestTurn;
  if (turn === null) {
    return isSessionSyncing(thread.session?.status) ? "running" : "waiting";
  }
  if (turn.state === "completed") {
    const assistantText = firstTaskAssistantText(thread.messages, turn.turnId);
    if (assistantText.length >= FIRST_TASK_MIN_ASSISTANT_CHARS) return "succeeded";
    return isSessionSyncing(thread.session?.status) ? "waiting" : "failed";
  }
  if (turn.state === "interrupted") return "stopped";
  if (isSessionStopped(thread.session?.status)) {
    return "stopped";
  }
  if (turn.state === "running" || isSessionSyncing(thread.session?.status)) {
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

type OrchestrationSessionStatus =
  | "idle"
  | "ready"
  | "running"
  | "starting"
  | "stopped"
  | "interrupted"
  | "error";
