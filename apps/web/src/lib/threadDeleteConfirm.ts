import type { ConfirmDialogResult, LocalApi } from "@t3tools/contracts";

import { persistClientSettingsPatch } from "../hooks/useSettings";

export const THREAD_DELETE_DONT_ASK_AGAIN_LABEL = "Don't ask again";

export function threadDeleteConfirmationMessage(title: string): string {
  return [
    `Delete thread "${title}"?`,
    "This permanently clears conversation history for this thread.",
  ].join("\n");
}

export function threadBulkDeleteConfirmationMessage(count: number): string {
  return [
    `Delete ${count} thread${count === 1 ? "" : "s"}?`,
    "This permanently clears conversation history for these threads.",
  ].join("\n");
}

type ThreadDeleteDialogs = Pick<LocalApi["dialogs"], "confirm"> &
  Partial<Pick<LocalApi["dialogs"], "confirmWithDontAskAgain">>;

/**
 * Shows the delete-thread confirmation with a "Don't ask again" checkbox.
 * When the user confirms with the box checked, the `confirmThreadDelete`
 * client setting is turned off so later deletes skip the dialog. The setting
 * stays reversible in Settings → General → delete confirmation.
 *
 * Dialog failures propagate to the caller (wrap with `settlePromise` where
 * the call site reports failures that way). A missing dialogs host resolves
 * to "not confirmed", matching `dialogs.confirm` failing closed.
 */
export async function requestThreadDeleteConfirmation(input: {
  readonly dialogs: ThreadDeleteDialogs | null | undefined;
  readonly message: string;
  readonly persistDontAskAgain?: (patch: { confirmThreadDelete: false }) => void;
}): Promise<ConfirmDialogResult> {
  const { dialogs, message } = input;
  if (!dialogs) {
    return { confirmed: false, dontAskAgain: false };
  }
  const result =
    typeof dialogs.confirmWithDontAskAgain === "function"
      ? await dialogs.confirmWithDontAskAgain(message, {
          variant: "destructive",
          dontAskAgain: { label: THREAD_DELETE_DONT_ASK_AGAIN_LABEL },
        })
      : {
          confirmed: await dialogs.confirm(message, { variant: "destructive" }),
          dontAskAgain: false,
        };
  if (result.confirmed && result.dontAskAgain) {
    const persist = input.persistDontAskAgain ?? persistClientSettingsPatch;
    persist({ confirmThreadDelete: false });
  }
  return result;
}
