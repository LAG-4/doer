import type { MessageId, TurnId } from "@t3tools/contracts";
import type { TurnDiffSummary } from "../../types";

const TASK_OUTPUT_PATH_PATTERN = /\.(?:docx|xlsx|pptx|pdf|html|csv|txt|md)$/i;
const TASK_OUTPUT_DELETE_PATTERN = /delete|removed/i;
const TASK_RESULTS_PATH_LIMIT = 12;

/** Single checkpoint worth of user-facing outputs. Shared with TaskResults. */
function taskOutputPathsForFiles(files: readonly { path: string; kind: string }[]): string[] {
  const kept = new Map<string, string>();
  for (const file of files) {
    if (TASK_OUTPUT_DELETE_PATTERN.test(file.kind)) kept.delete(file.path);
    else if (TASK_OUTPUT_PATH_PATTERN.test(file.path) && !file.path.startsWith("."))
      kept.set(file.path, file.path);
  }
  return [...kept.values()].slice(-TASK_RESULTS_PATH_LIMIT);
}

/**
 * Repeat prompt names the files on this turn's card, so repeating an older
 * turn redoes the work that produced *these* files — never the latest
 * revision or unrelated later work. Plain language, no turn/message ids.
 * Insert-only: the user reviews it in the composer before sending.
 */
export function buildRepeatTaskPrompt(paths: readonly string[]): string {
  const files = paths.length > 0 ? ` that produced ${paths.join(", ")}` : "";
  return (
    `I'd like to repeat the work from this Task${files}. ` +
    "Review the sources, the result to produce, timing and permissions with me " +
    "before saving a reminder. Resolve file references into a self-contained prompt. " +
    "My preferred timing is: "
  );
}

export interface TurnTaskOutputs {
  readonly turnId: TurnId;
  readonly paths: readonly string[];
  readonly completedAt: string;
  readonly assistantMessageId: MessageId | null;
}

/**
 * Reliable per-turn ownership: checkpoints already carry turnId (primary) and
 * assistantMessageId (anchor). Grouping is O(C); callers do O(1) lookups per
 * row so long virtualized histories never rescan per row.
 */
export function deriveTurnTaskOutputs(
  checkpoints: readonly TurnDiffSummary[],
): ReadonlyMap<TurnId, TurnTaskOutputs> {
  const byTurn = new Map<TurnId, TurnTaskOutputs>();
  for (const checkpoint of checkpoints) {
    if (checkpoint.status !== "ready") continue;
    const paths = taskOutputPathsForFiles(checkpoint.files);
    if (paths.length === 0) continue;
    const existing = byTurn.get(checkpoint.turnId);
    if (!existing) {
      byTurn.set(checkpoint.turnId, {
        turnId: checkpoint.turnId,
        paths,
        completedAt: checkpoint.completedAt,
        assistantMessageId: checkpoint.assistantMessageId,
      });
      continue;
    }
    const merged = [...existing.paths];
    for (const path of paths) {
      if (!merged.includes(path)) merged.push(path);
    }
    byTurn.set(checkpoint.turnId, {
      turnId: checkpoint.turnId,
      paths: merged.slice(-TASK_RESULTS_PATH_LIMIT),
      completedAt:
        checkpoint.completedAt > existing.completedAt
          ? checkpoint.completedAt
          : existing.completedAt,
      assistantMessageId: checkpoint.assistantMessageId ?? existing.assistantMessageId,
    });
  }
  return byTurn;
}
