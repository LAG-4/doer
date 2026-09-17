import { PlusIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import { useEnsureInboxProject } from "../hooks/useEnsureInboxProject";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";

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
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <Empty className="flex-1">
          <div className="w-full max-w-lg px-8 py-12">
            <EmptyHeader className="max-w-none">
              <EmptyTitle className="text-foreground text-2xl sm:text-3xl">
                What should we work on?
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                {isInboxCapable
                  ? "Start chatting right away, or add a project folder first."
                  : "Add a project to start your first thread."}
              </EmptyDescription>
              {failed ? (
                <p role="alert" className="mt-3 text-sm text-destructive">
                  Could not set up your space. Try again or add a project.
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
                      Add project
                    </Button>
                  </>
                ) : (
                  <Button size="sm" onClick={openAddProject}>
                    <PlusIcon className="size-4" />
                    Add project
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
