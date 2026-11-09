/**
 * Tracks inbox projects with creation still in flight.
 * Module-local and never persisted; a reload re-derives from the store.
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
