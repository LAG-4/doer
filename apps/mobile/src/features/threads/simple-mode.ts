/**
 * Simple mode hides commit, branch, worktree, and terminal controls for a calmer
 * default UI. The preference is sparse: `undefined` means "never chosen",
 * which resolves to on — matching web's `simpleModeEnabled` default.
 *
 * `preferencesLoaded` guards the startup window: preferences load
 * asynchronously, and holding the default while loading avoids flashing git
 * controls in for every device that never opted out.
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
