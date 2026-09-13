import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  registerConfirmDialogHost,
  requestConfirmDialog,
  requestConfirmDialogWithDontAskAgain,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
} from "./confirmDialog";

function requireConfirmation(confirmation: Promise<boolean> | undefined): Promise<boolean> {
  if (!confirmation) {
    throw new Error("Expected a registered confirmation host.");
  }
  return confirmation;
}

function requireRichConfirmation<T>(confirmation: Promise<T> | undefined): Promise<T> {
  if (!confirmation) {
    throw new Error("Expected a registered confirmation host.");
  }
  return confirmation;
}

describe("confirm dialog coordinator", () => {
  beforeEach(() => {
    resetConfirmDialogForTests();
  });

  it("returns undefined until a themed host is mounted", () => {
    expect(requestConfirmDialog("Confirm this action?")).toBeUndefined();
    expect(requestConfirmDialogWithDontAskAgain("Confirm this action?")).toBeUndefined();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
  });

  it("resolves a displayed confirmation and waits for its close transition", async () => {
    const unregister = registerConfirmDialogHost();
    const confirmation = requireConfirmation(
      requestConfirmDialog("Delete this thread?", { variant: "destructive" }),
    );

    expect(readConfirmDialogState()).toEqual({
      status: "confirming",
      message: "Delete this thread?",
      variant: "destructive",
      dontAskAgainLabel: null,
    });

    respondToConfirmDialog(true);
    await expect(confirmation).resolves.toBe(true);
    expect(readConfirmDialogState()).toEqual({
      status: "closing",
      message: "Delete this thread?",
      variant: "destructive",
      dontAskAgainLabel: null,
    });

    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
  });

  it("exposes the don't-ask-again label and returns the checkbox state", async () => {
    const unregister = registerConfirmDialogHost();
    const confirmation = requireRichConfirmation(
      requestConfirmDialogWithDontAskAgain("Delete this thread?", {
        variant: "destructive",
        dontAskAgain: {},
      }),
    );

    expect(readConfirmDialogState()).toEqual({
      status: "confirming",
      message: "Delete this thread?",
      variant: "destructive",
      dontAskAgainLabel: "Don't ask again",
    });

    respondToConfirmDialog(true, true);
    await expect(confirmation).resolves.toEqual({ confirmed: true, dontAskAgain: true });
    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
  });

  it("honors a custom don't-ask-again label and drops the flag on cancel", async () => {
    const unregister = registerConfirmDialogHost();
    const confirmation = requireRichConfirmation(
      requestConfirmDialogWithDontAskAgain("Delete this thread?", {
        dontAskAgain: { label: "Never ask me" },
      }),
    );

    expect(readConfirmDialogState()).toEqual({
      status: "confirming",
      message: "Delete this thread?",
      variant: "default",
      dontAskAgainLabel: "Never ask me",
    });

    respondToConfirmDialog(false, true);
    await expect(confirmation).resolves.toEqual({ confirmed: false, dontAskAgain: false });
    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
  });

  it("keeps the plain boolean API resolving to the decision", async () => {
    const unregister = registerConfirmDialogHost();
    const confirmation = requireConfirmation(
      requestConfirmDialog("Delete this thread?", { dontAskAgain: {} }),
    );

    respondToConfirmDialog(true, true);
    await expect(confirmation).resolves.toBe(true);
    completeConfirmDialogClose();
    unregister();
  });

  it("serializes concurrent confirmations", async () => {
    const unregister = registerConfirmDialogHost();
    const first = requireConfirmation(requestConfirmDialog("Delete the project?"));
    const second = requireConfirmation(requestConfirmDialog("Delete the worktree too?"));

    respondToConfirmDialog(false);
    await expect(first).resolves.toBe(false);
    expect(readConfirmDialogState()).toEqual({
      status: "closing",
      message: "Delete the project?",
      variant: "default",
      dontAskAgainLabel: null,
    });

    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({
      status: "confirming",
      message: "Delete the worktree too?",
      variant: "default",
      dontAskAgainLabel: null,
    });

    respondToConfirmDialog(true);
    await expect(second).resolves.toBe(true);
    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
  });

  it("cancels active and queued confirmations if the last host unmounts", async () => {
    const unregister = registerConfirmDialogHost();
    const active = requireConfirmation(requestConfirmDialog("Delete the thread?"));
    const queued = requireConfirmation(requestConfirmDialog("Delete the worktree too?"));

    unregister();

    await expect(Promise.all([active, queued])).resolves.toEqual([false, false]);
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
  });

  it("ignores responses after the active dialog has been closed", () => {
    const unregister = registerConfirmDialogHost();
    const confirmation = requireConfirmation(requestConfirmDialog("Continue?"));

    respondToConfirmDialog(true);
    respondToConfirmDialog(false);
    completeConfirmDialogClose();

    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
    return expect(confirmation).resolves.toBe(true);
  });
});
