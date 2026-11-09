import type { ConfirmDialogResult, LocalApi } from "@t3tools/contracts";

import { persistClientSettingsPatch } from "../hooks/useSettings";

const THREAD_DELETE_DONT_ASK_AGAIN_LABEL = "Don't ask again";

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

/** Delete-thread confirmation with "Don't ask again". Missing dialogs host resolves to not confirmed. */
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
