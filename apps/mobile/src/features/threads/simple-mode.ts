/**
 * Simple mode hides commit, branch, worktree, and terminal controls.
 * `undefined` means "never chosen", which resolves to on.
 */
export function resolveSimpleModeEnabled(input: {
  readonly preference: boolean | undefined;
  readonly preferencesLoaded: boolean;
}): boolean {
  if (!input.preferencesLoaded) {
    return true;
  }
  return input.preference !== false;
}
