/** One visibility policy for navigation, search, direct routes and restored panels. */
export function isAdvancedSettingsPath(path: string): boolean {
  return [
    "/settings/source-control",
    "/settings/keybindings",
    "/settings/connections",
    "/settings/diagnostics",
  ].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
export function isAdvancedPanel(kind: string): boolean {
  return ["terminal", "diff", "pull-request", "pull-requests"].includes(kind);
}
export function isAdvancedCommand(command: string): boolean {
  return (
    command.startsWith("terminal.") ||
    command.startsWith("diff.") ||
    ["composer.workspace", "composer.branch", "composer.previousWorktree"].includes(command) ||
    command.startsWith("git.") ||
    command.startsWith("worktree.") ||
    command.startsWith("pullRequest.")
  );
}
const ADVANCED_SETTING_IDS = new Set([
  "new-threads",
  "worktree-submodules",
  "project-grouping",
  "auto-settle-merged-threads",
  "hide-whitespace-changes",
  "default-diff-file-state",
  "diff-layout",
  "diff-color-scheme",
  "proactive-panels",
  "skills-in-slash-menu",
  "provider-update-checks",
  "background-activity",
  "start-from-origin",
  "add-project-starts-in",
  "projects-and-threads",
  "text-generation",
  "text-generation-model",
  "storage-worktrees",
  "delete-worktrees-with-deleted-threads",
]);
export function isAdvancedSettingId(id: string | undefined): boolean {
  return (
    id !== undefined &&
    (ADVANCED_SETTING_IDS.has(id) ||
      /^(?:diagnostics|terminal|git|source-control|keybinding|load-balancing|worktree|project-script)/.test(
        id,
      ))
  );
}
export function isAdvancedSettingsItem(item: { to: string; id: string }): boolean {
  return isAdvancedSettingsPath(item.to) || isAdvancedSettingId(item.id);
}
