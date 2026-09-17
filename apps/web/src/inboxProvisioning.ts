import { useSyncExternalStore } from "react";

/**
 * Tracks inbox projects with creation still in flight.
 *
 * Opening a no-folder chat navigates instantly with a locally minted
 * project id while the real project.create settles in the background; the
 * draft shows a "setting up" state until the row lands in the project store
 * (or creation fails and the dead-end recovery takes over). Module-local
 * and never persisted: a reload re-derives everything from the store.
 */
const pendingProjectIds = new Set<string>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

export function markInboxProvisioning(projectId: string): void {
  if (!pendingProjectIds.has(projectId)) {
    pendingProjectIds.add(projectId);
    emit();
  }
}

export function unmarkInboxProvisioning(projectId: string): void {
  if (pendingProjectIds.delete(projectId)) {
    emit();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Snapshot behind the hook; also the unit-testable core. */
export function readInboxProvisioning(projectId: string | null): boolean {
  return projectId !== null && pendingProjectIds.has(projectId);
}

/** Whether the given project id is still being provisioned. */
export function useIsInboxProvisioning(projectId: string | null): boolean {
  return useSyncExternalStore(
    subscribe,
    () => readInboxProvisioning(projectId),
    () => false,
  );
}
