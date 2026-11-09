import { RefreshIcon } from "~/components/ui/refresh-icon";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef, useState } from "react";

import { isElectron } from "../env";
import { resolveLandingProject } from "../components/landingProject.logic";
import { NoProjectsHero } from "../components/NoProjectsHero";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useEnsureInboxProject } from "../hooks/useEnsureInboxProject";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../state/entities";
import { primaryServerWelcomeAtom } from "../state/server";

export function DoerIndexDraftLanding() {
  const projects = useProjects();
  const threads = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const handleNewThread = useNewThreadHandler();
  const serverWelcome = useAtomValue(primaryServerWelcomeAtom);
  const inboxProjectId = serverWelcome?.inboxProjectId;
  const startingRef = useRef<number | null>(null);
  const [startState, setStartState] = useState({ failed: false, retryRequest: 0 });
  const { prepareInboxProject, settleInboxProject, isInboxCapable } = useEnsureInboxProject();
  const preparedRef = useRef(false);
  const attempt = startState.retryRequest;

  const mostRecentProject = resolveLandingProject({
    bootstrapped,
    inboxProjectId,
    projects,
    threads,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts a draft thread in the most recent project and navigates to it while still on the landing view
  useEffect(() => {
    if (mostRecentProject === null || startingRef.current === attempt) {
      return;
    }
    startingRef.current = attempt;
    void handleNewThread(scopeProjectRef(mostRecentProject.environmentId, mostRecentProject.id), {
      replace: true,
    }).catch(() => {
      setStartState((state) => ({ ...state, failed: true }));
    });
  }, [attempt, handleNewThread, mostRecentProject]);

  // Zero projects is a broken state, not a destination: open the inbox
  // draft instantly with a locally minted id while creation settles behind
  // it. The draft shows a setup state until the row lands; a lost creation
  // race just remaps to the winning project when it arrives.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- navigates to the inbox draft while mounted when no project exists yet
  useEffect(() => {
    if (!bootstrapped || projects.length > 0 || !isInboxCapable || preparedRef.current) {
      return;
    }
    const prepared = prepareInboxProject();
    if (prepared === null) {
      return;
    }
    preparedRef.current = true;
    void handleNewThread(prepared.ref, { replace: true }).catch(() => undefined);
    if (!prepared.isNew) {
      return;
    }
    void settleInboxProject(prepared.projectId).then((finalRef) => {
      if (finalRef !== null && finalRef.projectId !== prepared.ref.projectId) {
        void handleNewThread(finalRef, { replace: true }).catch(() => undefined);
      }
    });
  }, [
    bootstrapped,
    handleNewThread,
    isInboxCapable,
    prepareInboxProject,
    projects.length,
    settleInboxProject,
  ]);

  if (!bootstrapped) {
    return null;
  }
  if (mostRecentProject !== null) {
    return startState.failed ? (
      <DraftStartError
        onRetry={() => {
          setStartState((state) => ({
            failed: false,
            retryRequest: state.retryRequest + 1,
          }));
        }}
      />
    ) : null;
  }
  // First-run routing to the welcome wizard happens in FirstRunGate at the
  // root, before this route ever renders.
  return <NoProjectsHero />;
}

function DraftStartError({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      {isElectron ? <WorkspacePageHeader electron /> : null}
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle>Couldn’t start a new thread</EmptyTitle>
          <EmptyDescription>
            The project is still available. Try opening the draft again.
          </EmptyDescription>
          <div className="mt-5 flex justify-center">
            <Button size="sm" onClick={onRetry}>
              <RefreshIcon size="md" />
              Try again
            </Button>
          </div>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}
