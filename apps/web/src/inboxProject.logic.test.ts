import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { findInboxProjectRef } from "./inboxProject.logic";

const inboxProject = {
  id: ProjectId.make("inbox-project"),
  environmentId: EnvironmentId.make("primary-environment"),
  workspaceRoot: "/Users/someone/Documents/Doer",
};
const otherProject = {
  id: ProjectId.make("other-project"),
  environmentId: EnvironmentId.make("primary-environment"),
  workspaceRoot: "/Users/someone/repos/app",
};

describe("findInboxProjectRef", () => {
  it("prefers the welcome project id", () => {
    expect(
      findInboxProjectRef([otherProject, inboxProject], {
        inboxProjectId: "inbox-project",
        inboxWorkspaceRoot: "/Users/someone/Documents/Doer",
      }),
    ).toEqual({
      environmentId: "primary-environment",
      projectId: "inbox-project",
    });
  });

  it("falls back to the workspace root after recreation", () => {
    const recreated = {
      ...inboxProject,
      id: ProjectId.make("inbox-project-v2"),
    };
    expect(
      findInboxProjectRef([otherProject, recreated], {
        inboxProjectId: "inbox-project",
        inboxWorkspaceRoot: "/Users/someone/Documents/Doer/",
      }),
    ).toEqual({
      environmentId: "primary-environment",
      projectId: "inbox-project-v2",
    });
  });

  it("returns null when the inbox is missing", () => {
    expect(
      findInboxProjectRef([otherProject], {
        inboxProjectId: "inbox-project",
        inboxWorkspaceRoot: "/Users/someone/Documents/Doer",
      }),
    ).toBeNull();
  });

  it("returns null without inbox identity", () => {
    expect(findInboxProjectRef([otherProject, inboxProject], {})).toBeNull();
  });
});
