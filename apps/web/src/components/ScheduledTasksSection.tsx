import type { EnvironmentAutomation } from "@t3tools/client-runtime/state/models";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { Automation, AutomationRun, AutomationSchedule } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  ChevronDownIcon,
  ClockIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  PauseIcon,
  Trash2Icon,
} from "lucide-react";
import { memo, useMemo, useState } from "react";
import { useRouter } from "@tanstack/react-router";

import { useLocalStorage } from "../hooks/useLocalStorage";
import { useComposerHandleContext } from "../composerHandleContext";
import { cn } from "../lib/utils";
import { buildThreadRouteParams } from "../threadRoutes";
import { automationEnvironment } from "../state/automations";
import { useAutomations } from "../state/automations";
import { useProjects } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";
import { toastManager } from "./ui/toast";
import { ScheduledTaskEditor, useScheduledTaskEditorStore } from "./ScheduledTaskEditor";

const SECTION_EXPANDED_KEY = "t3code:sidebar:scheduled-expanded";

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * One-tap starters for the empty state. They write plain words into the chat
 * composer — the agent configures the reminder from there — instead of
 * opening the form. Mapped to the jobs non-dev users actually asked for.
 */
const REMINDER_STARTERS: ReadonlyArray<{ label: string; text: string }> = [
  {
    label: "Bills summary",
    text: "Remind me every Monday at 9am to send me my bills summary.",
  },
  {
    label: "Job follow-ups",
    text: "Remind me every Friday at 5pm to nudge me on open job applications and follow-ups.",
  },
  {
    label: "Morning brief",
    text: "Remind me every day at 8am to give me a morning brief from my files.",
  },
];

export function describeAutomationSchedule(schedule: AutomationSchedule): string {
  if (schedule.kind === "once") {
    const date = new Date(schedule.at);
    return Number.isNaN(date.getTime())
      ? "Once"
      : `Once · ${date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
  }
  if (schedule.kind === "daily") {
    return `Daily · ${schedule.time}`;
  }
  return `${WEEKDAY_SHORT[schedule.weekday] ?? ""} · ${schedule.time}`;
}

function describeNextFire(automation: Automation): string | null {
  if (automation.nextFireAt === null) return null;
  const date = new Date(automation.nextFireAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function describeRunOutcome(run: AutomationRun): string {
  if (run.outcome === "manual") return "Manual run";
  if (run.outcome === "missed-then-ran") return "Ran late";
  return "Ran";
}

const ScheduledTaskRow = memo(function ScheduledTaskRow(props: {
  automation: EnvironmentAutomation;
  projectTitle: string | null;
}) {
  const { automation } = props;
  const router = useRouter();
  const openEdit = useScheduledTaskEditorStore((s) => s.openEdit);
  const pauseAutomation = useAtomCommand(automationEnvironment.pause, { reportFailure: false });
  const resumeAutomation = useAtomCommand(automationEnvironment.resume, { reportFailure: false });
  const deleteAutomation = useAtomCommand(automationEnvironment.delete, { reportFailure: false });
  const runAutomationNow = useAtomCommand(automationEnvironment.runNow, { reportFailure: false });
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [busy, setBusy] = useState(false);

  const nextFire = describeNextFire(automation);
  const runs = useMemo(() => [...automation.runs].toReversed(), [automation.runs]);

  const runCommand = async (
    label: string,
    effect: Promise<AtomCommandResult<unknown, unknown>>,
    successTitle: string,
  ) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await effect;
      if (result._tag === "Failure") {
        toastManager.add({ type: "error", title: `${label} failed.` });
        return;
      }
      toastManager.add({ type: "success", title: successTitle });
    } finally {
      setBusy(false);
    }
  };

  const openThread = () => {
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(automation.environmentId, automation.threadId)),
    });
  };

  const paused = automation.state === "paused";
  const done = automation.state === "completed";

  return (
    <li className="list-none rounded-md px-2 py-1.5 hover:bg-sidebar-row-hover">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={openThread}
          className="min-w-0 flex-1 cursor-pointer text-left"
        >
          <span className="block truncate text-sm text-sidebar-foreground">{automation.title}</span>
          <span className="block truncate text-xs text-sidebar-muted-foreground/70">
            {[props.projectTitle, describeAutomationSchedule(automation.schedule)]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </button>
        {(paused || done) && (
          <span className="shrink-0 rounded border border-sidebar-border px-1 text-[10px] text-sidebar-muted-foreground">
            {done ? "Done" : "Paused"}
          </span>
        )}
        <span className="flex shrink-0 items-center gap-0.5">
          {!done && (
            <button
              type="button"
              aria-label={paused ? `Resume ${automation.title}` : `Pause ${automation.title}`}
              disabled={busy}
              onClick={() =>
                runCommand(
                  paused ? "Resume" : "Pause",
                  paused
                    ? resumeAutomation({
                        environmentId: automation.environmentId,
                        input: { automationId: automation.id },
                      })
                    : pauseAutomation({
                        environmentId: automation.environmentId,
                        input: { automationId: automation.id },
                      }),
                  paused ? "Reminder resumed." : "Reminder paused.",
                )
              }
              className="cursor-pointer rounded p-1 text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground disabled:opacity-50"
            >
              {paused ? <PlayIcon className="size-3.5" /> : <PauseIcon className="size-3.5" />}
            </button>
          )}
          {!done && (
            <button
              type="button"
              aria-label={`Run ${automation.title} now`}
              disabled={busy}
              onClick={() =>
                runCommand(
                  "Run now",
                  runAutomationNow({
                    environmentId: automation.environmentId,
                    input: { automationId: automation.id },
                  }),
                  "Running now. Results land in the task.",
                )
              }
              className="cursor-pointer rounded p-1 text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground disabled:opacity-50"
            >
              <ClockIcon className="size-3.5" />
            </button>
          )}
          {!done && (
            <button
              type="button"
              aria-label={`Edit ${automation.title}`}
              onClick={() =>
                openEdit({
                  environmentId: automation.environmentId,
                  automationId: automation.id,
                })
              }
              className="cursor-pointer rounded p-1 text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            >
              <PencilIcon className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            aria-label={`Delete ${automation.title}`}
            disabled={busy}
            onClick={() =>
              runCommand(
                "Delete",
                deleteAutomation({
                  environmentId: automation.environmentId,
                  input: { automationId: automation.id },
                }),
                "Reminder stopped. Past results stay in History.",
              )
            }
            className="cursor-pointer rounded p-1 text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-destructive disabled:opacity-50"
          >
            <Trash2Icon className="size-3.5" />
          </button>
        </span>
      </div>
      <div className="flex items-center gap-2 pl-0.5 pt-0.5 text-[11px] text-sidebar-muted-foreground/70">
        {nextFire !== null && !done ? (
          <span>Next {nextFire}</span>
        ) : done ? (
          <span>Finished its one run</span>
        ) : (
          <span>Not scheduled</span>
        )}
        {runs.length > 0 && (
          <button
            type="button"
            onClick={() => setHistoryExpanded((value) => !value)}
            aria-expanded={historyExpanded}
            className="inline-flex cursor-pointer items-center gap-0.5 hover:text-sidebar-foreground"
          >
            {runs.length} result{runs.length === 1 ? "" : "s"}
            <ChevronDownIcon
              aria-hidden
              className={cn("size-3 transition-transform", historyExpanded && "rotate-180")}
            />
          </button>
        )}
      </div>
      {historyExpanded && runs.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5 border-l border-sidebar-border pl-2">
          {runs.slice(0, 5).map((run) => (
            <li key={run.occurrenceKey} className="flex items-center gap-2 text-[11px]">
              <span className="text-sidebar-muted-foreground">
                {describeRunOutcome(run)} ·{" "}
                {new Date(run.firedAt).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              <button
                type="button"
                onClick={openThread}
                className="cursor-pointer text-sidebar-muted-foreground underline-offset-2 hover:text-sidebar-foreground hover:underline"
              >
                Open task
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
});

export function ScheduledTasksSection() {
  const automations = useAutomations();
  const projects = useProjects();
  const openCreate = useScheduledTaskEditorStore((s) => s.openCreate);
  const composerHandleRef = useComposerHandleContext();
  const [expanded, setExpanded] = useLocalStorage(SECTION_EXPANDED_KEY, true, Schema.Boolean);

  // Chat-first: starters write plain words into the composer so the agent
  // configures the reminder. The form is only the fallback when no composer
  // is mounted to receive the text.
  const startReminderFromChat = (text: string) => {
    const inserted =
      composerHandleRef?.current?.insertTextAtEnd(text, { ensureLeadingBoundary: true }) ?? false;
    if (inserted) {
      composerHandleRef?.current?.focusAtEnd();
    } else {
      openCreate();
    }
  };

  const projectTitleByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) {
      map.set(`${project.environmentId} ${project.id}`, project.title);
    }
    return map;
  }, [projects]);

  const automationsByRef = useMemo(() => {
    const map = new Map<string, Automation & { environmentId: string }>();
    for (const automation of automations) {
      map.set(`${automation.environmentId} ${automation.id}`, automation);
    }
    return map;
  }, [automations]);

  const active = useMemo(
    () => automations.filter((automation) => automation.state === "active"),
    [automations],
  );
  const parked = useMemo(
    () => automations.filter((automation) => automation.state !== "active"),
    [automations],
  );

  if (automations.length === 0) {
    return (
      <>
        <div className="mx-0.5 mt-1">
          <div className="flex h-8 w-full items-center gap-2 px-2">
            <span className="shrink-0 text-xs font-medium text-sidebar-muted-foreground/60">
              Reminders
            </span>
            <span aria-hidden className="h-px min-w-2 flex-1 bg-sidebar-border/60" />
            <button
              type="button"
              aria-label="New reminder"
              onClick={() => openCreate()}
              className="cursor-pointer rounded p-1 text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            >
              <PlusIcon className="size-3.5" />
            </button>
          </div>
          <div className="flex flex-col gap-1.5 px-2 py-1">
            <p className="text-[11px] leading-snug text-sidebar-muted-foreground/70">
              No reminders yet — e.g. every Monday 9am: send me my bills summary.
            </p>
            <div className="flex flex-wrap gap-1">
              {REMINDER_STARTERS.map((starter) => (
                <button
                  key={starter.label}
                  type="button"
                  onClick={() => startReminderFromChat(starter.text)}
                  className="cursor-pointer rounded-full border border-sidebar-border px-2 py-0.5 text-[11px] text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                >
                  {starter.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <ScheduledTaskEditor automationsByRef={automationsByRef} />
      </>
    );
  }

  return (
    <>
      <div className="mx-0.5 mt-1">
        <div className="flex h-8 w-full items-center gap-2 px-2">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            data-testid="sidebar-scheduled-shelf-toggle"
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left text-xs font-medium text-sidebar-muted-foreground/60"
          >
            <span className="shrink-0">
              {expanded ? "Reminders" : `Reminders (${automations.length})`}
            </span>
            <span aria-hidden className="h-px min-w-2 flex-1 bg-sidebar-border/60" />
            <ChevronDownIcon
              aria-hidden
              className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-180")}
            />
          </button>
          <button
            type="button"
            aria-label="New reminder"
            onClick={() => openCreate()}
            className="cursor-pointer rounded p-1 text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
          >
            <PlusIcon className="size-3.5" />
          </button>
        </div>
        {expanded && (
          <ul className="flex flex-col">
            {active.map((automation) => (
              <ScheduledTaskRow
                key={`${automation.environmentId} ${automation.id}`}
                automation={automation}
                projectTitle={
                  projectTitleByKey.get(`${automation.environmentId} ${automation.projectId}`) ??
                  null
                }
              />
            ))}
            {parked.map((automation) => (
              <ScheduledTaskRow
                key={`${automation.environmentId} ${automation.id}`}
                automation={automation}
                projectTitle={
                  projectTitleByKey.get(`${automation.environmentId} ${automation.projectId}`) ??
                  null
                }
              />
            ))}
          </ul>
        )}
      </div>
      <ScheduledTaskEditor automationsByRef={automationsByRef} />
    </>
  );
}
