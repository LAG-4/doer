import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { EnvironmentId } from "@t3tools/contracts";
import {
  DraftId,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerThreadTarget,
} from "~/composerDraftStore";
import type { AttachmentUploadState } from "~/lib/attachmentUploadState";

import { act, render } from "../../../test/render";
import { DraftHeroSuggestions, type StarterSubmission } from "./DraftHeroSuggestions";

const uploadState = vi.hoisted(() => ({
  uploadsByImageId: {} as Record<string, AttachmentUploadState>,
  retry: vi.fn(),
}));
vi.mock("~/lib/attachmentUploadQueue", () => ({
  useAttachmentUploadStore: (select: (state: typeof uploadState) => unknown) => select(uploadState),
  retryAttachmentUpload: (...args: Array<unknown>) => uploadState.retry(...args),
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (selector: (settings: { simpleModeEnabled: boolean }) => unknown) =>
    selector({ simpleModeEnabled: true }),
}));

interface TestDoubles {
  readonly onStart: ReturnType<typeof vi.fn<(submission: StarterSubmission) => Promise<boolean>>>;
  readonly onAddFiles: ReturnType<typeof vi.fn<(files: File[]) => Promise<boolean>>>;
}

function setup(targetId: string): { target: ComposerThreadTarget } & TestDoubles {
  uploadState.uploadsByImageId = {};
  uploadState.retry.mockClear();
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  return {
    target: DraftId.make(targetId),
    onStart: vi.fn<(submission: StarterSubmission) => Promise<boolean>>().mockResolvedValue(true),
    onAddFiles: vi.fn<(files: File[]) => Promise<boolean>>().mockResolvedValue(true),
  };
}

function view(
  target: ComposerThreadTarget,
  doubles: TestDoubles,
  overrides: Partial<Parameters<typeof DraftHeroSuggestions>[0]> = {},
) {
  return (
    <DraftHeroSuggestions
      draftTarget={target}
      environmentId={EnvironmentId.make("guided-test")}
      visible
      supportsAttachmentUploads
      disabledReason={null}
      submissionError={null}
      onAddFiles={doubles.onAddFiles}
      onRemoveAttachment={(id) => useComposerDraftStore.getState().removeFile(target, id)}
      onStart={doubles.onStart}
      {...overrides}
    />
  );
}

function dialog() {
  return page.getByRole("dialog");
}

async function openTask(title: string, needsMoreTasks = false) {
  if (needsMoreTasks) {
    await userEvent.click(page.getByRole("button", { name: "More tasks" }));
  }
  await userEvent.click(page.getByRole("button", { name: title }));
}

function textarea(id: string) {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLTextAreaElement)) throw new Error(`Missing textarea: ${id}`);
  return element;
}

function file(id: string): ComposerFileAttachment {
  const bytes = new File(["report"], `${id}.pdf`, { type: "application/pdf" });
  return {
    id,
    type: "file",
    name: bytes.name,
    mimeType: bytes.type,
    sizeBytes: bytes.size,
    file: bytes,
  };
}

it("opens every card without sending or changing the draft", async () => {
  const { target, ...doubles } = setup("starter-open");
  await act(async () => {
    useComposerDraftStore.getState().setPrompt(target, "Keep these notes");
    useComposerDraftStore.getState().addFiles(target, [file("resume")]);
  });
  await using screen = await render(view(target, doubles));
  await userEvent.click(page.getByRole("button", { name: "More tasks" }));
  for (const title of [
    "Find jobs for me",
    "Plan a trip",
    "Prepare a document",
    "Compare prices",
    "Compare reports",
    "Fix my printer or Wi-Fi",
    "Set up my computer",
    "Fix a slow computer",
    "Fill a boring form",
  ]) {
    await userEvent.click(page.getByRole("button", { name: title }));
    await expect.element(page.getByRole("heading", { name: title })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Cancel", exact: true }));
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  }
  expect(doubles.onStart).not.toHaveBeenCalled();
  expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
    "Keep these notes",
  );
  expect(useComposerDraftStore.getState().getComposerDraft(target)?.files[0]?.name).toBe(
    "resume.pdf",
  );
  expect(screen.container.textContent).toContain("Find jobs for me");
});

it("keeps answers and an edited review through Back, Cancel and reopening", async () => {
  const { target, ...doubles } = setup("starter-answers");
  await using _screen = await render(view(target, doubles));
  await openTask("Find jobs for me", true);
  await userEvent.fill(textarea("starter-work"), "Marketing");
  await userEvent.click(dialog().getByRole("button", { name: "Remote", exact: true }));
  await userEvent.click(dialog().getByRole("button", { name: "Review Task" }));
  await userEvent.fill(textarea("starter-summary"), "Find remote marketing jobs");
  await userEvent.click(dialog().getByRole("button", { name: "Back" }));
  expect(textarea("starter-work").value).toBe("Marketing");
  await userEvent.click(dialog().getByRole("button", { name: "Cancel", exact: true }));
  await openTask("Find jobs for me");
  await userEvent.click(dialog().getByRole("button", { name: "Review Task" }));
  expect(textarea("starter-summary").value).toBe("Find remote marketing jobs");
  expect(doubles.onStart).not.toHaveBeenCalled();
});

it("preserves uncertain answers and waits for one explicit Start, even with repeated clicks", async () => {
  const { target, ...doubles } = setup("starter-start-once");
  let finish!: (started: boolean) => void;
  doubles.onStart.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await using _screen = await render(view(target, doubles));
  await openTask("Plan a trip");
  await userEvent.click(dialog().getByRole("button", { name: "My dates are flexible" }));
  await userEvent.click(dialog().getByRole("button", { name: "Review Task" }));
  const startButton = dialog().getByRole("button", { name: "Plan my trip" });
  // Two clicks land before the first re-render; the second must be a no-op.
  await act(async () => {
    const element = startButton.element();
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(doubles.onStart).toHaveBeenCalledTimes(1);
  expect(doubles.onStart.mock.calls[0]?.[0].answers).toEqual({ dates: "My dates are flexible" });
  await expect.element(dialog().getByRole("button", { name: "Starting…" })).toBeDisabled();
  await act(async () => finish(true));
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
});

it("retains review, draft and files when starting fails, and allows retry", async () => {
  const { target, ...doubles } = setup("starter-retry");
  await act(async () => {
    useComposerDraftStore.getState().setPrompt(target, "Existing notes");
    useComposerDraftStore.getState().addFiles(target, [file("reference")]);
  });
  uploadState.uploadsByImageId.reference = {
    status: "ready",
    environmentId: EnvironmentId.make("guided-test"),
    attachmentId: "uploaded",
  };
  doubles.onStart.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await using screen = await render(view(target, doubles));
  await openTask("Prepare a document", true);
  await userEvent.fill(textarea("starter-type"), "Letter");
  await userEvent.click(dialog().getByRole("button", { name: "Review Task" }));
  await userEvent.click(dialog().getByRole("button", { name: "Prepare my document" }));
  await vi.waitFor(() =>
    expect(dialog().getByRole("alert").element().textContent ?? "").toContain("could not start"),
  );
  expect(textarea("starter-summary").value).toContain("Letter");
  expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe("Existing notes");
  expect(useComposerDraftStore.getState().getComposerDraft(target)?.files).toHaveLength(1);
  await userEvent.click(dialog().getByRole("button", { name: "Prepare my document" }));
  expect(doubles.onStart).toHaveBeenCalledTimes(2);
  expect(screen.container.textContent).toContain("Prepare a document");
});

it("requires two reports and prevents Start while uploads are pending or failed", async () => {
  const environmentId = EnvironmentId.make("guided-test");
  const { target, ...doubles } = setup("starter-reports");
  await using screen = await render(view(target, doubles));
  await openTask("Compare reports");
  await expect.element(dialog().getByRole("button", { name: "Review Task" })).toBeDisabled();
  await act(async () => {
    useComposerDraftStore.getState().addFiles(target, [file("before"), file("after")]);
  });
  await userEvent.click(dialog().getByRole("button", { name: "Review Task" }));
  await expect.element(dialog().getByRole("button", { name: "Compare reports" })).toBeDisabled();
  uploadState.uploadsByImageId = {
    before: { status: "ready", environmentId, attachmentId: "before-upload" },
    after: { status: "failed", environmentId, reason: "Offline" },
  };
  await screen.rerender(view(target, doubles));
  await expect.element(dialog().getByRole("button", { name: "Compare reports" })).toBeDisabled();
  await userEvent.click(dialog().getByRole("button", { name: "Retry" }));
  expect(uploadState.retry).toHaveBeenCalledTimes(1);
  uploadState.uploadsByImageId.after = {
    status: "ready",
    environmentId,
    attachmentId: "after-upload",
  };
  await screen.rerender(view(target, doubles));
  await expect.element(dialog().getByRole("button", { name: "Compare reports" })).toBeEnabled();
  expect(doubles.onStart).not.toHaveBeenCalled();
});

it("shows unavailable setup errors and keeps the review", async () => {
  const { target, ...doubles } = setup("starter-unavailable");
  doubles.onStart.mockRejectedValue(new Error("Your assistant is not ready."));
  await using screen = await render(view(target, doubles));
  await openTask("Find jobs for me", true);
  await userEvent.click(dialog().getByRole("button", { name: "Review Task" }));
  await userEvent.click(dialog().getByRole("button", { name: "Find jobs" }));
  await vi.waitFor(() =>
    expect(dialog().getByRole("alert").element().textContent ?? "").toContain(
      "assistant is not ready",
    ),
  );
  await screen.rerender(view(target, doubles, { disabledReason: "Connecting to this computer." }));
  await expect.element(dialog().getByRole("button", { name: "Find jobs" })).toBeDisabled();
});
