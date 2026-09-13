import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { persistClientSettingsPatchMock } = vi.hoisted(() => {
  const persistClientSettingsPatchMock = vi.fn<(patch: unknown) => Promise<void>>();
  return { persistClientSettingsPatchMock };
});

vi.mock("../hooks/useSettings", () => ({
  persistClientSettingsPatch: (patch: unknown) => persistClientSettingsPatchMock(patch),
}));

import {
  requestThreadDeleteConfirmation,
  threadBulkDeleteConfirmationMessage,
  threadDeleteConfirmationMessage,
} from "./threadDeleteConfirm";

describe("thread delete confirmation", () => {
  beforeEach(() => {
    persistClientSettingsPatchMock.mockReset();
    persistClientSettingsPatchMock.mockResolvedValue(undefined);
  });

  it("builds single and bulk delete messages", () => {
    expect(threadDeleteConfirmationMessage("New thread")).toBe(
      'Delete thread "New thread"?\nThis permanently clears conversation history for this thread.',
    );
    expect(threadBulkDeleteConfirmationMessage(1)).toBe(
      "Delete 1 thread?\nThis permanently clears conversation history for these threads.",
    );
    expect(threadBulkDeleteConfirmationMessage(3)).toBe(
      "Delete 3 threads?\nThis permanently clears conversation history for these threads.",
    );
  });

  it("fails closed without a dialogs host", async () => {
    await expect(
      requestThreadDeleteConfirmation({ dialogs: null, message: "Delete thread?" }),
    ).resolves.toEqual({ confirmed: false, dontAskAgain: false });
    expect(persistClientSettingsPatchMock).not.toHaveBeenCalled();
  });

  it("persists the opt-out when confirmed with don't-ask-again checked", async () => {
    const confirmWithDontAskAgain = vi.fn().mockResolvedValue({
      confirmed: true,
      dontAskAgain: true,
    });

    const result = await requestThreadDeleteConfirmation({
      dialogs: {
        confirm: vi.fn().mockResolvedValue(true),
        confirmWithDontAskAgain,
      },
      message: threadDeleteConfirmationMessage("New thread"),
    });

    expect(result).toEqual({ confirmed: true, dontAskAgain: true });
    expect(confirmWithDontAskAgain).toHaveBeenCalledWith(
      'Delete thread "New thread"?\nThis permanently clears conversation history for this thread.',
      { variant: "destructive", dontAskAgain: { label: "Don't ask again" } },
    );
    expect(persistClientSettingsPatchMock).toHaveBeenCalledWith({
      confirmThreadDelete: false,
    });
  });

  it("keeps asking when the box is unchecked or the dialog is cancelled", async () => {
    const confirm = vi.fn().mockResolvedValue(true);

    await expect(
      requestThreadDeleteConfirmation({
        dialogs: {
          confirm,
          confirmWithDontAskAgain: vi
            .fn()
            .mockResolvedValue({ confirmed: true, dontAskAgain: false }),
        },
        message: "Delete thread?",
      }),
    ).resolves.toEqual({ confirmed: true, dontAskAgain: false });

    await expect(
      requestThreadDeleteConfirmation({
        dialogs: {
          confirm,
          confirmWithDontAskAgain: vi
            .fn()
            .mockResolvedValue({ confirmed: false, dontAskAgain: false }),
        },
        message: "Delete thread?",
      }),
    ).resolves.toEqual({ confirmed: false, dontAskAgain: false });

    expect(persistClientSettingsPatchMock).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("falls back to the plain confirm dialog without persisting", async () => {
    const confirm = vi.fn().mockResolvedValue(true);

    await expect(
      requestThreadDeleteConfirmation({ dialogs: { confirm }, message: "Delete thread?" }),
    ).resolves.toEqual({ confirmed: true, dontAskAgain: false });
    expect(confirm).toHaveBeenCalledWith("Delete thread?", { variant: "destructive" });
    expect(persistClientSettingsPatchMock).not.toHaveBeenCalled();
  });

  it("propagates dialog failures to the caller", async () => {
    await expect(
      requestThreadDeleteConfirmation({
        dialogs: {
          confirm: vi.fn().mockRejectedValue(new Error("dialog unavailable")),
        },
        message: "Delete thread?",
      }),
    ).rejects.toThrow("dialog unavailable");
    expect(persistClientSettingsPatchMock).not.toHaveBeenCalled();
  });
});
