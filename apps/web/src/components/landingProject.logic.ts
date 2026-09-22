import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";

import { sortScopedProjectsForSidebar } from "./Sidebar.logic";

/**
 * Shared landing rule: the index route and the post-tour handoff open a
 * draft in the same project, so finishing the tour never flashes an
 * intermediate screen. No-folder chats belong in the auto-provisioned
 * inbox while the user has no chats outside it; otherwise the most
 * recently active project wins. Falls back to null (caller shows its own
 * hero) when shells are not bootstrapped yet.
 */
export function resolveLandingProject(input: {
  readonly bootstrapped: boolean;
  readonly inboxProjectId: string | undefined;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}): EnvironmentProject | null {
  if (!input.bootstrapped) {
    return null;
  }
  if (input.inboxProjectId !== undefined) {
    const inboxProject = input.projects.find((project) => project.id === input.inboxProjectId);
    const hasNonInboxThreads = input.threads.some(
      (thread) => thread.projectId !== input.inboxProjectId,
    );
    if (inboxProject && !hasNonInboxThreads) {
      return inboxProject;
    }
  }
  return sortScopedProjectsForSidebar(input.projects, input.threads, "updated_at")[0] ?? null;
}
