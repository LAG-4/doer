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
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { INBOX_PROJECT_TITLE, resolveInboxRoot } from "./InboxWorkspace.ts";

export const resolveInboxWelcomeTargets = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const path = yield* Path.Path;
  const homeDir = yield* HostProcessHomeDirectory;
  const projectionReadModelQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;

  const inboxRoot = resolveInboxRoot(homeDir, path);
  const existingProject =
    yield* projectionReadModelQuery.getActiveProjectByWorkspaceRoot(inboxRoot);
  if (Option.isSome(existingProject)) {
    return {
      inboxProjectId: existingProject.value.id,
      inboxProjectCreated: false,
      inboxWorkspaceRoot: existingProject.value.workspaceRoot,
    } as const;
  }

  const createdAt = DateTime.formatIso(yield* DateTime.now);
  const inboxProjectId = ProjectId.make(yield* randomUUID);
  yield* orchestrationEngine.dispatch({
    type: "project.create",
    commandId: CommandId.make(yield* randomUUID),
    projectId: inboxProjectId,
    title: INBOX_PROJECT_TITLE,
    workspaceRoot: inboxRoot,
    createWorkspaceRootIfMissing: true,
    createdAt,
  });
  return { inboxProjectId, inboxProjectCreated: true, inboxWorkspaceRoot: inboxRoot } as const;
}).pipe(
  Effect.catchCause((cause) =>
    Cause.hasInterrupts(cause)
      ? Effect.failCause(cause)
      : Effect.logWarning("inbox workspace provisioning failed", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as({} as const)),
  ),
);
