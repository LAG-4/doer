/**
 * Ensures the inbox workspace (`~/Documents/Doer`) exists on startup.
 * Reuses the active project at the inbox root or creates it when missing.
 * Failures degrade to "no inbox" instead of failing startup.
 */

import { CommandId, ProjectId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as NodeCrypto from "node:crypto";

import * as ProjectService from "../project/ProjectService.ts";
import { INBOX_PROJECT_TITLE, resolveInboxRoot } from "./InboxWorkspace.ts";
import { ServerConfig } from "../config.ts";

export const resolveInboxWelcomeTargets = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const homeDir = yield* HostProcess.HomeDirectory;
  const projects = yield* ProjectService.ProjectService;

  const config = yield* Effect.serviceOption(ServerConfig);
  const inboxRoot =
    Option.isSome(config) && config.value.devUrl !== undefined
      ? path.join(config.value.baseDir, "inbox")
      : resolveInboxRoot(homeDir, path);
  // A project record without its directory chats into "Workspace root does
  // not exist". Ensure the default folder before either branch so fresh
  // installs and pre-existing inbox records both self-repair on startup.
  yield* fileSystem.makeDirectory(inboxRoot, { recursive: true });
  const existingProject = yield* projects.getByWorkspaceRoot(inboxRoot);
  if (Option.isSome(existingProject)) {
    return {
      inboxProjectId: existingProject.value.id,
      inboxProjectCreated: false,
      inboxWorkspaceRoot: existingProject.value.workspaceRoot,
    } as const;
  }

  const { project, created } = yield* projects.bootstrap({
    commandId: CommandId.make(NodeCrypto.randomUUID()),
    projectId: ProjectId.make(NodeCrypto.randomUUID()),
    workspaceRoot: inboxRoot,
    title: INBOX_PROJECT_TITLE,
    createWorkspaceRootIfMissing: true,
  });
  const inboxProjectId = project.id;
  return { inboxProjectId, inboxProjectCreated: created, inboxWorkspaceRoot: inboxRoot } as const;
}).pipe(
  Effect.catchCause((cause) =>
    Cause.hasInterrupts(cause)
      ? Effect.failCause(cause)
      : Effect.logWarning("inbox workspace provisioning failed", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as({} as const)),
  ),
);
