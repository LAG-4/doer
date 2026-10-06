import { useSyncExternalStore } from "react";

/**
 * Records where a new user stands in the first-task onboarding flow.
 *
 * The gate's `onboardingCompletedAt` (in client settings) stays the only
 * thing that routes to or away from onboarding. This record, kept in
 * localStorage next to it, distinguishes *skipping* onboarding from
 * *completing* the first task, and lets a user who leaves mid-task find
 * that task again. `packages/contracts` is untouched on purpose.
 */

export type FirstTaskStatus = "pending" | "succeeded" | "skipped";

export interface FirstTaskThreadPointer {
  readonly environmentId: string;
  readonly threadId: string;
}

export interface FirstTaskRecord {
  readonly status: FirstTaskStatus;
  /** Null for skipped onboarding, which names no task. */
  readonly thread: FirstTaskThreadPointer | null;
  readonly fileName: string;
  /** True once the follow-up dialog has been shown and acknowledged. */
  readonly followUpDismissed: boolean;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

const FIRST_TASK_STORAGE_KEY = "doer.first-task.v1";

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

// The hook snapshot must be referentially stable while the stored bytes are
// unchanged, or every parent re-render would look like a record change.
let cachedRaw: string | null | "unread" = "unread";
let cachedRecord: FirstTaskRecord | null = null;

function parseRecord(raw: string | null): FirstTaskRecord | null {
  try {
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<FirstTaskRecord>;
    if (
      parsed.status !== "pending" &&
      parsed.status !== "succeeded" &&
      parsed.status !== "skipped"
    ) {
      return null;
    }
    const thread = (parsed as { thread?: unknown }).thread;
    if (parsed.status === "skipped") {
      if (thread !== null && thread !== undefined) return null;
    } else {
      if (
        typeof thread !== "object" ||
        thread === null ||
        typeof (thread as { environmentId?: unknown }).environmentId !== "string" ||
        typeof (thread as { threadId?: unknown }).threadId !== "string"
      ) {
        return null;
      }
    }
    const pointer =
      thread === null || thread === undefined
        ? null
        : {
            environmentId: (thread as { environmentId: string }).environmentId,
            threadId: (thread as { threadId: string }).threadId,
          };
    return {
      status: parsed.status,
      thread: pointer,
      fileName: typeof parsed.fileName === "string" ? parsed.fileName : "",
      followUpDismissed: parsed.followUpDismissed === true,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
      completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : null,
    };
  } catch {
    return null;
  }
}

/** Snapshot behind the hook; also the unit-testable core. */
export function readFirstTaskRecord(): FirstTaskRecord | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(FIRST_TASK_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === cachedRaw) return cachedRecord;
  cachedRaw = raw;
  cachedRecord = parseRecord(raw);
  return cachedRecord;
}

export function writeFirstTaskRecord(record: FirstTaskRecord): void {
  try {
    window.localStorage.setItem(FIRST_TASK_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // A full or blocked store must never break onboarding; the in-memory
    // task still works, it just won't survive a reload.
  }
  emit();
}

export function updateFirstTaskRecord(
  update: (current: FirstTaskRecord | null) => FirstTaskRecord | null,
): void {
  const next = update(readFirstTaskRecord());
  // An unchanged reference means "no transition": skip the write so watcher
  // effects observing the record never re-fire on their own output.
  if (next === null || next === readFirstTaskRecord()) return;
  writeFirstTaskRecord(next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === FIRST_TASK_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The current first-task record, reactive across tabs and writers. */
export function useFirstTaskRecord(): FirstTaskRecord | null {
  return useSyncExternalStore(subscribe, readFirstTaskRecord, () => null);
}
