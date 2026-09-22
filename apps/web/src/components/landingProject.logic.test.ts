import { describe, expect, it } from "vite-plus/test";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { resolveLandingProject } from "./landingProject.logic";

const environmentId = EnvironmentId.make("environment-local");

function makeProject(
  overrides: Omit<Partial<EnvironmentProject>, "id"> & { readonly id: string },
): EnvironmentProject {
  return {
    environmentId,
    title: "Project",
    workspaceRoot: "/tmp/project",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    ...overrides,
    id: ProjectId.make(overrides.id),
  };
}

function makeThread(
  overrides: Omit<Partial<EnvironmentThreadShell>, "projectId"> & { readonly projectId: string },
): EnvironmentThreadShell {
  return {
    environmentId,
    id: ThreadId.make("thread-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4" as EnvironmentThreadShell["modelSelection"]["model"],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:02:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
    projectId: ProjectId.make(overrides.projectId),
  };
}

describe("resolveLandingProject", () => {
  it("returns null before shells bootstrap", () => {
    const projects = [makeProject({ id: "project-1" })];
    expect(
      resolveLandingProject({
        bootstrapped: false,
        inboxProjectId: undefined,
        projects,
        threads: [],
      }),
    ).toBeNull();
  });

  it("prefers the inbox while the user has no chats outside it", () => {
    const projects = [
      makeProject({ id: "inbox", title: "My Stuff" }),
      makeProject({ id: "server", title: "server", updatedAt: "2026-03-09T11:00:00.000Z" }),
    ];
    expect(
      resolveLandingProject({
        bootstrapped: true,
        inboxProjectId: "inbox",
        projects,
        threads: [],
      })?.id,
    ).toBe("inbox");
  });

  it("leaves the inbox once a chat exists outside it", () => {
    const projects = [
      makeProject({ id: "inbox", title: "My Stuff" }),
      makeProject({ id: "server", title: "server", updatedAt: "2026-03-09T11:00:00.000Z" }),
    ];
    const threads = [makeThread({ projectId: "server" })];
    expect(
      resolveLandingProject({
        bootstrapped: true,
        inboxProjectId: "inbox",
        projects,
        threads,
      })?.id,
    ).toBe("server");
  });

  it("falls back to the most recently active project without an inbox", () => {
    const projects = [
      makeProject({ id: "old", title: "Old", updatedAt: "2026-03-09T10:00:00.000Z" }),
      makeProject({ id: "new", title: "New", updatedAt: "2026-03-09T11:00:00.000Z" }),
    ];
    expect(
      resolveLandingProject({
        bootstrapped: true,
        inboxProjectId: undefined,
        projects,
        threads: [],
      })?.id,
    ).toBe("new");
  });

  it("returns null with no projects", () => {
    expect(
      resolveLandingProject({
        bootstrapped: true,
        inboxProjectId: undefined,
        projects: [],
        threads: [],
      }),
    ).toBeNull();
  });
});
