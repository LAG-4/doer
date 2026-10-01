import { useRef, useState } from "react";
import { useClientSettings } from "~/hooks/useSettings";
import { create } from "zustand";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ComposerThreadTarget } from "~/composerDraftStore";
import { useComposerThreadDraft } from "~/composerDraftStore";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "~/components/ui/dialog";
import { retryAttachmentUpload, useAttachmentUploadStore } from "~/lib/attachmentUploadQueue";
import { attachmentUploadBlockReason } from "~/lib/attachmentUploadState";
import { composerFileNeedsReattach } from "~/composerDraftStore";
import { stripInlineContextReferences } from "~/lib/composerContextReferences";
import {
  GUIDED_STARTER_TASKS,
  buildStarterSummary,
  starterFileRequirement,
  type GuidedStarterTask,
  type StarterAnswers,
} from "./guidedStarterTasks";

interface StarterSession {
  answers: StarterAnswers;
  summary: string | null;
  reviewing: boolean;
}

// Retain answers when a draft is temporarily unmounted during dispatch or navigation.
const emptySession: StarterSession = { answers: {}, summary: null, reviewing: false };
const useStarterSessions = create<{
  sessions: Readonly<Record<string, Readonly<Record<string, StarterSession>>>>;
  update: (targetKey: string, taskId: string, patch: Partial<StarterSession>) => void;
  remove: (targetKey: string, taskId: string) => void;
}>((set) => ({
  sessions: {},
  update: (targetKey, taskId, patch) =>
    set((state) => ({
      sessions: {
        ...state.sessions,
        [targetKey]: {
          ...state.sessions[targetKey],
          [taskId]: { ...(state.sessions[targetKey]?.[taskId] ?? emptySession), ...patch },
        },
      },
    })),
  remove: (targetKey, taskId) =>
    set((state) => {
      const remaining = { ...state.sessions[targetKey] };
      delete remaining[taskId];
      const sessions = { ...state.sessions };
      if (Object.keys(remaining).length) sessions[targetKey] = remaining;
      else delete sessions[targetKey];
      return { sessions };
    }),
}));

export interface StarterSubmission {
  task: GuidedStarterTask;
  answers: StarterAnswers;
  summary: string;
}

interface DraftHeroSuggestionsProps {
  readonly draftTarget: ComposerThreadTarget;
  readonly environmentId: EnvironmentId;
  readonly visible: boolean;
  readonly supportsAttachmentUploads: boolean;
  readonly disabledReason: string | null;
  readonly submissionError: string | null;
  readonly onAddFiles: (files: File[]) => Promise<boolean>;
  readonly onRemoveAttachment: (id: string) => void;
  readonly onStart: (submission: StarterSubmission) => Promise<boolean>;
}

export function DraftHeroSuggestions({
  draftTarget,
  environmentId,
  visible,
  supportsAttachmentUploads,
  disabledReason,
  submissionError,
  onAddFiles,
  onRemoveAttachment,
  onStart,
}: DraftHeroSuggestionsProps) {
  const draft = useComposerThreadDraft(draftTarget);
  const simpleMode = useClientSettings((settings) => settings.simpleModeEnabled);
  const [showMoreTasks, setShowMoreTasks] = useState(false);
  const primaryIds = ["understand", "application", "reports", "meeting", "trip", "organize"];
  const primaryTasks = primaryIds.flatMap((id) =>
    GUIDED_STARTER_TASKS.filter((task) => task.id === id),
  );
  const suggestions = simpleMode
    ? [
        ...primaryTasks,
        ...(showMoreTasks
          ? GUIDED_STARTER_TASKS.filter((task) => !primaryIds.includes(task.id))
          : []),
      ]
    : GUIDED_STARTER_TASKS;
  const uploads = useAttachmentUploadStore((state) => state.uploadsByImageId);
  const targetKey = typeof draftTarget === "string" ? draftTarget : scopedThreadKey(draftTarget);
  const [selected, setSelected] = useState<{ targetKey: string; task: GuidedStarterTask } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [preparingFiles, setPreparingFiles] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startingRef = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const task = selected?.targetKey === targetKey ? selected.task : null;
  const session = useStarterSessions((state) =>
    task ? (state.sessions[targetKey]?.[task.id] ?? emptySession) : emptySession,
  );
  const attachments = [...draft.images, ...draft.files];
  const existingNotes = stripInlineContextReferences(draft.prompt).trim();
  const updateSession = (patch: Partial<StarterSession>) => {
    if (!task) return;
    useStarterSessions.getState().update(targetKey, task.id, patch);
  };
  const requirement = task ? starterFileRequirement(task, attachments.length) : null;
  const uploadReason = preparingFiles
    ? "Preparing your files…"
    : draft.files.some(composerFileNeedsReattach)
      ? "Add the original files again before starting."
      : supportsAttachmentUploads
        ? attachmentUploadBlockReason({
            imageIds: attachments.map((file) => file.id),
            uploadsByImageId: uploads,
            environmentId,
          })
        : null;
  const fileReason =
    draft.files.length > 0 && !supportsAttachmentUploads
      ? "This computer cannot accept files yet. Check the connection or remove the files."
      : null;
  const blockReason = disabledReason ?? requirement ?? fileReason ?? uploadReason;
  const summary = task
    ? (session.summary ??
      buildStarterSummary(
        task,
        session.answers,
        attachments.map((file) => file.name),
      ))
    : "";

  async function start() {
    if (!task || startingRef.current || blockReason || !summary.trim()) return;
    startingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const started = await onStart({ task, answers: session.answers, summary });
      if (started) {
        useStarterSessions.getState().remove(targetKey, task.id);
        setSelected(null);
      } else {
        setError(
          "Your Task could not start. Your answers and files are kept. Check the message below or the connection, then try again.",
        );
      }
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Your Task could not start. Please try again.",
      );
    } finally {
      startingRef.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      {visible ? (
        <div className="pointer-events-auto mx-auto w-full max-w-3xl pt-4">
          <p className="mb-3 text-center text-sm text-muted-foreground">
            Choose a guided Task, or type your own above.
          </p>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion.id}
                type="button"
                onClick={() => {
                  setError(null);
                  setSelected({ targetKey, task: suggestion });
                }}
                className="rounded-2xl border border-border/50 bg-card px-4 py-3.5 text-left transition-colors hover:border-border hover:bg-accent/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="block text-starter font-medium text-foreground">
                  {suggestion.title}
                </span>
                <span className="mt-0.5 block text-sm text-muted-foreground">
                  {suggestion.description}
                </span>
              </button>
            ))}
          </div>
          {simpleMode ? (
            <div className="mt-3 text-center">
              <Button
                variant="ghost-muted"
                size="sm"
                onClick={() => setShowMoreTasks((value) => !value)}
              >
                {showMoreTasks ? "Show fewer tasks" : "More tasks"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      <Dialog
        open={task !== null}
        onOpenChange={(open) => {
          if (!open && !startingRef.current && !preparingFiles) setSelected(null);
        }}
      >
        <DialogPopup showCloseButton={!busy && !preparingFiles} initialFocus={titleRef}>
          <DialogHeader>
            <DialogTitle ref={titleRef} tabIndex={-1}>
              {task?.title}
            </DialogTitle>
            <DialogDescription>
              {session.reviewing
                ? "Review your Task before starting. You can edit the summary or go back to your answers."
                : task?.description}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {session.reviewing ? (
              <div className="space-y-2">
                <label htmlFor="starter-summary" className="text-sm font-medium">
                  Doer will…
                </label>
                <Textarea
                  id="starter-summary"
                  value={summary}
                  disabled={busy}
                  onChange={(event) => updateSession({ summary: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  The work continues in your regular conversation. Sending, submitting or buying
                  needs a separate review.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-xs text-muted-foreground">
                  Share what you know. You can leave a detail blank or choose “I'm not sure”.
                </p>
                {task?.questions.map((question) => (
                  <div key={question.id} className="space-y-2">
                    <label htmlFor={`starter-${question.id}`} className="text-sm font-medium">
                      {question.label}
                    </label>
                    <Textarea
                      id={`starter-${question.id}`}
                      size="sm"
                      value={session.answers[question.id] ?? ""}
                      placeholder={question.placeholder}
                      disabled={busy}
                      onChange={(event) =>
                        updateSession({
                          answers: { ...session.answers, [question.id]: event.target.value },
                          summary: null,
                        })
                      }
                    />
                    <div className="flex flex-wrap gap-2">
                      {(question.choices ?? ["I'm not sure"]).map((choice) => (
                        <Button
                          key={choice}
                          type="button"
                          size="xs"
                          variant={
                            session.answers[question.id] === choice ? "secondary" : "outline"
                          }
                          disabled={busy}
                          aria-pressed={session.answers[question.id] === choice}
                          onClick={() =>
                            updateSession({
                              answers: { ...session.answers, [question.id]: choice },
                              summary: null,
                            })
                          }
                        >
                          {choice}
                        </Button>
                      ))}
                    </div>
                  </div>
                ))}
                {task?.attachmentLabel ? (
                  <div className="space-y-2">
                    <label htmlFor="starter-files" className="text-sm font-medium">
                      {task.attachmentLabel}
                    </label>
                    <Input
                      id="starter-files"
                      nativeInput
                      type="file"
                      multiple
                      disabled={busy || preparingFiles || !supportsAttachmentUploads}
                      onChange={(event) => {
                        const files = Array.from(event.target.files ?? []);
                        event.target.value = "";
                        if (!files.length) return;
                        setPreparingFiles(true);
                        setError(null);
                        void onAddFiles(files)
                          .catch((failure: unknown) =>
                            setError(
                              failure instanceof Error ? failure.message : "Could not add files.",
                            ),
                          )
                          .finally(() => setPreparingFiles(false));
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      Need a file from email or cloud storage?{" "}
                      <Link
                        to="/settings/integrations"
                        search={{ machine: environmentId }}
                        className="underline"
                      >
                        Connect Microsoft
                      </Link>
                      . Your answers are kept when you return to this Task.
                    </p>
                    {!supportsAttachmentUploads ? (
                      <p className="text-xs text-muted-foreground">
                        Files are unavailable on this computer right now. You can still describe
                        what you need.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
            {attachments.length ? (
              <div className="space-y-2">
                <p className="text-sm font-medium">Files included in this Task</p>
                {attachments.map((file) => {
                  const upload = uploads[file.id];
                  return (
                    <div key={file.id} className="flex items-center gap-2 text-sm">
                      <span className="min-w-0 flex-1 break-words">
                        {file.name}{" "}
                        {upload?.status === "uploading"
                          ? "· Uploading…"
                          : upload?.status === "failed"
                            ? "· Upload failed"
                            : ""}
                      </span>
                      {upload?.status === "failed" ? (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() =>
                            retryAttachmentUpload({ environmentId, image: file, draftTarget })
                          }
                          disabled={busy}
                        >
                          Retry
                        </Button>
                      ) : null}
                      <Button
                        size="xs"
                        variant="ghost"
                        aria-label={`Remove ${file.name}`}
                        disabled={busy}
                        onClick={() => {
                          onRemoveAttachment(file.id);
                          updateSession({ summary: null });
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                  );
                })}
              </div>
            ) : null}
            {existingNotes ? (
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  Your existing draft is included as additional notes.
                </p>
                <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                  {existingNotes}
                </p>
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Cancel keeps your answers and files so you can return later.
            </p>
            {blockReason ? (
              <p role="status" className="text-sm text-muted-foreground">
                {blockReason}
              </p>
            ) : null}
            {error || submissionError ? (
              <p role="alert" className="text-sm text-destructive">
                {error} {submissionError}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={busy || preparingFiles}
              onClick={() => setSelected(null)}
            >
              Cancel
            </Button>
            {session.reviewing ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  updateSession({ reviewing: false });
                  titleRef.current?.focus();
                }}
              >
                Back
              </Button>
            ) : null}
            <Button
              disabled={
                busy ||
                preparingFiles ||
                (session.reviewing ? blockReason !== null || !summary.trim() : requirement !== null)
              }
              onClick={() => {
                if (session.reviewing) {
                  void start();
                } else {
                  updateSession({ reviewing: true, summary });
                  titleRef.current?.focus();
                }
              }}
            >
              {busy ? "Starting…" : session.reviewing ? task?.startLabel : "Review Task"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
