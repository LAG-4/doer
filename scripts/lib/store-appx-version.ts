// Microsoft Store package version mapping (dependency-free, shared by the
// desktop build script, the asset/manifest generators, and CI validation).
//
// Store rule (https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements):
// the package Version is four parts, the first must be nonzero (1..65535),
// the rest 0..65535, and the fourth is reserved for the Store (always 0).
// electron-builder v26 does NOT enforce this: AppInfo.getVersionInWeirdWindowsForm
// yields `${app.version major}.${minor}.${patch}.0`, so an app version of
// 0.0.56 would pack an invalid 0.0.56.0 manifest.
//
// The app keeps its own version (e.g. 0.0.56) end to end: package.json,
// artifact names, and updater feeds all stay on the app version. Only the
// packed manifest carries the mapped Store version (0.0.56 -> manifest
// 1.0.56.0), rewritten by a staged appxManifestCreated hook (see
// renderStoreAppxManifestHook in build-desktop-artifact.ts) because
// getVersionInWeirdWindowsForm derives the manifest quad from the app
// version and offers no Store-safe override. CI validates the unpacked
// manifest. The mapping is monotonic per app major, so updating an existing
// packaged listing means shipping a mapped version strictly higher than the
// one already certified.

export const STORE_APPX_VERSION_COMPONENT_LIMIT = 65535;

export type InvalidStoreAppxVersionReason = "not-semver" | "prerelease" | "out-of-range";

export class InvalidStoreAppxVersionError extends Error {
  readonly reason: InvalidStoreAppxVersionReason;
  readonly input: string;

  constructor(reason: InvalidStoreAppxVersionReason, input: string) {
    // Never echo the raw input: versions can carry branch metadata.
    super(`Invalid Store package version (${reason}).`);
    this.name = "InvalidStoreAppxVersionError";
    this.reason = reason;
    this.input = input;
  }
}

const TRIPLE_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

function parseTriple(version: string): [number, number, number] {
  const trimmed = version.trim();
  if (trimmed !== version || trimmed.length === 0 || /[-+]/.test(trimmed)) {
    // A hyphen/plus marks a prerelease/build suffix, which the Store rejects.
    const reason: InvalidStoreAppxVersionReason = /[-+]/.test(trimmed)
      ? "prerelease"
      : "not-semver";
    throw new InvalidStoreAppxVersionError(reason, version);
  }
  const match = TRIPLE_PATTERN.exec(trimmed);
  if (
    match === null ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    throw new InvalidStoreAppxVersionError("not-semver", version);
  }
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  if (
    !parts.every(
      (part) => Number.isInteger(part) && part >= 0 && part <= STORE_APPX_VERSION_COMPONENT_LIMIT,
    )
  ) {
    throw new InvalidStoreAppxVersionError("out-of-range", version);
  }
  return [...parts] as [number, number, number];
}

/**
 * Map an app version to the Store package semver (without the reserved
 * trailing `.0`). 0.0.56 -> "1.0.56"; 1.0.0 -> "2.0.0". Rejects prereleases
 * and out-of-range components. App majors above 65534 cannot map (the Store
 * major would exceed 65535).
 */
export function resolveStoreAppxPackageVersion(appVersion: string): string {
  const [major, minor, patch] = parseTriple(appVersion);
  if (major > STORE_APPX_VERSION_COMPONENT_LIMIT - 1) {
    throw new InvalidStoreAppxVersionError("out-of-range", appVersion);
  }
  return `${major + 1}.${minor}.${patch}`;
}

/** Full four-part manifest version: 0.0.56 -> "1.0.56.0". */
export function resolveStoreAppxManifestVersion(appVersion: string): string {
  return `${resolveStoreAppxPackageVersion(appVersion)}.0`;
}

export interface StoreAppxManifestExpectation {
  readonly identityName: string;
  readonly publisher: string;
  readonly publisherDisplayName: string;
  readonly displayName: string;
  readonly version: string;
  readonly applicationId: string;
}

/** Decode the XML entities v26 writeManifest never escapes (see AppxTarget.js). */
function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

// The v26 template single-quotes Publisher (Publisher='${publisher}') while
// every other attribute is double-quoted, so both quote styles must match.
const manifestAttribute = (xml: string, element: string, attribute: string): string | undefined => {
  const match = new RegExp(
    `<${element}\\b[^>]*\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
  ).exec(xml);
  const raw = match?.[1] ?? match?.[2];
  return raw === undefined ? undefined : decodeXmlEntities(raw);
};

const manifestElementText = (xml: string, tag: string): string | undefined => {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match?.[1] === undefined ? undefined : decodeXmlEntities(match[1]);
};

/**
 * Scheme names from real windows.protocol extension subtrees (not arbitrary
 * string occurrences elsewhere in the manifest).
 */
function protocolSchemeNames(xml: string): ReadonlyArray<string> {
  const names: Array<string> = [];
  const extensionPattern =
    /<uap:Extension\b[^>]*\bCategory\s*=\s*(?:"windows\.protocol"|'windows\.protocol')[^>]*>([\s\S]*?)<\/uap:Extension>/g;
  for (const block of xml.matchAll(extensionPattern)) {
    const protocolPattern = /<uap:Protocol\b[^>]*\bName\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    for (const protocol of (block[1] ?? "").matchAll(protocolPattern)) {
      names.push(decodeXmlEntities(protocol[1] ?? protocol[2] ?? "").toLowerCase());
    }
  }
  return names;
}

/**
 * Check an unpacked AppxManifest.xml against the expected Store values.
 * Returns a list of human-readable mismatches (empty means valid). Attribute
 * extraction accepts the v26 template's single-quoted Publisher as well as
 * double quotes, decodes XML entities so reserved names with & / Unicode
 * compare by value, and the protocol/runFullTrust checks read the real
 * manifest subtrees (production `doer` scheme only, `doer-dev` rejected).
 */
export function validateStoreAppxManifestXml(
  xml: string,
  expected: StoreAppxManifestExpectation,
): ReadonlyArray<string> {
  const problems: Array<string> = [];

  const identityName = manifestAttribute(xml, "Identity", "Name");
  if (identityName !== expected.identityName) {
    problems.push(
      `Identity.Name is ${identityName ?? "<missing>"}; expected ${expected.identityName}.`,
    );
  }
  const publisher = manifestAttribute(xml, "Identity", "Publisher");
  if (publisher !== expected.publisher) {
    problems.push(`Identity.Publisher mismatch (expected the Partner Center Publisher).`);
  }
  const version = manifestAttribute(xml, "Identity", "Version");
  if (version !== expected.version) {
    problems.push(`Identity.Version is ${version ?? "<missing>"}; expected ${expected.version}.`);
  }
  // Scope to <Properties>: the protocol extension has its own uap:DisplayName.
  const propertiesBlock = /<Properties>([\s\S]*?)<\/Properties>/.exec(xml)?.[1] ?? "";
  const displayName = manifestElementText(propertiesBlock, "DisplayName");
  if (displayName !== expected.displayName) {
    problems.push(
      `DisplayName is ${displayName ?? "<missing>"}; expected the reserved packaged name ${expected.displayName}.`,
    );
  }
  const publisherDisplayName = manifestElementText(propertiesBlock, "PublisherDisplayName");
  if (publisherDisplayName !== expected.publisherDisplayName) {
    problems.push(
      `PublisherDisplayName is ${publisherDisplayName ?? "<missing>"}; expected ${expected.publisherDisplayName}.`,
    );
  }
  const applicationId = manifestAttribute(xml, "Application", "Id");
  if (applicationId !== expected.applicationId) {
    problems.push(
      `Application.Id is ${applicationId ?? "<missing>"}; expected ${expected.applicationId}.`,
    );
  }
  const schemes = protocolSchemeNames(xml);
  if (!schemes.includes("doer")) {
    problems.push(`windows.protocol entry for the doer scheme not found.`);
  }
  if (schemes.includes("doer-dev")) {
    problems.push(`windows.protocol entry for the dev-only doer-dev scheme must not ship.`);
  }
  if (!/<(?:\w+:)?Capability\b[^>]*\bName\s*=\s*(?:"runFullTrust"|'runFullTrust')/.test(xml)) {
    problems.push(`runFullTrust capability not found.`);
  }
  return problems;
}
