import { RefreshIcon } from "~/components/ui/refresh-icon";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { LinkIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { isLocalEnvironmentDisabled } from "../localEnvironment";
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
import { useEnvironments } from "../state/environments";
import { primaryServerWelcomeAtom } from "../state/server";
import { APP_DISPLAY_NAME } from "~/branding";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";

export function DoerIndexDraftLanding() {
  const projects = useProjects();
  const threads = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const handleNewThread = useNewThreadHandler();
  const serverWelcome = useAtomValue(primaryServerWelcomeAtom);
  const inboxProjectId = serverWelcome?.inboxProjectId;
  const startingRef = useRef(false);
  const [startState, setStartState] = useState({ failed: false, retryRequest: 0 });
  const { prepareInboxProject, settleInboxProject, isInboxCapable } = useEnsureInboxProject();
  const preparedRef = useRef(false);

  const mostRecentProject = useMemo(() => {
    return resolveLandingProject({ bootstrapped, inboxProjectId, projects, threads });
  }, [bootstrapped, inboxProjectId, projects, threads]);

  useEffect(() => {
    if (mostRecentProject === null || startingRef.current) {
      return;
    }
    startingRef.current = true;
    void handleNewThread(scopeProjectRef(mostRecentProject.environmentId, mostRecentProject.id), {
      replace: true,
    }).catch(() => {
      startingRef.current = false;
      setStartState((state) => ({ ...state, failed: true }));
    });
  }, [handleNewThread, mostRecentProject, startState.retryRequest]);

  // Zero projects is a broken state, not a destination: open the inbox
  // draft instantly with a locally minted id while creation settles behind
  // it. The draft shows a setup state until the row lands; a lost creation
  // race just remaps to the winning project when it arrives.
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
