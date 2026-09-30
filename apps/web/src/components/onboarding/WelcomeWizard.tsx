import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { ArrowLeftIcon, FileTextIcon, FlaskConicalIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { useEnsureInboxProject } from "../../hooks/useEnsureInboxProject";
import { findInboxProjectRef } from "../../inboxProject.logic";
import { useCompleteOnboarding } from "../../onboarding/firstRun";
import { checkFirstTaskFile, formatFirstTaskFileSize } from "../../onboarding/firstTask.logic";
import { useFirstTaskRecord, writeFirstTaskRecord } from "../../onboarding/firstTaskRecord";
import { submitFirstTask } from "../../onboarding/firstTaskSubmit";
import {
  getOnboardingProviderState,
  isOnboardingAutoInstallDriver,
} from "../../onboarding/providerReadiness.logic";
import {
  buildFirstTaskPrompt,
  buildFirstTaskTitle,
  SAMPLE_REPORT_FILENAME,
  SAMPLE_REPORT_LABEL,
  SAMPLE_REPORT_MIME,
  SAMPLE_SALES_REPORT,
} from "../../onboarding/sampleSalesReport";
import {
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
  resolveDefaultProviderModelSelection,
} from "../../providerInstances";
import { useProjects, useServerConfigs, useThread, useThreadStatus } from "../../state/entities";
import { usePrimaryEnvironment } from "../../state/environments";
import {
  primaryServerConfigAtom,
  primaryServerProvidersAtom,
  primaryServerWelcomeAtom,
  serverEnvironment,
} from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Dialog, DialogPopup } from "../ui/dialog";
import { RefreshIcon } from "../ui/refresh-icon";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";

const PRIMARY_BUTTON_ID = "doer-first-task-primary";

/**
 * First-run experience: a short first task instead of a slide tour. A new
 * user picks their own document or Doer's sample report, sees what Doer
 * will do, and — once the free AI is actually ready — submits a real turn
 * through the normal task pipeline. Skipping marks onboarding complete
 * without a first task; only a finished turn with real assistant output
 * (observed by FirstTaskFollowUp) counts as first-task success.
 */
export function WelcomeWizard({ onDone }: { readonly onDone: () => void }) {
  const completeOnboarding = useCompleteOnboarding();
  const router = useRouter();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const serverWelcome = useAtomValue(primaryServerWelcomeAtom);
  const serverConfigs = useServerConfigs();
  const projects = useProjects();
  const primaryEnvironment = usePrimaryEnvironment();
  const { prepareInboxProject, settleInboxProject, isInboxCapable } = useEnsureInboxProject();
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const firstTaskRecord = useFirstTaskRecord();

  const [screen, setScreen] = useState<"choose" | "review">("choose");
  const [isSample, setIsSample] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitPhase, setSubmitPhase] = useState<"space" | "task" | null>(null);
  const [isRetryingProviders, setIsRetryingProviders] = useState(false);
  const submittingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  const inboxRef = useMemo(
    () =>
      findInboxProjectRef(projects, {
        inboxProjectId: serverWelcome?.inboxProjectId,
        inboxWorkspaceRoot: serverWelcome?.inboxWorkspaceRoot,
      }),
    [projects, serverWelcome?.inboxProjectId, serverWelcome?.inboxWorkspaceRoot],
  );

  const storedDefaultSelection = useMemo(() => {
    const settings =
      primaryEnvironmentId !== null
        ? (serverConfigs.get(primaryEnvironmentId)?.settings ?? DEFAULT_SERVER_SETTINGS)
        : DEFAULT_SERVER_SETTINGS;
    const inboxProject =
      inboxRef === null
        ? null
        : (projects.find(
            (project) =>
              project.id === inboxRef.projectId && project.environmentId === inboxRef.environmentId,
          ) ?? null);
    return (
      resolveProjectSettings(settings, inboxRef?.projectId ?? null, inboxProject).settings
        .defaultModelSelection ?? null
    );
  }, [serverConfigs, primaryEnvironmentId, inboxRef, projects]);

  const entries = useMemo(() => deriveProviderInstanceEntries(providers), [providers]);
  const modelSelection = useMemo(
    () => resolveDefaultProviderModelSelection(providers, storedDefaultSelection),
    [providers, storedDefaultSelection],
  );
  const selectedEntry = modelSelection
    ? entries.find((entry) => entry.instanceId === modelSelection.instanceId)
    : undefined;
  const providerState = getOnboardingProviderState(selectedEntry?.snapshot);
  const catalogKnown = serverConfig !== null;
  const isFreeDefault = selectedEntry?.driverKind === "opencode";
  const isExplicitChoice =
    storedDefaultSelection !== null &&
    modelSelection?.instanceId === storedDefaultSelection.instanceId;
  // Never route a new user onto a paid service by accident: a non-OpenCode
  // fallback only submits when it was already their explicit choice.
  const providerReady =
    catalogKnown &&
    modelSelection !== null &&
    selectedEntry !== undefined &&
    isProviderInstancePickerReady(selectedEntry) &&
    (isFreeDefault || isExplicitChoice);

  const canSubmit =
    providerReady && file !== null && !isSubmitting && (inboxRef !== null || isInboxCapable);

  const retryProviders = useCallback(() => {
    if (primaryEnvironmentId === null || isRetryingProviders) return;
    setIsRetryingProviders(true);
    void refreshProviders({ environmentId: primaryEnvironmentId, input: {} })
      .catch(() => undefined)
      .finally(() => setIsRetryingProviders(false));
  }, [primaryEnvironmentId, isRetryingProviders, refreshProviders]);

  const openProviderSettings = useCallback(() => {
    void router.navigate({ to: "/settings/providers" });
  }, [router]);

  const pickFile = useCallback((next: File) => {
    const check = checkFirstTaskFile(next);
    if (!check.ok) {
      setFileError(check.message);
      return;
    }
    setFileError(null);
    setSubmitError(null);
    setIsSample(next.name === SAMPLE_REPORT_FILENAME && next.type === SAMPLE_REPORT_MIME);
    setFile(next);
    setScreen("review");
  }, []);

  const chooseSample = useCallback(() => {
    pickFile(new File([SAMPLE_SALES_REPORT], SAMPLE_REPORT_FILENAME, { type: SAMPLE_REPORT_MIME }));
    setIsSample(true);
  }, [pickFile]);

  const openFilePicker = useCallback(() => {
    setFileError(null);
    fileInputRef.current?.click();
  }, []);

  const skip = useCallback(() => {
    if (submittingRef.current) return;
    const now = new Date().toISOString();
    writeFirstTaskRecord({
      status: "skipped",
      thread: null,
      fileName: "",
      followUpDismissed: true,
      startedAt: now,
      completedAt: now,
    });
    void completeOnboarding()
      .then(() => onDone())
      .catch(() => {
        toastManager.add({
          type: "error",
          title: "Could not finish setup",
          description: "Your settings could not be saved. Try again.",
        });
      });
  }, [completeOnboarding, onDone]);

  const goToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      void router
        .navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
          replace: true,
        })
        .then(() => onDone());
    },
    [router, onDone],
  );

  const submit = useCallback(async () => {
    if (submittingRef.current || file === null || !providerReady || modelSelection === null) {
      return;
    }
    submittingRef.current = true;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      let projectRef = inboxRef;
      if (projectRef === null) {
        setSubmitPhase("space");
        const prepared = prepareInboxProject();
        if (prepared === null) {
          throw new Error("Could not set up your space. Check the connection and try again.");
        }
        projectRef = prepared.ref;
        if (prepared.isNew) {
          const settled = await settleInboxProject(prepared.projectId);
          if (settled === null) {
            throw new Error("Could not set up your space. Check the connection and try again.");
          }
          projectRef = settled;
        }
      }
      setSubmitPhase("task");
      const currentFile = file;
      const threadRef = await submitFirstTask({
        environmentId: projectRef.environmentId,
        projectId: projectRef.projectId,
        title: buildFirstTaskTitle(currentFile.name),
        prompt: buildFirstTaskPrompt(currentFile.name),
        file: currentFile,
        modelSelection,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      });
      writeFirstTaskRecord({
        status: "pending",
        thread: { environmentId: threadRef.environmentId, threadId: threadRef.threadId },
        fileName: currentFile.name,
        followUpDismissed: false,
        startedAt: new Date().toISOString(),
        completedAt: null,
      });
      await completeOnboarding();
      goToThread(threadRef);
    } catch (error) {
      // Inputs stay in place: retrying resubmits the same file, never a
      // second task (the guard above blocks double clicks, and a failed
      // thread create means nothing exists yet to duplicate).
      setSubmitError(
        error instanceof Error
          ? error.message
          : "Something went wrong starting your task. Try again.",
      );
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
      setSubmitPhase(null);
    }
  }, [
    file,
    providerReady,
    modelSelection,
    inboxRef,
    prepareInboxProject,
    settleInboxProject,
    completeOnboarding,
    goToThread,
  ]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (isSubmitting) return;
      if (event.key === "Escape") {
        event.preventDefault();
        skip();
      }
    },
    [isSubmitting, skip],
  );

  // A pending first task from this machine survives reloads: offer a way
  // back to it instead of starting a duplicate.
  const pendingThreadRef = useMemo(() => {
    if (firstTaskRecord?.status !== "pending" || firstTaskRecord.thread === null) return null;
    return scopeThreadRef(
      firstTaskRecord.thread.environmentId as EnvironmentId,
      firstTaskRecord.thread.threadId as ThreadId,
    );
  }, [firstTaskRecord]);
  const pendingThread = useThread(pendingThreadRef);
  const pendingThreadStatus = useThreadStatus(pendingThreadRef);
  const showResume =
    pendingThreadRef !== null && pendingThreadStatus !== "deleted" && pendingThread !== null;

  const primaryId = `${PRIMARY_BUTTON_ID}-${screen}`;

  return (
    <Dialog open disablePointerDismissal onOpenChange={(_, event) => event.cancel()}>
      <DialogPopup
        bottomStickOnMobile={false}
        showCloseButton={false}
        aria-label="Welcome to Doer"
        className="max-w-xl overflow-hidden"
        initialFocus={() => document.getElementById(primaryId) ?? true}
        onKeyDown={handleKeyDown}
      >
        <div className="flex flex-col items-center bg-gradient-to-b from-muted/70 via-muted/25 to-transparent px-6 pt-9 pb-3">
          <img
            src="/apple-touch-icon.png"
            alt=""
            width={76}
            height={76}
            className="size-[76px] rounded-app-icon shadow-lg ring-1 ring-black/10"
            draggable={false}
          />
        </div>
        <div className="px-6 pt-5 pb-6 text-center sm:px-10" aria-live="polite">
          {screen === "choose" ? (
            <ChooseScreen
              primaryId={primaryId}
              isSubmitting={isSubmitting}
              fileName={file?.name ?? null}
              fileError={fileError}
              showResume={showResume}
              onPickDocument={openFilePicker}
              onChooseSample={chooseSample}
              onContinue={() => setScreen("review")}
              onResume={() => {
                if (pendingThreadRef !== null) goToThread(pendingThreadRef);
              }}
              onSkip={skip}
            />
          ) : (
            <ReviewScreen
              primaryId={primaryId}
              file={file}
              isSample={isSample}
              isSubmitting={isSubmitting}
              submitPhase={submitPhase}
              submitError={submitError}
              canSubmit={canSubmit}
              spaceReady={inboxRef !== null || isInboxCapable}
              providerState={providerState}
              providerDisplayName={selectedEntry?.displayName ?? null}
              providerModel={modelSelection?.model ?? null}
              providerMessage={selectedEntry?.snapshot.message ?? null}
              isFreeDefault={isFreeDefault || selectedEntry === undefined}
              isAutoInstallDriver={
                selectedEntry === undefined ||
                isOnboardingAutoInstallDriver(selectedEntry.driverKind)
              }
              catalogKnown={catalogKnown}
              hasProviders={entries.length > 0}
              isRetryingProviders={isRetryingProviders}
              onRetryProviders={retryProviders}
              onOpenProviderSettings={openProviderSettings}
              onBack={() => setScreen("choose")}
              onSubmit={() => void submit()}
              onSkip={skip}
            />
          )}
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            aria-hidden
            tabIndex={-1}
            onChange={(event) => {
              const picked = event.target.files?.[0];
              event.target.value = "";
              if (picked) pickFile(picked);
            }}
          />
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function ChooseScreen({
  primaryId,
  isSubmitting,
  fileName,
  fileError,
  showResume,
  onPickDocument,
  onChooseSample,
  onContinue,
  onResume,
  onSkip,
}: {
  readonly primaryId: string;
  readonly isSubmitting: boolean;
  readonly fileName: string | null;
  readonly fileError: string | null;
  readonly showResume: boolean;
  readonly onPickDocument: () => void;
  readonly onChooseSample: () => void;
  readonly onContinue: () => void;
  readonly onResume: () => void;
  readonly onSkip: () => void;
}) {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        Let&rsquo;s try something useful.
      </h1>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        Doer will explain the important points and help you decide what to do next.
      </p>
      {showResume ? (
        <div className="mx-auto mt-4 max-w-md rounded-2xl border border-border/70 bg-card/80 p-3 text-left">
          <p className="text-sm font-medium text-foreground">Your report task is still running.</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            disabled={isSubmitting}
            onClick={onResume}
          >
            View my task
          </Button>
        </div>
      ) : null}
      <div className="mx-auto mt-6 flex max-w-md flex-col gap-2.5 text-left">
        {fileName !== null ? (
          <p className="text-sm text-muted-foreground">
            Selected: <span className="font-medium text-foreground">{fileName}</span>
          </p>
        ) : null}
        {fileName !== null ? (
          <Button
            id={primaryId}
            key={primaryId}
            autoFocus
            size="tour"
            disabled={isSubmitting}
            onClick={onContinue}
            className="w-full"
          >
            Continue with this file
          </Button>
        ) : null}
        <ChoiceButton
          icon={<FileTextIcon className="size-5 shrink-0" aria-hidden />}
          title="Use my document"
          description="Attach a PDF, spreadsheet, or text file you want explained."
          disabled={isSubmitting}
          onClick={onPickDocument}
          autoFocus={fileName === null}
          id={fileName === null ? primaryId : undefined}
        />
        <ChoiceButton
          icon={<FlaskConicalIcon className="size-5 shrink-0" aria-hidden />}
          title="Try a sample"
          description="Use a short fictional sales report supplied by Doer."
          disabled={isSubmitting}
          onClick={onChooseSample}
        />
      </div>
      {fileError !== null ? (
        <p role="alert" className="mx-auto mt-3 max-w-md text-sm text-destructive">
          {fileError}
        </p>
      ) : null}
      <div className="mt-5 flex min-h-9 items-center justify-center">
        <Button variant="ghost-muted" size="sm" disabled={isSubmitting} onClick={onSkip}>
          Skip for now
        </Button>
      </div>
      <p className="mx-auto mt-3 max-w-sm text-xs leading-relaxed text-muted-foreground/70">
        No accounts to connect. Your work starts in your My Stuff space.
      </p>
    </>
  );
}

function ChoiceButton({
  icon,
  title,
  description,
  disabled,
  onClick,
  autoFocus,
  id,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly description: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly autoFocus?: boolean;
  readonly id?: string | undefined;
}) {
  return (
    <button
      type="button"
      id={id}
      autoFocus={autoFocus}
      disabled={disabled}
      onClick={onClick}
      className="flex items-center gap-3 rounded-2xl border border-border/70 bg-card/80 px-4 py-3 text-left shadow-sm transition-colors hover:bg-card disabled:cursor-default disabled:opacity-60"
    >
      <span className="shrink-0 text-muted-foreground" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-foreground">{title}</span>
        <span className="mt-0.5 block text-sm leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  );
}

function ReviewScreen({
  primaryId,
  file,
  isSample,
  isSubmitting,
  submitPhase,
  submitError,
  canSubmit,
  spaceReady,
  providerState,
  providerDisplayName,
  providerModel,
  providerMessage,
  isFreeDefault,
  isAutoInstallDriver,
  catalogKnown,
  hasProviders,
  isRetryingProviders,
  onRetryProviders,
  onOpenProviderSettings,
  onBack,
  onSubmit,
  onSkip,
}: {
  readonly primaryId: string;
  readonly file: File | null;
  readonly isSample: boolean;
  readonly isSubmitting: boolean;
  readonly submitPhase: "space" | "task" | null;
  readonly submitError: string | null;
  readonly canSubmit: boolean;
  readonly spaceReady: boolean;
  readonly providerState: ReturnType<typeof getOnboardingProviderState>;
  readonly providerDisplayName: string | null;
  readonly providerModel: string | null;
  readonly providerMessage: string | null;
  readonly isFreeDefault: boolean;
  readonly isAutoInstallDriver: boolean;
  readonly catalogKnown: boolean;
  readonly hasProviders: boolean;
  readonly isRetryingProviders: boolean;
  readonly onRetryProviders: () => void;
  readonly onOpenProviderSettings: () => void;
  readonly onBack: () => void;
  readonly onSubmit: () => void;
  readonly onSkip: () => void;
}) {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        Here&rsquo;s what happens next.
      </h1>
      {file !== null ? (
        <div className="mx-auto mt-4 flex max-w-md items-center justify-center gap-2 text-sm">
          <span className="inline-flex min-w-0 items-center gap-2 rounded-full border border-border/70 bg-card/80 px-3 py-1.5 font-medium text-foreground">
            <FileTextIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{file.name}</span>
            <span className="shrink-0 text-muted-foreground">
              {formatFirstTaskFileSize(file.size)}
            </span>
          </span>
        </div>
      ) : null}
      {isSample ? (
        <p className="mt-2 text-xs text-muted-foreground">{SAMPLE_REPORT_LABEL}</p>
      ) : null}
      <ul className="mx-auto mt-4 max-w-md space-y-2 text-left text-sm leading-relaxed text-muted-foreground">
        <li>Doer reads your file and explains it in plain language.</li>
        <li>You get what improved or declined, the key figures, and three follow-ups.</li>
        <li>The explanation lands as a task in your My Stuff space, kept for later.</li>
      </ul>
      <div className="mx-auto mt-4 max-w-md rounded-2xl border border-border/70 bg-card/80 p-3 text-left">
        <SetupStatus
          providerState={providerState}
          providerDisplayName={providerDisplayName}
          providerModel={providerModel}
          providerMessage={providerMessage}
          isFreeDefault={isFreeDefault}
          isAutoInstallDriver={isAutoInstallDriver}
          catalogKnown={catalogKnown}
          hasProviders={hasProviders}
          isRetryingProviders={isRetryingProviders}
          disabled={isSubmitting}
          onRetryProviders={onRetryProviders}
          onOpenProviderSettings={onOpenProviderSettings}
        />
      </div>
      <p className="mx-auto mt-3 max-w-md text-xs leading-relaxed text-muted-foreground/70">
        {isFreeDefault
          ? "Your file is sent to OpenCode's free AI service to generate the explanation. Free models are provided by OpenCode — your data might be used for training."
          : `Your file is sent to ${providerDisplayName ?? "the AI service"} to generate the explanation.`}
      </p>
      {submitError !== null ? (
        <p role="alert" className="mx-auto mt-3 max-w-md text-sm text-destructive">
          {submitError}
        </p>
      ) : null}
      {!spaceReady && file !== null && !isSubmitting ? (
        <p className="mx-auto mt-3 max-w-md text-sm text-muted-foreground">
          Your My Stuff space isn&rsquo;t available — check the connection, then try again.
        </p>
      ) : null}
      <div className="mx-auto mt-5 max-w-sm">
        <Button
          id={primaryId}
          key={primaryId}
          autoFocus
          size="tour"
          disabled={!canSubmit}
          onClick={onSubmit}
          className="w-full"
        >
          {isSubmitting ? (
            <>
              <Spinner className="size-4" />
              {submitPhase === "space" ? "Setting up your space…" : "Starting your task…"}
            </>
          ) : (
            "Explain this report"
          )}
        </Button>
        <div className="mt-1 flex min-h-9 items-center justify-center gap-1">
          <Button variant="ghost-muted" size="sm" disabled={isSubmitting} onClick={onBack}>
            <ArrowLeftIcon className="size-3.5" />
            Back
          </Button>
          <Button variant="ghost-muted" size="sm" disabled={isSubmitting} onClick={onSkip}>
            Skip for now
          </Button>
        </div>
      </div>
    </>
  );
}

function SetupStatus({
  providerState,
  providerDisplayName,
  providerModel,
  providerMessage,
  isFreeDefault,
  isAutoInstallDriver,
  catalogKnown,
  hasProviders,
  isRetryingProviders,
  disabled,
  onRetryProviders,
  onOpenProviderSettings,
}: {
  readonly providerState: ReturnType<typeof getOnboardingProviderState>;
  readonly providerDisplayName: string | null;
  readonly providerModel: string | null;
  readonly providerMessage: string | null;
  readonly isFreeDefault: boolean;
  readonly isAutoInstallDriver: boolean;
  readonly catalogKnown: boolean;
  readonly hasProviders: boolean;
  readonly isRetryingProviders: boolean;
  readonly disabled: boolean;
  readonly onRetryProviders: () => void;
  readonly onOpenProviderSettings: () => void;
}) {
  if (
    !catalogKnown ||
    providerState === "checking" ||
    (providerState === "install" && isAutoInstallDriver)
  ) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4 shrink-0" />
        {isFreeDefault ? "Getting your free AI ready…" : "Getting the AI service ready…"}
      </p>
    );
  }
  if (providerState === "ready" && isFreeDefault) {
    return (
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Your free AI is ready</span>
        {providerModel !== null ? ` · ${providerModel}` : ""}. Nothing left to set up.
      </p>
    );
  }
  if (providerState === "ready") {
    // A non-free provider is ready but was not the user's choice: stay
    // paused instead of silently spending their money.
    return (
      <div className="text-sm">
        <p className="text-muted-foreground">
          Your free AI isn&rsquo;t available right now, so starting is paused — Doer won&rsquo;t
          switch you to a paid service without asking.
        </p>
        <RetryButton
          label="Try again"
          loading={isRetryingProviders}
          disabled={disabled}
          onClick={onRetryProviders}
        />
      </div>
    );
  }
  if (providerState === "signIn") {
    return (
      <div className="text-sm">
        <p className="text-muted-foreground">
          {providerDisplayName ?? "The AI service"} needs a quick sign-in before it can explain your
          report.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={disabled} onClick={onOpenProviderSettings}>
            Open provider settings
          </Button>
          <RetryButton
            label="Retry"
            loading={isRetryingProviders}
            disabled={disabled}
            onClick={onRetryProviders}
          />
        </div>
      </div>
    );
  }
  if (providerState === "disabled") {
    return (
      <div className="text-sm">
        <p className="text-muted-foreground">
          {providerDisplayName ?? "The AI service"} is turned off. Turn it back on in provider
          settings to start.
        </p>
        <div className="mt-2">
          <Button variant="outline" size="sm" disabled={disabled} onClick={onOpenProviderSettings}>
            Open provider settings
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="text-sm">
      <p className="text-muted-foreground">
        {providerMessage ??
          (catalogKnown && !hasProviders
            ? "No AI service was found on this computer."
            : "The AI service ran into a problem.")}
      </p>
      <RetryButton
        label="Try again"
        loading={isRetryingProviders}
        disabled={disabled}
        onClick={onRetryProviders}
      />
    </div>
  );
}

function RetryButton({
  label,
  loading,
  disabled,
  onClick,
}: {
  readonly label: string;
  readonly loading: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="mt-2"
      disabled={disabled || loading}
      onClick={onClick}
    >
      <RefreshIcon refreshing={loading} />
      {label}
    </Button>
  );
}
