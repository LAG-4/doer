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

export function markInboxProvisioning(projectId: string): void {
  if (!pendingProjectIds.has(projectId)) {
    pendingProjectIds.add(projectId);
  }
}

export function unmarkInboxProvisioning(projectId: string): void {
  pendingProjectIds.delete(projectId);
}

/** Current provisioning state used by launch recovery. */
export function readInboxProvisioning(projectId: string | null): boolean {
  return projectId !== null && pendingProjectIds.has(projectId);
}
