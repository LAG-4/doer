import type {
  ServerProvider,
  ServerProviderVersionAdvisory,
  ServerProviderCompatibilityAdvisory,
} from "@t3tools/contracts";

/**
 * Visual treatment for each server-reported provider status. Centralized so
 * the default-driver card and per-instance cards share the same language.
 */
export const PROVIDER_STATUS_STYLES = {
  disabled: {
    dot: "bg-muted-foreground/50",
  },
  error: {
    dot: "bg-destructive",
  },
  ready: {
    dot: "bg-success",
  },
  warning: {
    dot: "bg-warning",
  },
} as const;

export type ProviderStatusKey = keyof typeof PROVIDER_STATUS_STYLES;

/**
 * Derive the headline + detail copy shown under a provider's name in the
 * settings page. Prefers `provider.message` for server-supplied detail and
 * falls back to generic phrasing when the server has not yet reported any
 * state — which happens before the first probe or when an instance names a
 * driver this build does not ship. A ready provider without account metadata
 * remains available and does not imply an authentication failure.
 */
export function getProviderSummary(provider: ServerProvider | undefined) {
  if (!provider) {
    return {
      headline: "Checking provider status",
      detail: "Waiting for the server to report installation and authentication details.",
    };
  }
  if (!provider.enabled || provider.status === "disabled") {
    return {
      headline: "Disabled",
      detail:
        provider.message ?? "This provider is installed but disabled for new sessions in Doer.",
    };
  }
  if (!provider.installed) {
    return {
      headline: "Not found",
      detail: provider.message ?? "CLI not detected on PATH.",
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return {
      headline: "Not authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.status === "warning") {
    return {
      headline: "Needs attention",
      detail:
        provider.message ?? "The provider is installed, but the server could not fully verify it.",
    };
  }
  if (provider.status === "error") {
    return {
      headline: "Unavailable",
      detail: provider.message ?? "The provider failed its startup checks.",
    };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel ? `Authenticated · ${authLabel}` : "Authenticated",
      detail: provider.message ?? null,
    };
  }
  return {
    headline: "Available",
    detail: provider.message ?? null,
  };
}

/**
 * Normalize a version string for display. Adds the `v` prefix when the
 * driver reported a bare version (e.g. `1.2.3`) so cards render
 * consistently regardless of driver.
 */
export function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  // Antigravity reports a release tag such as `agy_acp_server_20260818_01_RC01`.
  // Show the date and candidate so the row title keeps room for the name.
  const antigravity = /^agy_acp_server_(\d{4})(\d{2})(\d{2})_\d+(?:_(\w+))?$/.exec(version);
  if (antigravity) {
    const [, year, month, day, candidate] = antigravity;
    return `${year}-${month}-${day}${candidate ? ` ${candidate}` : ""}`;
  }
  // Only bare semver-like versions get a `v` prefix. Other tags are shown as-is.
  return /^\d/.test(version) ? `v${version}` : version;
}

const COMPATIBILITY_TITLES = {
  graceful: "Limited support",
  unsupported: "Unsupported version",
  broken: "Known broken version",
} as const;

/** Compatibility guidance shares the version popover, with safe install actions. */
export function getProviderVersionAdvisoryPresentation(
  advisory: ServerProviderVersionAdvisory | undefined,
  compatibility?: ServerProviderCompatibilityAdvisory | undefined,
  showCompatibility = true,
): {
  readonly title: string;
  readonly detail: string;
  readonly updateCommand: string | null;
  readonly emphasis: "normal" | "strong";
  readonly targetVersion: string | null;
} | null {
  const latestIsIncompatible =
    compatibility?.latestVersionStatus === "broken" ||
    compatibility?.latestVersionStatus === "unsupported";
  if (
    showCompatibility &&
    compatibility &&
    (compatibility.status === "graceful" ||
      compatibility.status === "unsupported" ||
      compatibility.status === "broken")
  ) {
    const targetVersion = compatibility.recommendedVersion;
    const recommendation = getProviderVersionLabel(targetVersion) ?? compatibility.recommendedRange;
    return {
      title: COMPATIBILITY_TITLES[compatibility.status],
      detail:
        compatibility.message ??
        (recommendation ? `Use ${recommendation} for full support.` : "Update for full support."),
      updateCommand:
        targetVersion || latestIsIncompatible ? null : (advisory?.updateCommand ?? null),
      emphasis: compatibility.status === "graceful" ? "normal" : "strong",
      targetVersion,
    };
  }
  if (
    !advisory ||
    advisory.status === "current" ||
    advisory.status === "unknown" ||
    latestIsIncompatible
  ) {
    return null;
  }

  const label = "Update available";
  const version = advisory.latestVersion;
  const versionLabel = getProviderVersionLabel(version);

  return {
    title: label,
    detail:
      advisory.message ??
      (versionLabel
        ? `${label}: install ${versionLabel}.`
        : `${label}: install the latest provider version.`),
    updateCommand: advisory.updateCommand,
    emphasis: "normal" as const,
    targetVersion: null,
  };
}

/** Matches ANSI color escapes some CLIs embed in error output. Built from a
 * char code so no raw control character or control escape appears in source. */
const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

/**
 * Narrow technical-health signals: CLI startup/exit crashes, health-check and
 * version-probe failures, and embedded runtime diagnostics. Checked only after
 * the actionable guards below, so useful copy always wins.
 */
const TECHNICAL_HEALTH_PATTERNS = [
  /server exited before startup/i,
  /\bstderr\b/i,
  /database is not empty/i,
  /session table/i,
  /exit(?:ed)?(?: with)? code \d/i,
  /exited before .* completed/i,
  /cli health check/i,
  /version probe/i,
  /probe timed out/i,
];

/**
 * Actionable wording that must never read as a technical dump, even wrapped
 * in ANSI or next to stderr. Checked first: sign-in, credentials, quota, and
 * install/not-found copy always stays visible with its recovery action.
 */
const ACTIONABLE_HEALTH_PATTERNS = [
  /auth/i,
  /sign[\s-]?in/i,
  /log[\s-]?in/i,
  /api[\s-]?key/i,
  /quota/i,
  /rate[\s-]?limit/i,
  /credit/i,
  /not installed/i,
  /not found/i,
  /install/i,
];

/** True when detail is a raw technical startup/health dump, not user-actionable copy. */
export function isTechnicalHealthErrorText(message: string | null | undefined): boolean {
  if (!message) return false;
  if (ACTIONABLE_HEALTH_PATTERNS.some((pattern) => pattern.test(message))) return false;
  // The shared pattern is global (for replace); reset before testing since
  // global regexes remember their last match.
  ANSI_ESCAPE_PATTERN.lastIndex = 0;
  return (
    ANSI_ESCAPE_PATTERN.test(message) ||
    TECHNICAL_HEALTH_PATTERNS.some((pattern) => pattern.test(message))
  );
}

/** Strip ANSI color escapes for display; the words themselves are preserved. */
export function stripAnsiErrorText(message: string): string {
  ANSI_ESCAPE_PATTERN.lastIndex = 0;
  return message.replace(ANSI_ESCAPE_PATTERN, "");
}

/** Short plain-language copy shown in simple mode for technical health failures. */
export const TECHNICAL_HEALTH_FRIENDLY_DETAIL =
  "The AI service couldn't start. Open setup to try again — technical details are under Advanced.";
