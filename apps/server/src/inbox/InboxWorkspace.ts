/**
 * InboxWorkspace - path conventions for the no-folder workspace ("My Stuff").
 *
 * One shared folder backs every chat started without picking a project:
 * when no project is selected, that folder is used. All functions are pure
 * over explicit inputs so both the server runtime and unit tests share them.
 *
 * @module InboxWorkspace
 */

/** Folder name of the auto-provisioned inbox under `~/Documents`. */
export const INBOX_DIR_NAME = "Doer";
/** Sidebar title of the auto-provisioned inbox project. */
export const INBOX_PROJECT_TITLE = "My Stuff";

/** Minimal path surface shared by `node:path` and Effect's `Path` service. */
export interface InboxJoinablePath {
  readonly join: (...parts: ReadonlyArray<string>) => string;
  readonly resolve: (...parts: ReadonlyArray<string>) => string;
}

/** Deterministic inbox root for a home directory: `~/Documents/Doer`. */
export function resolveInboxRoot(homeDir: string, path: InboxJoinablePath): string {
  return path.join(homeDir, "Documents", INBOX_DIR_NAME);
}

/** Whether a project workspace root is the inbox root (post-normalization). */
export function isInboxWorkspaceRoot(
  workspaceRoot: string,
  inboxRoot: string,
  path: InboxJoinablePath,
): boolean {
  return path.resolve(workspaceRoot) === path.resolve(inboxRoot);
}
