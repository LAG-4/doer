/**
 * InboxProvisioning - ensures the Codex-style no-folder workspace exists.
 *
 * On every startup the server reuses the active project rooted at the inbox
 * root (`~/Documents/Doer`, see `InboxWorkspace`), or creates it (including
 * the directory itself) when missing. The resolved ids flow into the welcome
 * payload so clients can treat an inbox-only workspace as fresh for
 * first-run purposes and land new chats there without asking for a folder.
 * Provisioning failures degrade to "no inbox" instead of failing startup.
 *
 * @module InboxProvisioning
 */

import { CommandId, ProjectId } from "@t3tools/contracts";
import { HostProcessHomeDirectory } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectService from "../project/ProjectService.ts";
import { INBOX_PROJECT_TITLE, resolveInboxRoot } from "./InboxWorkspace.ts";
import { ServerConfig } from "../config.ts";

export const resolveInboxWelcomeTargets = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const homeDir = yield* HostProcessHomeDirectory;
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
    commandId: CommandId.make(yield* randomUUID),
    projectId: ProjectId.make(yield* randomUUID),
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
