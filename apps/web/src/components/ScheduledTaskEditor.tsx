import {
  type Automation,
  type AutomationSchedule,
  type ModelSelection,
  type ProviderInstanceId,
  type ScopedAutomationRef,
  type ScopedProjectRef,
  DEFAULT_SERVER_SETTINGS,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { useAtomValue } from "@effect/atom-react";

import { useProjects, useServerConfigs } from "../state/entities";
import { primaryServerWelcomeAtom } from "../state/server";
import { automationEnvironment } from "../state/automations";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { EMPTY_SERVER_PROVIDERS } from "../state/server";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useClientSettings } from "../hooks/useSettings";
import { cn, newAutomationId, newThreadId } from "../lib/utils";
import { findInboxProjectRef } from "../inboxProject.logic";
import { useComposerHandleContext } from "../composerHandleContext";
import { buildReminderSchedule, reminderTimezone } from "../scheduledTaskForm";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../providerInstances";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { toastManager } from "./ui/toast";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import { ScheduledDatePicker } from "./ScheduledDatePicker";

interface ScheduledTaskEditorState {
  readonly open: boolean;
  readonly editing: ScopedAutomationRef | null;
  readonly presetProject: ScopedProjectRef | null;
  /** Create flow starts with a plain-words box; the full form is the fallback. */
  readonly describe: boolean;
  /** Text typed in the describe box; pre-fills the manual form's prompt. */
  readonly describeText: string;
  readonly openCreate: (presetProject?: ScopedProjectRef | null) => void;
  readonly openEdit: (ref: ScopedAutomationRef) => void;
  readonly showManualForm: () => void;
  readonly setDescribeText: (text: string) => void;
  readonly close: () => void;
}

export const useScheduledTaskEditorStore = create<ScheduledTaskEditorState>()((set) => ({
  open: false,
  editing: null,
  presetProject: null,
  describe: false,
  describeText: "",
  openCreate: (presetProject = null) =>
    set({ open: true, editing: null, presetProject, describe: true, describeText: "" }),
  openEdit: (ref) => set({ open: true, editing: ref, presetProject: null, describe: false }),
  showManualForm: () => set({ describe: false }),
  setDescribeText: (text) => set({ describeText: text }),
  close: () => set({ open: false, editing: null, presetProject: null, describe: false }),
}));

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const SCHEDULE_KINDS: ReadonlyArray<{ value: ScheduleKind; label: string }> = [
  { value: "once", label: "Once" },
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Every week" },
  { value: "weekdays", label: "Weekdays" },
];

type ScheduleKind = "once" | "daily" | "weekly" | "weekdays";

function toLocalDateTimeInputValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function defaultOnceAt(): string {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  tomorrow.setHours(9, 0, 0, 0);
  return tomorrow.toISOString();
}

export function ScheduledTaskEditor(props: {
  readonly automationsByRef: ReadonlyMap<string, Automation & { environmentId: string }>;
}) {
  const open = useScheduledTaskEditorStore((s) => s.open);
  const editing = useScheduledTaskEditorStore((s) => s.editing);
  const presetProject = useScheduledTaskEditorStore((s) => s.presetProject);
  const describe = useScheduledTaskEditorStore((s) => s.describe);
  const close = useScheduledTaskEditorStore((s) => s.close);

  const editingAutomation = editing
    ? (props.automationsByRef.get(`${editing.environmentId} ${editing.automationId}`) ?? null)
    : null;

  const editorKey = editing
    ? `edit:${editing.environmentId}:${editing.automationId}`
    : `create:${presetProject?.environmentId ?? ""}:${presetProject?.projectId ?? ""}:${describe ? "describe" : "manual"}`;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogPopup className="sm:mt-10">
        <DialogPanel>
          {open ? (
            editing === null && describe ? (
              <ScheduledTaskDescribeForm key={editorKey} close={close} />
            ) : (
              <ScheduledTaskEditorForm
                key={editorKey}
                editing={editing}
                editingAutomation={editingAutomation}
                presetProject={presetProject}
                close={close}
              />
            )
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Describe-first entry: one plain-words box. Continue sends it to the chat
 * so the agent sets the reminder up and shows it before creating anything;
 * the manual form is the fallback (and picks up the typed text as its prompt).
 */
function ScheduledTaskDescribeForm(props: { readonly close: () => void }) {
  const { close } = props;
  const describeText = useScheduledTaskEditorStore((s) => s.describeText);
  const setDescribeText = useScheduledTaskEditorStore((s) => s.setDescribeText);
  const showManualForm = useScheduledTaskEditorStore((s) => s.showManualForm);
  const composerHandleRef = useComposerHandleContext();

  const canContinue = describeText.trim().length > 0;

  const continueWithAi = () => {
    const description = describeText.trim();
    if (description.length === 0) return;
    // User-voiced confirm-first: reads as their own words in the sent
    // message, and the runtime instructions tell the agent to propose the
    // setup and ask before creating it.
    const base = /remind\s+me/i.test(description)
      ? description
      : `I want a reminder: ${description}`;
    const request = `${base}\n\nMy local timezone is ${reminderTimezone()}; use it unless I specified another timezone. Show me what you'll set up and confirm with me before creating it.`;
    const handle = composerHandleRef?.current;
    if (!handle) {
      showManualForm();
      return;
    }
    if (!handle.insertTextAtEnd(request, { ensureLeadingBoundary: true })) {
      showManualForm();
      return;
    }
    setDescribeText("");
    close();
    // Review in chat before sending: appending must never submit an existing
    // draft or its attachments without the user seeing the combined message.
    handle.focusAtEnd();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>New reminder</DialogTitle>
        <DialogDescription>
          Describe what you want, then continue in chat. Send the request there to review the timing
          with your assistant before it creates anything.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-4 px-4 py-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="scheduled-task-describe">What should happen, and when?</Label>
          <Textarea
            id="scheduled-task-describe"
            value={describeText}
            onChange={(event) => setDescribeText(event.target.value)}
            placeholder="e.g. Every Monday at 9am, send me my bills summary…"
            rows={4}
          />
        </div>
      </div>
      <DialogFooter variant="bare">
        <Button variant="ghost" onClick={showManualForm}>
          Fill in details myself
        </Button>
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button onClick={continueWithAi} disabled={!canContinue}>
          Continue in chat
        </Button>
      </DialogFooter>
    </>
  );
}

function initialFormState(
  editingAutomation: Automation | null,
  draftPrompt = "",
): {
  readonly title: string;
  readonly prompt: string;
  readonly kind: ScheduleKind;
  readonly onceAt: string;
  readonly time: string;
  readonly weekday: number;
  readonly timezone: string;
} {
  if (editingAutomation === null) {
    return {
      title: "",
      prompt: draftPrompt,
      kind: "once",
      onceAt: defaultOnceAt(),
      time: "09:00",
      weekday: 1,
      timezone: reminderTimezone(),
    };
  }
  const schedule = editingAutomation.schedule;
  return {
    title: editingAutomation.title,
    prompt: editingAutomation.prompt,
    kind: schedule.kind,
    onceAt: schedule.kind === "once" ? toLocalDateTimeInputValue(schedule.at) : defaultOnceAt(),
    time: schedule.kind === "once" ? "09:00" : schedule.time,
    weekday: schedule.kind === "weekly" ? schedule.weekday : 1,
    timezone: schedule.kind === "once" ? reminderTimezone() : schedule.timezone,
  };
}

function ScheduledTaskEditorForm(props: {
  readonly editing: ScopedAutomationRef | null;
  readonly editingAutomation: Automation | null;
  readonly presetProject: ScopedProjectRef | null;
  readonly close: () => void;
}) {
  const { editing, editingAutomation, presetProject, close } = props;
  const describeText = useScheduledTaskEditorStore((s) => s.describeText);
  const serverConfigs = useServerConfigs();
  const clientSettings = useClientSettings((s) => s);
  const createThread = useAtomCommand(threadEnvironment.create);
  const createAutomation = useAtomCommand(automationEnvironment.create);
  const updateAutomation = useAtomCommand(automationEnvironment.update);
  const pauseAutomation = useAtomCommand(automationEnvironment.pause);
  const runAutomation = useAtomCommand(automationEnvironment.runNow);

  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // Reminders run on this machine only: the Space list covers the
  // primary environment, never remote servers.
  const localProjects = useMemo(
    () =>
      primaryEnvironmentId === null
        ? []
        : projects.filter((project) => project.environmentId === primaryEnvironmentId),
    [projects, primaryEnvironmentId],
  );

  // No Space picker: reminders work anywhere on this machine. General
  // reminders live in the auto-provisioned inbox folder; the agent passes an
  // explicit projectId only for folder-specific work.
  const serverWelcome = useAtomValue(primaryServerWelcomeAtom);
  const inboxRef = useMemo(
    () =>
      findInboxProjectRef(localProjects, {
        inboxProjectId: serverWelcome?.inboxProjectId,
        inboxWorkspaceRoot: serverWelcome?.inboxWorkspaceRoot,
      }),
    [localProjects, serverWelcome?.inboxProjectId, serverWelcome?.inboxWorkspaceRoot],
  );

  const initial = useMemo(
    () => initialFormState(editingAutomation, describeText),
    [editingAutomation, describeText],
  );
  const [title, setTitle] = useState(initial.title);
  const [prompt, setPrompt] = useState(initial.prompt);
  const [kind, setKind] = useState<ScheduleKind>(initial.kind);
  const [onceAt, setOnceAt] = useState(initial.onceAt);
  const [time, setTime] = useState(initial.time);
  const [weekday, setWeekday] = useState(initial.weekday);
  const [timezone, setTimezone] = useState(initial.timezone);
  const [modelInstanceId, setModelInstanceId] = useState<ProviderInstanceId | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewFirst, setPreviewFirst] = useState(true);
  const [setupStarted, setSetupStarted] = useState(false);
  const setup = useRef<{
    threadId: ReturnType<typeof newThreadId>;
    entries: {
      id: ReturnType<typeof newAutomationId>;
      created: boolean;
      paused: boolean;
      configured: boolean;
    }[];
  } | null>(null);

  const presetSelectedProject =
    presetProject === null
      ? null
      : (localProjects.find((project) => project.id === presetProject.projectId) ?? null);
  const inboxSelectedProject =
    inboxRef === null
      ? null
      : (localProjects.find((project) => project.id === inboxRef.projectId) ?? null);
  const selectedProject = presetSelectedProject ?? inboxSelectedProject ?? localProjects[0] ?? null;

  const modelData = useMemo(() => {
    if (selectedProject === null) {
      return {
        entries: [] as ReadonlyArray<ProviderInstanceEntry>,
        options: new Map(),
        selection: null as ModelSelection | null,
      };
    }
    const serverConfig = serverConfigs.get(selectedProject.environmentId);
    const providers = serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
    const settings = { ...(serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS), ...clientSettings };
    const storedSelection =
      selectedProject.defaultModelSelection ?? serverConfig?.settings.defaultModelSelection ?? null;
    const selection = resolveDefaultProviderModelSelection(providers, storedSelection);
    return {
      entries: sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
      options: getCustomModelOptionsByInstance(
        settings,
        providers,
        selection?.instanceId,
        selection?.model,
      ),
      selection,
    };
  }, [selectedProject, serverConfigs, clientSettings]);

  const effectiveInstanceId = modelInstanceId ?? modelData.selection?.instanceId ?? null;
  const effectiveModel = model ?? modelData.selection?.model ?? null;
  // Friendly city for "9am your time (Kolkata)": the last IANA segment.
  const timezoneCity = timezone.split("/").pop()?.replaceAll("_", " ") ?? "";

  const save = async () => {
    if (saving) return;
    if (
      editing !== null &&
      (editingAutomation === null ||
        editingAutomation.deletedAt !== null ||
        editingAutomation.state === "completed")
    ) {
      setFormError(
        "This reminder is no longer available to edit. Close this window and check the Reminders list.",
      );
      return;
    }
    const trimmedTitle = title.trim();
    const trimmedPrompt = prompt.trim();
    if (trimmedTitle.length === 0) {
      setFormError("Give the reminder a title.");
      return;
    }
    if (trimmedPrompt.length === 0) {
      setFormError("Say what it should do each time.");
      return;
    }
    const { schedule, error } = buildReminderSchedule({
      kind: kind === "weekdays" ? "weekly" : kind,
      onceAt,
      time,
      weekday: kind === "weekdays" ? 1 : weekday,
      timezone,
      now: Date.now(),
      previousSchedule: editingAutomation?.schedule,
    });
    if (error !== null || schedule === null) {
      setFormError(error ?? "Pick a valid schedule.");
      return;
    }
    setSaving(true);
    try {
      if (editing !== null && editingAutomation !== null) {
        const patch: {
          title?: string;
          prompt?: string;
          schedule?: AutomationSchedule;
        } = {};
        if (trimmedTitle !== editingAutomation.title) patch.title = trimmedTitle;
        if (trimmedPrompt !== editingAutomation.prompt) patch.prompt = trimmedPrompt;
        if (JSON.stringify(schedule) !== JSON.stringify(editingAutomation.schedule)) {
          patch.schedule = schedule;
        }
        if (Object.keys(patch).length === 0) {
          close();
          return;
        }
        const result = await updateAutomation({
          environmentId: editing.environmentId,
          input: { automationId: editing.automationId, ...patch },
        });
        if (result._tag === "Failure") {
          setFormError("Could not save the reminder. The timing may be invalid.");
          return;
        }
        toastManager.add({ type: "success", title: "Reminder updated." });
        close();
        return;
      }
      if (selectedProject === null) {
        setFormError("Add a Space first, then try again.");
        return;
      }
      if (effectiveInstanceId === null || effectiveModel === null) {
        setFormError("Pick a model first (under Advanced).");
        return;
      }
      const schedules: AutomationSchedule[] =
        kind === "weekdays" && schedule.kind === "weekly"
          ? [1, 2, 3, 4, 5].map((day) => ({ ...schedule, weekday: day }))
          : [schedule];
      if (!setup.current) {
        const threadId = newThreadId();
        const threadResult = await createThread({
          environmentId: selectedProject.environmentId,
          input: {
            threadId,
            projectId: selectedProject.id,
            title: trimmedTitle,
            modelSelection: createModelSelection(effectiveInstanceId, effectiveModel),
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          },
        });
        if (threadResult._tag === "Failure") {
          setFormError("Could not set up the reminder. Reconnect this computer and try again.");
          return;
        }
        setSetupStarted(true);
        setup.current = {
          threadId,
          entries: schedules.map(() => ({
            id: newAutomationId(),
            created: false,
            paused: false,
            configured: false,
          })),
        };
      }
      const current = setup.current;
      if (current.entries.length !== schedules.length) {
        setFormError("Finish the existing setup before changing how often it runs.");
        return;
      }
      for (const [index, entry] of current.entries.entries()) {
        const requested = schedules[index];
        if (!requested) continue;
        const title =
          schedules.length > 1 && requested.kind === "weekly"
            ? `${trimmedTitle} · ${WEEKDAY_SHORT[requested.weekday]}`
            : trimmedTitle;
        if (!entry.created) {
          const result = await createAutomation({
            environmentId: selectedProject.environmentId,
            input: {
              automationId: entry.id,
              projectId: selectedProject.id,
              threadId: current.threadId,
              title: previewFirst ? `Preview · ${title}` : title,
              prompt: trimmedPrompt,
              // A preview is paused before the actual schedule is applied. It cannot race a nearby run.
              schedule: previewFirst
                ? { kind: "once", at: new Date(Date.now() + 30 * 86400000).toISOString() }
                : requested,
              dedicatedThread: true,
            },
          });
          if (result._tag === "Failure") {
            setFormError(
              "Setup could not finish. Your entries are kept; reconnect and retry here to continue.",
            );
            return;
          }
          entry.created = true;
        }
        if (previewFirst && !entry.paused) {
          const result = await pauseAutomation({
            environmentId: selectedProject.environmentId,
            input: { automationId: entry.id },
          });
          if (result._tag === "Failure") {
            setFormError(
              "The preview could not be paused. Check the Preview entry in Reminders before leaving this setup.",
            );
            return;
          }
          entry.paused = true;
        }
        if (previewFirst && !entry.configured) {
          const result = await updateAutomation({
            environmentId: selectedProject.environmentId,
            input: { automationId: entry.id, title, schedule: requested },
          });
          if (result._tag === "Failure") {
            setFormError("The preview is paused. Reconnect and retry to finish saving its timing.");
            return;
          }
          entry.configured = true;
        }
      }
      if (previewFirst && current.entries[0]) {
        const result = await runAutomation({
          environmentId: selectedProject.environmentId,
          input: { automationId: current.entries[0].id },
        });
        if (result._tag === "Failure") {
          setFormError(
            "The reminders are saved and paused. Open Reminders to run a preview and review its result before resuming.",
          );
          return;
        }
      }
      toastManager.add({
        type: "success",
        title: previewFirst
          ? "Preview started. Review its Task, then resume in Reminders."
          : schedules.length > 1
            ? "Five weekday reminders created. Manage each day in Reminders."
            : "Reminder created.",
      });
      close();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{editing !== null ? "Edit reminder" : "New reminder"}</DialogTitle>
        <DialogDescription>
          {editingAutomation?.dedicatedThread === false
            ? "Runs in its existing task with that task's permissions. It may wait for your approval."
            : "Runs in a separate task with permission to work without waiting for you. Results stay in that task."}
        </DialogDescription>
      </DialogHeader>
      <fieldset disabled={saving || setupStarted} className="flex flex-col gap-4 px-4 py-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="scheduled-task-title">Title</Label>
          <Input
            id="scheduled-task-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Morning brief"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="scheduled-task-prompt">What should I do each time?</Label>
          <Textarea
            id="scheduled-task-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="e.g. Look in this Space and list unpaid bills…"
            rows={4}
          />
          <p className="text-xs text-muted-foreground">
            Include the files or sources to use and the result you want. A separate task starts
            without this conversation.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label id="scheduled-task-repeats-label">Repeats</Label>
          <div
            role="radiogroup"
            aria-labelledby="scheduled-task-repeats-label"
            className="grid grid-cols-2 gap-1 rounded-lg border border-input p-1"
          >
            {SCHEDULE_KINDS.filter((option) => editing === null || option.value !== "weekdays").map(
              (option) => {
                const selected = kind === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setKind(option.value)}
                    className={cn(
                      "cursor-pointer rounded-md px-2 py-1.5 text-sm hover:bg-accent",
                      selected ? "bg-accent font-medium" : "text-muted-foreground",
                    )}
                  >
                    {option.label}
                  </button>
                );
              },
            )}
          </div>
        </div>
        {kind === "once" ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="scheduled-task-once-at">Runs at</Label>
            <ScheduledDatePicker id="scheduled-task-once-at" value={onceAt} onChange={setOnceAt} />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {kind === "weekly" ? (
              <div className="flex flex-col gap-1.5">
                <Label id="scheduled-task-weekday-label">Weekday</Label>
                <div
                  role="radiogroup"
                  aria-labelledby="scheduled-task-weekday-label"
                  className="grid grid-cols-7 gap-1"
                >
                  {WEEKDAY_SHORT.map((name, index) => {
                    const selected = weekday === index;
                    return (
                      <button
                        key={name}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-label={WEEKDAY_FULL[index]}
                        onClick={() => setWeekday(index)}
                        className={cn(
                          "cursor-pointer rounded-md border px-0 py-1.5 text-xs hover:bg-accent",
                          selected
                            ? "border-primary bg-accent font-medium"
                            : "border-input text-muted-foreground",
                        )}
                      >
                        {name}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="scheduled-task-time">Time</Label>
              <Input
                id="scheduled-task-time"
                type="time"
                value={time}
                onChange={(event) => setTime(event.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {time} in {timezoneCity} — daylight saving included.
            </p>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {editing !== null && editing.environmentId !== primaryEnvironmentId
            ? "Runs on the computer hosting this task."
            : "Runs on: This computer."}{" "}
          Keep it on with Doer running. After downtime, a missed reminder runs once when Doer starts
          again.
        </p>
        {kind === "weekdays" ? (
          <p className="text-xs text-muted-foreground">
            Creates five weekly reminders, Monday through Friday. Each day appears separately in
            Reminders and uses the same Task.
          </p>
        ) : null}
        {editing === null ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={previewFirst}
              disabled={saving || setupStarted}
              onChange={(event) => setPreviewFirst(event.target.checked)}
            />{" "}
            Try once before enabling
          </label>
        ) : null}
        {editing === null && previewFirst ? (
          <p className="text-xs text-muted-foreground">
            Saves the reminder paused and starts one preview. It performs the saved work with the
            permissions described above. Review the result in its Task, then resume when you are
            ready.
          </p>
        ) : null}
        {editing === null || kind !== "once" ? (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer text-sm font-medium text-foreground">
              Advanced
            </summary>
            <div className="flex flex-col gap-4 pt-2">
              {editing === null ? (
                <div className="flex flex-col gap-1.5">
                  <Label>Model</Label>
                  {effectiveInstanceId !== null && effectiveModel !== null ? (
                    <ProviderModelPicker
                      activeInstanceId={effectiveInstanceId}
                      model={effectiveModel}
                      lockedProvider={null}
                      instanceEntries={modelData.entries}
                      modelOptionsByInstance={modelData.options}
                      onInstanceModelChange={(instanceId, nextModel) => {
                        setModelInstanceId(instanceId);
                        setModel(nextModel);
                      }}
                    />
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No model available. Pick a default model in Settings first.
                    </p>
                  )}
                </div>
              ) : null}
              {kind !== "once" ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="scheduled-task-timezone">Timezone</Label>
                  <Input
                    id="scheduled-task-timezone"
                    value={timezone}
                    onChange={(event) => setTimezone(event.target.value)}
                    placeholder="America/New_York"
                  />
                </div>
              ) : null}
            </div>
          </details>
        ) : null}
        {formError !== null ? (
          <p role="alert" className="text-xs text-destructive">
            {formError}
          </p>
        ) : null}
      </fieldset>
      <DialogFooter variant="bare">
        <Button variant="ghost" onClick={close} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={save} disabled={saving}>
          {saving
            ? "Saving…"
            : editing !== null
              ? "Save changes"
              : previewFirst
                ? "Save and try once"
                : "Create reminder"}
        </Button>
      </DialogFooter>
    </>
  );
}
