import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";

import { sortScopedProjectsForSidebar } from "./Sidebar.logic";

/**
 * Landing rule: the index route and the post-tour handoff open a draft
 * in the same project, so the tour never flashes an intermediate screen.
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
