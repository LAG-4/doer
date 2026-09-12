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
import { useMemo, useState } from "react";
import { create } from "zustand";

import {
  readEnvironmentSupportsAutomationScheduling,
  useProjects,
  useServerConfigs,
} from "../state/entities";
import { automationEnvironment } from "../state/automations";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { EMPTY_SERVER_PROVIDERS } from "../state/server";
import { useClientSettings } from "../hooks/useSettings";
import { newAutomationId, newThreadId } from "../lib/utils";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";
import { toastManager } from "./ui/toast";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";

interface ScheduledTaskEditorState {
  readonly open: boolean;
  readonly editing: ScopedAutomationRef | null;
  readonly presetProject: ScopedProjectRef | null;
  readonly openCreate: (presetProject?: ScopedProjectRef | null) => void;
  readonly openEdit: (ref: ScopedAutomationRef) => void;
  readonly close: () => void;
}

export const useScheduledTaskEditorStore = create<ScheduledTaskEditorState>()((set) => ({
  open: false,
  editing: null,
  presetProject: null,
  openCreate: (presetProject = null) => set({ open: true, editing: null, presetProject }),
  openEdit: (ref) => set({ open: true, editing: ref, presetProject: null }),
  close: () => set({ open: false, editing: null, presetProject: null }),
}));

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

type ScheduleKind = "once" | "daily" | "weekly";

function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

function toLocalDateTimeInputValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function defaultOnceAt(): string {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  tomorrow.setHours(9, 0, 0, 0);
  return toLocalDateTimeInputValue(tomorrow.toISOString());
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function buildSchedule(input: {
  kind: ScheduleKind;
  onceAt: string;
  time: string;
  weekday: number;
  timezone: string;
}): { schedule: AutomationSchedule | null; error: string | null } {
  const timezone = input.timezone.trim();
  if (timezone.length === 0) return { schedule: null, error: "Timezone is required." };
  if (!isValidTimezone(timezone)) {
    return { schedule: null, error: `Timezone '${input.timezone}' is not a valid IANA timezone.` };
  }
  if (input.kind === "once") {
    if (input.onceAt.length === 0) return { schedule: null, error: "Pick a date and time." };
    const at = new Date(input.onceAt).toISOString();
    if (Number.isNaN(Date.parse(at)))
      return { schedule: null, error: "Pick a valid date and time." };
    if (!(Date.parse(at) > Date.now())) {
      return { schedule: null, error: "A one-off task must run in the future." };
    }
    return { schedule: { kind: "once", at }, error: null };
  }
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(input.time)) {
    return { schedule: null, error: "Pick a valid time (HH:MM)." };
  }
  if (input.kind === "daily") {
    return { schedule: { kind: "daily", time: input.time, timezone }, error: null };
  }
  return {
    schedule: { kind: "weekly", time: input.time, weekday: input.weekday, timezone },
    error: null,
  };
}

export function ScheduledTaskEditor(props: {
  readonly automationsByRef: ReadonlyMap<string, Automation & { environmentId: string }>;
}) {
  const open = useScheduledTaskEditorStore((s) => s.open);
  const editing = useScheduledTaskEditorStore((s) => s.editing);
  const presetProject = useScheduledTaskEditorStore((s) => s.presetProject);
  const close = useScheduledTaskEditorStore((s) => s.close);

  const editingAutomation = editing
    ? (props.automationsByRef.get(`${editing.environmentId} ${editing.automationId}`) ?? null)
    : null;

  const editorKey = editing
    ? `edit:${editing.environmentId}:${editing.automationId}`
    : `create:${presetProject?.environmentId ?? ""}:${presetProject?.projectId ?? ""}`;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogPopup>
        <DialogPanel>
          {open ? (
            <ScheduledTaskEditorForm
              key={editorKey}
              editing={editing}
              editingAutomation={editingAutomation}
              presetProject={presetProject}
              close={close}
            />
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function initialFormState(editingAutomation: Automation | null): {
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
      prompt: "",
      kind: "once",
      onceAt: defaultOnceAt(),
      time: "09:00",
      weekday: 1,
      timezone: localZone(),
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
    timezone: schedule.kind === "once" ? localZone() : schedule.timezone,
  };
}

function ScheduledTaskEditorForm(props: {
  readonly editing: ScopedAutomationRef | null;
  readonly editingAutomation: Automation | null;
  readonly presetProject: ScopedProjectRef | null;
  readonly close: () => void;
}) {
  const { editing, editingAutomation, presetProject, close } = props;
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const clientSettings = useClientSettings((s) => s);
  const createThread = useAtomCommand(threadEnvironment.create);
  const createAutomation = useAtomCommand(automationEnvironment.create);
  const updateAutomation = useAtomCommand(automationEnvironment.update);

  const capableProjects = useMemo(
    () =>
      projects.filter((project) =>
        readEnvironmentSupportsAutomationScheduling(project.environmentId),
      ),
    [projects],
  );

  const initial = useMemo(() => initialFormState(editingAutomation), [editingAutomation]);
  const [title, setTitle] = useState(initial.title);
  const [prompt, setPrompt] = useState(initial.prompt);
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const [kind, setKind] = useState<ScheduleKind>(initial.kind);
  const [onceAt, setOnceAt] = useState(initial.onceAt);
  const [time, setTime] = useState(initial.time);
  const [weekday, setWeekday] = useState(initial.weekday);
  const [timezone, setTimezone] = useState(initial.timezone);
  const [modelInstanceId, setModelInstanceId] = useState<ProviderInstanceId | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const selectedProject =
    capableProjects.find((project) => `${project.environmentId} ${project.id}` === projectKey) ??
    (presetProject
      ? capableProjects.find(
          (project) =>
            project.environmentId === presetProject.environmentId &&
            project.id === presetProject.projectId,
        )
      : null) ??
    capableProjects[0] ??
    null;

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

  const save = async () => {
    if (saving) return;
    const trimmedTitle = title.trim();
    const trimmedPrompt = prompt.trim();
    if (trimmedTitle.length === 0) {
      setFormError("Give the task a title.");
      return;
    }
    if (trimmedPrompt.length === 0) {
      setFormError("Write the prompt the agent should run.");
      return;
    }
    const { schedule, error } = buildSchedule({ kind, onceAt, time, weekday, timezone });
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
          setFormError("Could not save the task. The server rejected the update.");
          return;
        }
        toastManager.add({ type: "success", title: "Scheduled task updated." });
        close();
        return;
      }
      if (selectedProject === null) {
        setFormError("Pick a Space for the task to run in.");
        return;
      }
      if (effectiveInstanceId === null || effectiveModel === null) {
        setFormError("Pick a model for the task thread first.");
        return;
      }
      const threadId = newThreadId();
      const threadResult = await createThread({
        environmentId: selectedProject.environmentId,
        input: {
          threadId,
          projectId: selectedProject.id,
          title: trimmedTitle,
          modelSelection: createModelSelection(effectiveInstanceId, effectiveModel),
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        },
      });
      if (threadResult._tag === "Failure") {
        setFormError("Could not create the task thread. Is this machine connected?");
        return;
      }
      const automationResult = await createAutomation({
        environmentId: selectedProject.environmentId,
        input: {
          automationId: newAutomationId(),
          projectId: selectedProject.id,
          threadId,
          title: trimmedTitle,
          prompt: trimmedPrompt,
          schedule,
        },
      });
      if (automationResult._tag === "Failure") {
        setFormError("The thread was created but the schedule was rejected. It will not run.");
        return;
      }
      toastManager.add({ type: "success", title: "Scheduled task created." });
      close();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{editing !== null ? "Edit scheduled task" : "New scheduled task"}</DialogTitle>
        <DialogDescription>
          The agent runs the prompt unattended in the task&apos;s thread. Runs use
          auto-accept-edits: a thread left on approval-required stalls the task.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-4 px-4 py-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="scheduled-task-title">Title</Label>
          <Input
            id="scheduled-task-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Morning brief"
          />
        </div>
        {editing === null ? (
          <div className="flex flex-col gap-1.5">
            <Label>Space</Label>
            <Select
              value={
                selectedProject ? `${selectedProject.environmentId} ${selectedProject.id}` : ""
              }
              onValueChange={(value) => setProjectKey(value)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Pick a Space" />
              </SelectTrigger>
              <SelectPopup>
                {capableProjects.map((project) => (
                  <SelectItem
                    key={`${project.environmentId} ${project.id}`}
                    value={`${project.environmentId} ${project.id}`}
                  >
                    {project.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="scheduled-task-prompt">Prompt</Label>
          <Textarea
            id="scheduled-task-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Summarize overnight activity in this Space."
            rows={4}
          />
        </div>
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
        <div className="flex flex-col gap-1.5">
          <Label>Repeats</Label>
          <Select value={kind} onValueChange={(value) => setKind(value as ScheduleKind)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="once">Once</SelectItem>
              <SelectItem value="daily">Every day</SelectItem>
              <SelectItem value="weekly">Every week</SelectItem>
            </SelectPopup>
          </Select>
        </div>
        {kind === "once" ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="scheduled-task-once-at">Runs at</Label>
            <Input
              id="scheduled-task-once-at"
              type="datetime-local"
              value={onceAt}
              onChange={(event) => setOnceAt(event.target.value)}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex gap-3">
              {kind === "weekly" ? (
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label>Weekday</Label>
                  <Select
                    value={String(weekday)}
                    onValueChange={(value) => setWeekday(Number(value))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {WEEKDAY_NAMES.map((name, index) => (
                        <SelectItem key={name} value={String(index)}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              ) : null}
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="scheduled-task-time">Time</Label>
                <Input
                  id="scheduled-task-time"
                  type="time"
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="scheduled-task-timezone">Timezone</Label>
              <Input
                id="scheduled-task-timezone"
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                placeholder="America/New_York"
              />
              <p className="text-xs text-muted-foreground">
                Daily and weekly tasks fire at this wall-clock time, daylight saving included.
              </p>
            </div>
          </div>
        )}
        {formError !== null ? (
          <p role="alert" className="text-xs text-destructive">
            {formError}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={close} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={save} disabled={saving}>
          {saving ? "Saving…" : editing !== null ? "Save changes" : "Create task"}
        </Button>
      </DialogFooter>
    </>
  );
}
