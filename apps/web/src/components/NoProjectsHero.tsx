import { PlusIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import { useEnsureInboxProject } from "../hooks/useEnsureInboxProject";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { isElectron } from "../env";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

export function NoProjectsHero() {
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);
  const { handleNewThread } = useHandleNewThread();
  const { prepareInboxProject, settleInboxProject, isInboxCapable } = useEnsureInboxProject();
  const [failed, setFailed] = useState(false);

  // Opens the inbox draft instantly; creation settles behind it. A null
  // draft is not a failure: another navigation already won the race.
  const startChatting = useCallback(async () => {
    setFailed(false);
    const prepared = prepareInboxProject();
    if (prepared === null) {
      setFailed(true);
      return;
    }
    await handleNewThread(prepared.ref, { replace: true }).catch(() => undefined);
    if (!prepared.isNew) {
      return;
    }
    const finalRef = await settleInboxProject(prepared.projectId);
    if (finalRef === null) {
      setFailed(true);
    } else if (finalRef.projectId !== prepared.ref.projectId) {
      await handleNewThread(finalRef, { replace: true }).catch(() => undefined);
    }
  }, [handleNewThread, prepareInboxProject, settleInboxProject]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        {/* The desktop window only moves where CSS opts in, so keep a titlebar strip. */}
        {isElectron ? <WorkspacePageHeader electron /> : null}
        <Empty size="hero" className="flex-1">
          <div className="w-full max-w-lg px-8 py-12">
            <EmptyHeader className="max-w-none">
              <EmptyTitle>What should we work on?</EmptyTitle>
              <EmptyDescription className="mt-2">
                {isInboxCapable
                  ? "Start chatting right away, or add a folder as a Space first."
                  : "Add a Space to start your first Task."}
              </EmptyDescription>
              {failed ? (
                <p role="alert" className="mt-3 text-sm text-destructive">
                  Could not set up your space. Try again or add a Space.
                </p>
              ) : null}
              <div className="mt-6 flex justify-center gap-3">
                {isInboxCapable ? (
                  <>
                    <Button size="sm" onClick={() => void startChatting()}>
                      Start chatting
                    </Button>
                    <Button size="sm" variant="ghost-muted" onClick={openAddProject}>
                      <PlusIcon className="size-4" />
                      Add Space
                    </Button>
                  </>
                ) : (
                  <Button size="sm" onClick={openAddProject}>
                    <PlusIcon className="size-4" />
                    Add Space
                  </Button>
                )}
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
