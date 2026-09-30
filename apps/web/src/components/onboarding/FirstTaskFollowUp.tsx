import { useRouter } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo } from "react";

import { getFirstTaskTurnOutcome } from "../../onboarding/firstTask.logic";
import { updateFirstTaskRecord, useFirstTaskRecord } from "../../onboarding/firstTaskRecord";
import { useThread, useThreadStatus } from "../../state/entities";
import { Button } from "../ui/button";
import { Dialog, DialogPopup } from "../ui/dialog";

function dismissFollowUp() {
  updateFirstTaskRecord((current) =>
    current === null || current.followUpDismissed
      ? current
      : { ...current, followUpDismissed: true },
  );
}

/**
 * Watches the onboarding first task after the wizard hands off to the
 * normal conversation. A finished turn with substantive assistant output
 * records first-task success and offers next steps; a terminal failure
 * points back at the task where the existing retry controls live. Skipped
 * onboarding never shows anything here.
 */
export function FirstTaskFollowUp() {
  const router = useRouter();
  const record = useFirstTaskRecord();
  const threadRef = useMemo(
    () =>
      record?.status === "pending" && record.thread !== null
        ? scopeThreadRef(
            record.thread.environmentId as EnvironmentId,
            record.thread.threadId as ThreadId,
          )
        : null,
    [record],
  );
  const thread = useThread(threadRef);
  const threadStatus = useThreadStatus(threadRef);

  const outcome = useMemo(() => {
    if (record?.status !== "pending" || threadRef === null) return null;
    if (threadStatus === "deleted" || thread?.deletedAt != null) return "gone";
    if (thread === null) return "waiting";
    return getFirstTaskTurnOutcome({
      latestTurn: thread.latestTurn,
      session: thread.session,
      messages: thread.messages,
    });
  }, [record?.status, threadRef, threadStatus, thread]);

  useEffect(() => {
    if (record?.status !== "pending") return;
    if (outcome === "succeeded") {
      const now = new Date().toISOString();
      updateFirstTaskRecord((current) =>
        current?.status === "pending"
          ? { ...current, status: "succeeded", completedAt: now, followUpDismissed: false }
          : current,
      );
    } else if (outcome === "gone") {
      dismissFollowUp();
    }
  }, [record?.status, outcome]);

  const goToTask = useCallback(() => {
    const target = record?.thread ?? null;
    dismissFollowUp();
    if (target !== null) {
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: target.environmentId, threadId: target.threadId },
      });
    }
  }, [router, record]);

  const tryAnother = useCallback(() => {
    dismissFollowUp();
    void router.navigate({ to: "/welcome" });
  }, [router]);

  const goToTasks = useCallback(() => {
    dismissFollowUp();
    void router.navigate({ to: "/" });
  }, [router]);

  if (record === null || record.followUpDismissed) return null;
  if (record.status === "succeeded") {
    return (
      <Dialog open onOpenChange={(_, event) => event.cancel()}>
        <DialogPopup
          bottomStickOnMobile={false}
          showCloseButton={false}
          aria-label="Your first task is done"
          className="max-w-md overflow-hidden"
          initialFocus={() => true}
        >
          <div className="px-6 pt-6 pb-6 text-center sm:px-8" aria-live="polite">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              Your explanation is ready.
            </h1>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
              Doer explained {record.fileName === "" ? "your file" : `“${record.fileName}”`}. It
              stays in your My Stuff space whenever you want it.
            </p>
            <div className="mx-auto mt-5 flex max-w-sm flex-col gap-2">
              <Button size="tour" onClick={goToTask} className="w-full">
                Ask about this report
              </Button>
              <Button variant="outline" size="sm" onClick={tryAnother}>
                Try another task
              </Button>
              <Button variant="ghost-muted" size="sm" onClick={goToTasks}>
                Go to my tasks
              </Button>
            </div>
          </div>
        </DialogPopup>
      </Dialog>
    );
  }
  if (record.status === "pending" && outcome === "failed" && thread !== null) {
    return (
      <Dialog open onOpenChange={(_, event) => event.cancel()}>
        <DialogPopup
          bottomStickOnMobile={false}
          showCloseButton={false}
          aria-label="Your first task ran into a problem"
          className="max-w-md overflow-hidden"
          initialFocus={() => true}
        >
          <div className="px-6 pt-6 pb-6 text-center sm:px-8" aria-live="polite">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              That didn&rsquo;t work.
            </h1>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
              Doer couldn&rsquo;t finish explaining your file. Your task and file are kept — open it
              to see what happened and try again there.
            </p>
            <div className="mx-auto mt-5 flex max-w-sm flex-col gap-2">
              <Button size="tour" onClick={goToTask} className="w-full">
                Open the task
              </Button>
              <Button variant="ghost-muted" size="sm" onClick={dismissFollowUp}>
                Dismiss
              </Button>
            </div>
          </div>
        </DialogPopup>
      </Dialog>
    );
  }
  return null;
}
