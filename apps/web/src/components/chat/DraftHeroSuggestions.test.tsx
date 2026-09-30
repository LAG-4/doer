import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { DraftId, useComposerDraftStore, type ComposerFileAttachment } from "~/composerDraftStore";
import type { AttachmentUploadState } from "~/lib/attachmentUploadState";

const uploadState = vi.hoisted(() => ({
  uploadsByImageId: {} as Record<string, AttachmentUploadState>,
  retry: vi.fn(),
}));
vi.mock("~/lib/attachmentUploadQueue", () => ({
  useAttachmentUploadStore: (select: (state: typeof uploadState) => unknown) => select(uploadState),
  retryAttachmentUpload: (...args: unknown[]) => uploadState.retry(...args),
}));
vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
  DialogPopup: "section",
  DialogHeader: "header",
  DialogTitle: "h2",
  DialogDescription: "p",
  DialogPanel: "main",
  DialogFooter: "footer",
}));
vi.mock("~/components/ui/button", () => ({ Button: "button" }));
vi.mock("~/components/ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("~/components/ui/input", () => ({ Input: "input" }));

import { DraftHeroSuggestions } from "./DraftHeroSuggestions";

let renderer: ReactTestRenderer | null = null;
let counter = 0;
let target: DraftId;
const environmentId = EnvironmentId.make("guided-test");
const onStart = vi.fn<Parameters<typeof DraftHeroSuggestions>[0]["onStart"]>();
const onAddFiles = vi.fn<Parameters<typeof DraftHeroSuggestions>[0]["onAddFiles"]>();

function view(overrides: Partial<Parameters<typeof DraftHeroSuggestions>[0]> = {}) {
  return (
    <DraftHeroSuggestions
      draftTarget={target}
      environmentId={environmentId}
      visible
      supportsAttachmentUploads
      disabledReason={null}
      submissionError={null}
      onAddFiles={onAddFiles}
      onRemoveAttachment={(id) => useComposerDraftStore.getState().removeFile(target, id)}
      onStart={onStart}
      {...overrides}
    />
  );
}
function mount(overrides: Partial<Parameters<typeof DraftHeroSuggestions>[0]> = {}) {
  act(() => {
    if (renderer) renderer.update(view(overrides));
    else renderer = create(view(overrides));
  });
}
function button(label: string) {
  return renderer!.root
    .findAllByType("button")
    .findLast(
      (node) =>
        node.children.some((child) => child === label) ||
        node.findAllByType("span").some((span) => span.children.includes(label)),
    )!;
}
function click(label: string) {
  act(() => button(label).props.onClick());
}
function answer(id: string, text: string) {
  act(() =>
    renderer!.root.findByProps({ id: `starter-${id}` }).props.onChange({ target: { value: text } }),
  );
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

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  target = DraftId.make(`starter-test-${++counter}`);
  uploadState.uploadsByImageId = {};
  uploadState.retry.mockClear();
  onStart.mockReset().mockResolvedValue(true);
  onAddFiles.mockReset().mockResolvedValue(true);
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("guided Task lifecycle", () => {
  it("opens every card without sending or changing the draft", () => {
    useComposerDraftStore.getState().setPrompt(target, "Keep these notes");
    useComposerDraftStore.getState().addFiles(target, [file("resume")]);
    mount();
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
      click(title);
      expect(renderer!.root.findAllByType("h2")[0]!.children).toContain(title);
      click("Cancel");
    }
    expect(onStart).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
      "Keep these notes",
    );
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.files[0]?.name).toBe(
      "resume.pdf",
    );
  });

  it("keeps answers and an edited review through Back, Cancel and reopening", () => {
    mount();
    click("Find jobs for me");
    answer("work", "Marketing");
    click("Remote");
    click("Review Task");
    act(() =>
      renderer!.root
        .findByProps({ id: "starter-summary" })
        .props.onChange({ target: { value: "Find remote marketing jobs" } }),
    );
    click("Back");
    expect(renderer!.root.findByProps({ id: "starter-work" }).props.value).toBe("Marketing");
    click("Cancel");
    click("Find jobs for me");
    click("Review Task");
    expect(renderer!.root.findByProps({ id: "starter-summary" }).props.value).toBe(
      "Find remote marketing jobs",
    );
    expect(onStart).not.toHaveBeenCalled();
  });

  it("preserves uncertain answers and waits for one explicit Start, even with repeated clicks", async () => {
    let finish!: (started: boolean) => void;
    onStart.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    mount();
    click("Plan a trip");
    click("My dates are flexible");
    click("Review Task");
    const start = button("Plan my trip").props.onClick;
    act(() => {
      start();
      start();
    });
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart.mock.calls[0]![0].answers).toEqual({ dates: "My dates are flexible" });
    expect(button("Starting…").props.disabled).toBe(true);
    await act(async () => finish(true));
    expect(renderer!.root.findAllByType("h2")).toHaveLength(0);
  });

  it("retains review, draft and files when starting fails, and allows retry", async () => {
    useComposerDraftStore.getState().setPrompt(target, "Existing notes");
    useComposerDraftStore.getState().addFiles(target, [file("reference")]);
    uploadState.uploadsByImageId.reference = {
      status: "ready",
      environmentId,
      attachmentId: "uploaded",
    };
    onStart.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mount();
    click("Prepare a document");
    answer("type", "Letter");
    click("Review Task");
    await act(async () => button("Prepare my document").props.onClick());
    expect(renderer!.root.findByProps({ role: "alert" }).children.join("")).toContain(
      "could not start",
    );
    expect(renderer!.root.findByProps({ id: "starter-summary" }).props.value).toContain("Letter");
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
      "Existing notes",
    );
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.files).toHaveLength(1);
    await act(async () => button("Prepare my document").props.onClick());
    expect(onStart).toHaveBeenCalledTimes(2);
  });

  it("requires two reports and prevents Start while uploads are pending or failed", () => {
    mount();
    click("Compare reports");
    expect(button("Review Task").props.disabled).toBe(true);
    act(() => useComposerDraftStore.getState().addFiles(target, [file("before"), file("after")]));
    click("Review Task");
    expect(button("Compare reports").props.disabled).toBe(true);
    uploadState.uploadsByImageId = {
      before: { status: "ready", environmentId, attachmentId: "before-upload" },
      after: { status: "failed", environmentId, reason: "Offline" },
    };
    mount();
    expect(button("Compare reports").props.disabled).toBe(true);
    click("Retry");
    expect(uploadState.retry).toHaveBeenCalledTimes(1);
    uploadState.uploadsByImageId.after = {
      status: "ready",
      environmentId,
      attachmentId: "after-upload",
    };
    mount();
    expect(button("Compare reports").props.disabled).toBe(false);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("shows unavailable setup errors and keeps the review", async () => {
    onStart.mockRejectedValue(new Error("Your assistant is not ready."));
    mount();
    click("Find jobs for me");
    click("Review Task");
    await act(async () => button("Find jobs").props.onClick());
    expect(renderer!.root.findByProps({ role: "alert" }).children.join("")).toContain(
      "assistant is not ready",
    );
    mount({ disabledReason: "Connecting to this computer." });
    expect(button("Find jobs").props.disabled).toBe(true);
  });
});
