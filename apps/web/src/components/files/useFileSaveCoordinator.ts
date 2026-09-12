import type { EnvironmentId } from "@t3tools/contracts";
import { createRef, useEffect, useMemo } from "react";

import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import { FileSaveCoordinator } from "./fileSaveCoordinator";
import { confirmProjectFileQueryData } from "./projectFilesQueryState";

const FILE_SAVE_DEBOUNCE_MS = 500;

interface FileSaveOptions {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  onPendingChange: (relativePath: string, pending: boolean) => void;
  /**
   * Extra write payload for binary files. When present, saves carry it (for
   * example base64 spreadsheet bytes) instead of text, with the same pending
   * and confirmed flow. The text optimistic cache is untouched: binary
   * payloads must never read as text.
   */
  binaryEncoding?: "base64";
  /** Runs after the text optimistic confirm, e.g. to snapshot saved bytes. */
  onSaved?: (contents: string) => void;
  /** Runs when a save round fails, e.g. to surface a retry toast. */
  onSaveError?: () => void;
}

export function useFileSaveCoordinator({
  environmentId,
  cwd,
  relativePath,
  onPendingChange,
  binaryEncoding,
  onSaved,
  onSaveError,
}: FileSaveOptions): Pick<FileSaveCoordinator, "change" | "save"> {
  const writeFile = useAtomCommand(projectEnvironment.writeFile);
  const session = useMemo(() => {
    const coordinatorRef = createRef<FileSaveCoordinator>();
    return {
      change: (contents: string) => coordinatorRef.current?.change(contents),
      save: (contents: string) => coordinatorRef.current?.save(contents),
      setup: () => {
        const coordinator = new FileSaveCoordinator({
          debounceMs: FILE_SAVE_DEBOUNCE_MS,
          onPendingChange: (pending) => onPendingChange(relativePath, pending),
          persist: (nextContents) =>
            writeFile({
              environmentId,
              input: {
                cwd,
                relativePath,
                contents: nextContents,
                ...(binaryEncoding ? { encoding: binaryEncoding } : {}),
              },
            }),
          onConfirmed: (confirmedContents) => {
            confirmProjectFileQueryData(environmentId, cwd, relativePath, confirmedContents);
            onSaved?.(confirmedContents);
          },
          onFailure: () => {
            onSaveError?.();
          },
        });
        coordinatorRef.current = coordinator;
        return () => {
          coordinatorRef.current = null;
          coordinator.dispose();
        };
      },
    };
  }, [
    binaryEncoding,
    cwd,
    environmentId,
    onPendingChange,
    onSaved,
    onSaveError,
    relativePath,
    writeFile,
  ]);

  // StrictMode replays effect setup. Retired file sessions stay inert, while the
  // replay gets a fresh coordinator instead of reusing a disposed one.
  useEffect(session.setup, [session]);
  return session;
}
