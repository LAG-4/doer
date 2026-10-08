import {
  getExperimentalConnections,
  setExperimentalConnections,
  type ExperimentalConnectionsTransport,
} from "@t3tools/client-runtime/experimental-connections";

/**
 * Shared experimental-connections flag cache for one web client.
 *
 * Every mounted consumer (Settings toggle, composer plugin menus, search
 * availability) subscribes to the same per-computer entry, so a toggle in
 * Settings updates all of them without refetching. Sequence numbers guard
 * the whole round trip: a slow GET started before a successful POST can
 * never overwrite the newer value. No polling — consumers load on mount
 * and revalidate on window focus; the server rechecks the flag on every
 * gated call regardless of what the client cached.
 */
export interface ExperimentalConnectionsSnapshot {
  /** Null until the first GET resolves. */
  readonly enabled: boolean | null;
  readonly error: string | null;
}

interface Entry extends ExperimentalConnectionsSnapshot {
  sequence: number;
  /** Whether the last error came from loading the flag or saving a change. */
  errorKind: "load" | "save" | null;
}

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();

// Shared default: getSnapshot must return a stable reference.
const DEFAULT_ENTRY: Entry = { enabled: null, error: null, sequence: 0, errorKind: null };

function read(key: string): Entry {
  return entries.get(key) ?? DEFAULT_ENTRY;
}

function write(key: string, entry: Entry): void {
  entries.set(key, entry);
  listeners.get(key)?.forEach((notify) => notify());
}

export function subscribeExperimentalConnections(key: string, notify: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(notify);
  return () => {
    set.delete(notify);
    if (set.size === 0) listeners.delete(key);
  };
}

export function readExperimentalConnectionsSnapshot(key: string): Entry {
  return read(key);
}

/** Test hook: forget cached computers between tests. */
export function resetExperimentalConnectionsStore(): void {
  entries.clear();
  listeners.clear();
}

export async function refreshExperimentalConnections(
  key: string,
  transport: ExperimentalConnectionsTransport,
): Promise<void> {
  const current = read(key);
  const sequence = current.sequence + 1;
  write(key, { ...current, sequence });
  let enabled: boolean;
  try {
    enabled = await getExperimentalConnections(transport);
  } catch (error) {
    const latest = read(key);
    if (sequence < latest.sequence) return;
    write(key, {
      ...latest,
      sequence,
      errorKind: "load",
      error:
        error instanceof Error
          ? error.message
          : "Could not load the experimental-connections setting.",
    });
    return;
  }
  const latest = read(key);
  if (sequence < latest.sequence) return;
  write(key, { enabled, error: null, sequence, errorKind: null });
}

export async function saveExperimentalConnections(
  key: string,
  transport: ExperimentalConnectionsTransport,
  enabled: boolean,
): Promise<boolean> {
  const current = read(key);
  const sequence = current.sequence + 1;
  write(key, { ...current, sequence });
  let next: boolean;
  try {
    next = await setExperimentalConnections(transport, enabled);
  } catch (error) {
    const latest = read(key);
    if (sequence < latest.sequence) return false;
    // Fail closed like the server (a failed save leaves the service off):
    // never keep a stale `true` that would imply enabled surfaces while
    // the switch is off. Unknown until the next successful load
    // revalidates the real value; the error stays visible meanwhile.
    write(key, {
      ...latest,
      enabled: null,
      sequence,
      errorKind: "save",
      error:
        error instanceof Error
          ? error.message
          : "Could not save the experimental-connections setting.",
    });
    return false;
  }
  const latest = read(key);
  if (sequence < latest.sequence) return true;
  write(key, { enabled: next, error: null, sequence, errorKind: null });
  return true;
}
