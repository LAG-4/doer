// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";

vi.mock("~/lib/attachmentUploadQueue", () => ({
  useAttachmentUploadStore: (
    select: (state: { uploadsByImageId: Record<string, never> }) => unknown,
  ) => select({ uploadsByImageId: {} }),
  retryAttachmentUpload: vi.fn(),
}));
const mode = vi.hoisted(() => ({ simple: true }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (selector: (settings: { simpleModeEnabled: boolean }) => unknown) =>
    selector({ simpleModeEnabled: mode.simple }),
}));
vi.mock("@tanstack/react-router", () => ({ Link: "a" }));

import { DraftHeroSuggestions } from "./DraftHeroSuggestions";

let root: Root;
let container: HTMLDivElement;
const onStart = vi.fn().mockResolvedValue(true);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  onStart.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function getButton(text: string) {
  const button = [...document.querySelectorAll("button")].findLast(
    (element) =>
      element.textContent?.trim() === text || element.querySelector("span")?.textContent === text,
  );
  if (!button) throw new Error(`Missing button: ${text}`);
  return button;
}

it("uses an accessible modal, focuses the review, and closes with Escape without sending", async () => {
  const target = DraftId.make("guided-dom-focus");
  useComposerDraftStore.getState().setPrompt(target, "Keep my draft");
  await act(async () =>
    root.render(
      <DraftHeroSuggestions
        draftTarget={target}
        environmentId={EnvironmentId.make("guided-dom")}
        visible
        supportsAttachmentUploads
        disabledReason={null}
        submissionError={null}
        onAddFiles={async () => true}
        onRemoveAttachment={() => {}}
        onStart={onStart}
      />,
    ),
  );
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
  expect(onStart).not.toHaveBeenCalled();
  expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe("Keep my draft");
});

it("shows compact guided tasks only while Simple Mode is on", async () => {
  const target = DraftId.make("guided-mode-toggle");
  const render = () =>
    root.render(
      <DraftHeroSuggestions
        draftTarget={target}
        environmentId={EnvironmentId.make("guided-mode")}
        visible
        supportsAttachmentUploads
        disabledReason={null}
        submissionError={null}
        onAddFiles={async () => true}
        onRemoveAttachment={() => {}}
        onStart={onStart}
      />,
    );
  mode.simple = true;
  await act(async () => render());
  expect(container.textContent).toContain("Understand a document");
  mode.simple = false;
  await act(async () => render());
  expect(container.textContent).not.toContain("Understand a document");
  expect(container.querySelector("button")).toBeNull();
  mode.simple = true;
});
