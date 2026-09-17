import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

export interface InboxProjectCandidate {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}

export interface InboxIdentity {
  readonly inboxProjectId?: string | undefined;
  readonly inboxWorkspaceRoot?: string | undefined;
}

/**
 * Finds the auto-provisioned inbox ("My Stuff") among loaded projects,
 * preferring the welcome payload's project id and falling back to the
 * workspace root (covers recreations after the user deletes it).
 */
export function findInboxProjectRef(
  projects: ReadonlyArray<InboxProjectCandidate>,
  inbox: InboxIdentity,
): ScopedProjectRef | null {
  if (inbox.inboxProjectId !== undefined) {
    const byId = projects.find((project) => project.id === inbox.inboxProjectId);
    if (byId !== undefined) {
      return scopeProjectRef(byId.environmentId, byId.id);
    }
  }
  if (inbox.inboxWorkspaceRoot !== undefined) {
    const wantRoot = normalizeProjectPathForComparison(inbox.inboxWorkspaceRoot);
    const byRoot = projects.find(
      (project) => normalizeProjectPathForComparison(project.workspaceRoot) === wantRoot,
    );
    if (byRoot !== undefined) {
      return scopeProjectRef(byRoot.environmentId, byRoot.id);
    }
  }
  return null;
}
