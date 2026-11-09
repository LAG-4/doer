import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";

import { act, render } from "../../../test/render";

vi.mock("~/lib/attachmentUploadQueue", () => ({
  useAttachmentUploadStore: (
    select: (state: { uploadsByImageId: Record<string, never> }) => unknown,
  ) => select({ uploadsByImageId: {} }),
  retryAttachmentUpload: vi.fn(),
}));
const harness = vi.hoisted(() => ({ simple: true, onStart: vi.fn() }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (selector: (settings: { simpleModeEnabled: boolean }) => unknown) =>
    selector({ simpleModeEnabled: harness.simple }),
}));
vi.mock("@tanstack/react-router", async (original) => ({ ...(await original()), Link: "a" }));

import { DraftHeroSuggestions } from "./DraftHeroSuggestions";

function setup() {
  harness.simple = true;
  harness.onStart.mockClear();
  harness.onStart.mockResolvedValue(true);
}

function suggestions(target: string) {
  return (
    <DraftHeroSuggestions
      draftTarget={DraftId.make(target)}
      environmentId={EnvironmentId.make("guided-dom")}
      visible
      supportsAttachmentUploads
      disabledReason={null}
      submissionError={null}
      onAddFiles={async () => true}
      onRemoveAttachment={() => {}}
      onStart={harness.onStart}
    />
  );
}

function getButton(text: string) {
  const button = [...document.querySelectorAll("button")].findLast(
    (element) =>
      element.textContent?.trim() === text || element.querySelector("span")?.textContent === text,
  );
  if (!button) throw new Error(`Missing button: ${text}`);
  return button;
}

describe("DraftHeroSuggestions", () => {
  it("uses an accessible modal, focuses the review, and closes with Escape without sending", async () => {
    setup();
    const target = DraftId.make("guided-dom-focus");
    useComposerDraftStore.getState().setPrompt(target, "Keep my draft");
    await using screen = await render(suggestions("guided-dom-focus"));
    expect(screen.container.textContent).toContain("More tasks");
    await act(async () => getButton("More tasks").click());
    const trigger = getButton("Find jobs for me");
    trigger.focus();
    await act(async () => trigger.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe(
      "Find jobs for me",
    );
    expect(document.querySelector<HTMLLabelElement>('label[for="starter-work"]')?.control).toBe(
      document.getElementById("starter-work"),
    );
    await act(async () => getButton("Review Task").click());
    expect(document.activeElement?.textContent).toBe("Find jobs for me");
    await act(async () =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(document.querySelector('[role="dialog"]:not([data-closed])')).toBeNull();
    expect(harness.onStart).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe("Keep my draft");
  });

  it("shows compact guided tasks only while Simple Mode is on", async () => {
    setup();
    await using screen = await render(suggestions("guided-mode-toggle"));
    expect(screen.container.textContent).toContain("Understand a document");
    harness.simple = false;
    await screen.rerender(suggestions("guided-mode-toggle"));
    expect(screen.container.textContent).not.toContain("Understand a document");
    expect(screen.container.querySelector("button")).toBeNull();
  });
});
