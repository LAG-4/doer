import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { CommandId, type ProjectId, type ScopedProjectRef } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { findInboxProjectRef } from "../inboxProject.logic";
import { markInboxProvisioning, unmarkInboxProvisioning } from "../inboxProvisioning";
import { newProjectId } from "../lib/utils";
import { readProjects } from "../state/entities";
import { usePrimaryEnvironment } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { primaryServerWelcomeAtom } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * Title of the auto-provisioned inbox. Mirrors INBOX_PROJECT_TITLE in
 * apps/server/src/inbox/InboxWorkspace.ts; the server reuses the inbox by
 * workspace root, so the title only matters for fresh creates.
 */
const INBOX_PROJECT_TITLE = "My Stuff";

/** How long to wait for a created inbox to land in the project store. */
const ENSURE_INBOX_STORE_ATTEMPTS = 50;
const ENSURE_INBOX_STORE_POLL_MS = 100;

export interface PreparedInboxProject {
  readonly ref: ScopedProjectRef;
  readonly projectId: ProjectId;
  /** False when the inbox already exists and nothing needs settling. */
  readonly isNew: boolean;
}

/**
 * One-click recovery for the no-folder path.
 *
 * Opening a chat never waits for creation: `prepareInboxProject` returns the
 * existing inbox ref, or mints an id, marks it provisioning, and returns it
 * synchronously so the caller can navigate instantly. `settleInboxProject`
 * then creates the project in the background; the draft shows a setup state
 * until the row lands in the store. Servers too old to describe the inbox
 * in the welcome payload are not capable and keep the old add-project flow.
 */
export function useEnsureInboxProject() {
  const serverWelcome = useAtomValue(primaryServerWelcomeAtom);
  const primaryEnvironment = usePrimaryEnvironment();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const [isEnsuring, setIsEnsuring] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const inboxProjectId = serverWelcome?.inboxProjectId;
  const inboxWorkspaceRoot = serverWelcome?.inboxWorkspaceRoot;
  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  const isInboxCapable = inboxWorkspaceRoot !== undefined && primaryEnvironmentId !== null;

  const prepareInboxProject = useCallback((): PreparedInboxProject | null => {
    const known = findInboxProjectRef(readProjects(), { inboxProjectId, inboxWorkspaceRoot });
    if (known !== null) {
      return { ref: known, projectId: known.projectId, isNew: false };
    }
    if (primaryEnvironmentId === null || inboxWorkspaceRoot === undefined) {
      return null;
    }
    const projectId = newProjectId();
    markInboxProvisioning(projectId);
    return {
      ref: scopeProjectRef(primaryEnvironmentId, projectId),
      projectId,
      isNew: true,
    };
  }, [inboxProjectId, inboxWorkspaceRoot, primaryEnvironmentId]);

  const settleInboxProject = useCallback(
    async (projectId: ProjectId): Promise<ScopedProjectRef | null> => {
      if (primaryEnvironmentId === null || inboxWorkspaceRoot === undefined) {
        unmarkInboxProvisioning(projectId);
        return null;
      }
      if (mountedRef.current) {
        setIsEnsuring(true);
      }
      try {
        // The store snapshot can land just after prepare ran (e.g. a slow
        // first sync racing a startup-provisioned inbox). Prefer it over a
        // doomed duplicate create.
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const existing = findInboxProjectRef(readProjects(), {
            inboxProjectId,
            inboxWorkspaceRoot,
          });
          if (existing !== null) {
            return existing;
          }
          await new Promise((resolve) => setTimeout(resolve, ENSURE_INBOX_STORE_POLL_MS));
        }
        // A concurrent create from another client fails here with a
        // duplicate root while its row lands the same way, so both paths
        // converge on the store reads below.
        await createProject({
          environmentId: primaryEnvironmentId,
          input: {
            projectId,
            commandId: CommandId.make(`inbox:project:create:${projectId}`),
            title: INBOX_PROJECT_TITLE,
            workspaceRoot: inboxWorkspaceRoot,
            createWorkspaceRootIfMissing: true,
            defaultModelSelection: null,
          },
        });
        for (let attempt = 0; attempt < ENSURE_INBOX_STORE_ATTEMPTS; attempt += 1) {
          const found = findInboxProjectRef(readProjects(), {
            inboxProjectId: projectId,
            inboxWorkspaceRoot,
          });
          if (found !== null) {
            return found;
          }
          await new Promise((resolve) => setTimeout(resolve, ENSURE_INBOX_STORE_POLL_MS));
        }
        return findInboxProjectRef(readProjects(), { inboxProjectId, inboxWorkspaceRoot });
      } finally {
        unmarkInboxProvisioning(projectId);
        if (mountedRef.current) {
          setIsEnsuring(false);
        }
      }
    },
    [createProject, inboxProjectId, inboxWorkspaceRoot, primaryEnvironmentId],
  );

  return { prepareInboxProject, settleInboxProject, isInboxCapable, isEnsuring };
}
