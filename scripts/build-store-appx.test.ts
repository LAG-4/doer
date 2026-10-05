// @effect-diagnostics nodeBuiltinImport:off - Tests stage a real temp-dir hook and manifest with Node fs/path APIs.
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  createBuildConfig,
  InvalidStoreAppxIdentityError,
  isStoreAppxTarget,
  MissingStoreAppxIdentityError,
  renderStoreAppxManifestHook,
  resolveStoreAppxIdentity,
  SignedStoreAppxUnsupportedError,
  STORE_APPX_APPLICATION_ID,
  STORE_APPX_MIN_VERSION,
  UnsupportedStoreAppxTargetError,
} from "./build-desktop-artifact.ts";
import { findMissingStoreAppxAssets, STORE_APPX_ASSETS } from "./lib/store-appx-assets.ts";
import {
  resolveStoreAppxManifestVersion,
  resolveStoreAppxPackageVersion,
  validateStoreAppxManifestXml,
} from "./lib/store-appx-version.ts";

// Deliberately synthetic publisher GUID: never a real Partner Center value.
const STORE_IDENTITY = {
  identityName: "12345Example.Publisher-Doer",
  publisher: "CN=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  publisherDisplayName: "Example Publisher",
  displayName: "Doer Alpha",
};

// Reserved names may legally contain & / Unicode; v26 injects them raw, so
// the hook must carry them XML-escaped.
const STORE_IDENTITY_AMP = {
  ...STORE_IDENTITY,
  publisherDisplayName: "Example & Söhne",
  displayName: "Doer & Co",
};

// Real default v26 template shape: single-quoted Publisher, double-quoted
// Name/Version, Properties DisplayName/PublisherDisplayName, Application Id,
// windows.protocol extension, rescap runFullTrust capability.
const renderV26Manifest = (overrides?: {
  readonly identityName?: string;
  readonly publisher?: string;
  readonly version?: string;
  readonly displayName?: string;
  readonly publisherDisplayName?: string;
  readonly schemes?: ReadonlyArray<string>;
  readonly capabilities?: string;
}): string => {
  const identityName = overrides?.identityName ?? STORE_IDENTITY.identityName;
  const publisher = overrides?.publisher ?? STORE_IDENTITY.publisher;
  const version = overrides?.version ?? "1.0.56.0";
  const displayName = overrides?.displayName ?? STORE_IDENTITY.displayName;
  const publisherDisplayName =
    overrides?.publisherDisplayName ?? STORE_IDENTITY.publisherDisplayName;
  const schemes = overrides?.schemes ?? ["doer"];
  const capabilities = overrides?.capabilities ?? '<rescap:Capability Name="runFullTrust" />';
  const extensions = schemes
    .map(
      (scheme) =>
        `<uap:Extension Category="windows.protocol"><uap:Protocol Name="${scheme}"><uap:DisplayName>Doer</uap:DisplayName></uap:Protocol></uap:Extension>`,
    )
    .join("");
  return (
    `<Package><Identity Name="${identityName}" ProcessorArchitecture="x64" Publisher='${publisher}' Version="${version}" />` +
    `<Properties><DisplayName>${displayName}</DisplayName><PublisherDisplayName>${publisherDisplayName}</PublisherDisplayName></Properties>` +
    `<Applications><Application Id="${STORE_APPX_APPLICATION_ID}" Executable="app\\Doer.exe" EntryPoint="Windows.FullTrustApplication"><Extensions>${extensions}</Extensions></Application></Applications>` +
    `<Capabilities>${capabilities}</Capabilities></Package>`
  );
};

it.layer(NodeServices.layer)("Store AppX packaging", (it) => {
  it("accepts numeric-prefix and hyphenated Partner Center identity names", () => {
    assert.deepStrictEqual(resolveStoreAppxIdentity(STORE_IDENTITY), STORE_IDENTITY);
    assert.deepStrictEqual(
      resolveStoreAppxIdentity({ ...STORE_IDENTITY, identityName: "999-My.Co-App" }),
      { ...STORE_IDENTITY, identityName: "999-My.Co-App" },
    );
  });

  it("accepts a different reserved display name without touching the exe identity", () => {
    const resolved = resolveStoreAppxIdentity({ ...STORE_IDENTITY, displayName: "Doer Beta" });
    assert.equal(resolved.displayName, "Doer Beta");
    assert.equal(resolved.identityName, STORE_IDENTITY.identityName);
  });

  it("rejects identity names outside the v26 3..50 bounds", () => {
    const captureError = (identityName: string) => {
      try {
        resolveStoreAppxIdentity({ ...STORE_IDENTITY, identityName });
      } catch (error) {
        return error;
      }
      return assert.fail("Expected Store AppX identity resolution to fail.");
    };

    assert.equal((captureError("ab") as InvalidStoreAppxIdentityError).reason, "length");
    assert.equal(
      (captureError(`a.${"b".repeat(50)}`) as InvalidStoreAppxIdentityError).reason,
      "length",
    );
    const badCharset = captureError("0ad name!");
    assert.instanceOf(badCharset, InvalidStoreAppxIdentityError);
    assert.equal((badCharset as InvalidStoreAppxIdentityError).reason, "charset");
  });

  it("fails closed when any identity value (including display name) is missing", () => {
    const captureError = (input: Record<string, string | undefined>) => {
      try {
        resolveStoreAppxIdentity(input);
      } catch (error) {
        return error;
      }
      return assert.fail("Expected Store AppX identity resolution to fail.");
    };

    const missingName = captureError({
      publisher: STORE_IDENTITY.publisher,
      publisherDisplayName: STORE_IDENTITY.publisherDisplayName,
      displayName: STORE_IDENTITY.displayName,
    });
    assert.instanceOf(missingName, MissingStoreAppxIdentityError);
    assert.equal((missingName as MissingStoreAppxIdentityError).field, "identityName");

    const missingDisplayName = captureError({
      identityName: STORE_IDENTITY.identityName,
      publisher: STORE_IDENTITY.publisher,
      publisherDisplayName: STORE_IDENTITY.publisherDisplayName,
    });
    assert.instanceOf(missingDisplayName, MissingStoreAppxIdentityError);
    assert.equal((missingDisplayName as MissingStoreAppxIdentityError).field, "displayName");

    // Whitespace-only values are missing values, not identities.
    const blankPublisher = captureError({ ...STORE_IDENTITY, publisher: "   " });
    assert.instanceOf(blankPublisher, MissingStoreAppxIdentityError);
    assert.equal((blankPublisher as MissingStoreAppxIdentityError).field, "publisher");

    // A non-CN publisher is malformed input, not a listing match.
    const badPublisher = captureError({ ...STORE_IDENTITY, publisher: "O=Example Corp" });
    assert.instanceOf(badPublisher, InvalidStoreAppxIdentityError);
    assert.equal((badPublisher as InvalidStoreAppxIdentityError).reason, "publisher-format");

    // Error payloads carry only field + reason, never the submitted values.
    for (const error of [missingName, blankPublisher, badPublisher]) {
      assert.notProperty(error, "identityName");
      assert.notProperty(error, "publisher");
      assert.notProperty(error, "value");
    }
  });

  it("maps app versions to monotonic Store versions (major+1, revision 0)", () => {
    assert.equal(resolveStoreAppxPackageVersion("0.0.56"), "1.0.56");
    assert.equal(resolveStoreAppxManifestVersion("0.0.56"), "1.0.56.0");
    assert.equal(resolveStoreAppxManifestVersion("1.0.0"), "2.0.0.0");
    // Major-zero app versions map to a valid nonzero Store major.
    assert.equal(resolveStoreAppxPackageVersion("0.0.0"), "1.0.0");

    assert.throws(() => resolveStoreAppxPackageVersion("0.0.56-nightly.20260101.1"), /prerelease/);
    assert.throws(() => resolveStoreAppxPackageVersion("1.0.0-beta"), /prerelease/);
    assert.throws(() => resolveStoreAppxPackageVersion("1.0.70000"), /out-of-range/);
  });

  it("renders a manifest hook that rewrites the version and escaped identity", () => {
    const hookSource = renderStoreAppxManifestHook("1.0.56.0", STORE_IDENTITY_AMP);
    assert.include(hookSource, "1.0.56.0");
    assert.include(hookSource, "storeAppxManifestCreated");
    assert.include(hookSource, "Identity");
    assert.include(hookSource, "PublisherDisplayName");
    // Reserved names with & / Unicode ship XML-escaped, never raw.
    assert.include(hookSource, "Doer &amp; Co");
    assert.include(hookSource, "Example &amp; Söhne");
    assert.notInclude(hookSource, "Doer & Co");
    // Missing nodes fail the build instead of shipping a half-rewritten manifest.
    assert.include(hookSource, "Identity Version");
    assert.include(hookSource, "Identity Publisher");
  });

  it("executes the generated hook against a v26 template manifest", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doer-store-appx-hook-"));
    const hookPath = NodePath.join(dir, "store-appx-manifest-hook.cjs");
    NodeFS.writeFileSync(hookPath, renderStoreAppxManifestHook("1.0.56.0", STORE_IDENTITY_AMP));
    const manifestPath = NodePath.join(dir, "AppxManifest.xml");
    // Pre-hook content mirrors what v26 writeManifest emits for app 0.0.56:
    // verbatim 0.0.56.0 version, placeholder identity, raw ampersands.
    NodeFS.writeFileSync(
      manifestPath,
      `<Package><Identity Name="Placeholder.Name" ProcessorArchitecture="x64" Publisher='CN=placeholder' Version="0.0.56.0" />` +
        `<Properties><DisplayName>Placeholder</DisplayName><PublisherDisplayName>Placeholder</PublisherDisplayName></Properties>` +
        `<Applications><Application Id="${STORE_APPX_APPLICATION_ID}" Executable="app\\Doer.exe" EntryPoint="Windows.FullTrustApplication">` +
        `<uap:VisualElements BackgroundColor="#464646" DisplayName="Placeholder" Square150x150Logo="assets\\Square150x150Logo.png" Square44x44Logo="assets\\Square44x44Logo.png" />` +
        `<Extensions><uap:Extension Category="windows.protocol"><uap:Protocol Name="doer"><uap:DisplayName>Doer</uap:DisplayName></uap:Protocol></uap:Extension></Extensions>` +
        `</Application></Applications>` +
        `<Capabilities><rescap:Capability Name="runFullTrust" /></Capabilities></Package>`,
    );
    const hook = (await import(NodeURL.pathToFileURL(hookPath).href)).default as (
      manifestPath: string,
    ) => Promise<void>;
    await hook(manifestPath);
    const rewritten = NodeFS.readFileSync(manifestPath, "utf8");
    assert.include(rewritten, 'Version="1.0.56.0"');
    assert.include(rewritten, STORE_IDENTITY_AMP.identityName);
    assert.include(rewritten, "Doer &amp; Co");
    assert.include(rewritten, "Example &amp; Söhne");
    assert.deepStrictEqual(
      validateStoreAppxManifestXml(rewritten, {
        identityName: STORE_IDENTITY_AMP.identityName,
        publisher: STORE_IDENTITY_AMP.publisher,
        publisherDisplayName: STORE_IDENTITY_AMP.publisherDisplayName,
        displayName: STORE_IDENTITY_AMP.displayName,
        version: "1.0.56.0",
        applicationId: STORE_APPX_APPLICATION_ID,
      }),
      [],
    );

    const missingPath = NodePath.join(dir, "AppxManifest-missing.xml");
    NodeFS.writeFileSync(
      missingPath,
      `<Package><Properties><DisplayName>x</DisplayName></Properties></Package>`,
    );
    let failure: unknown;
    try {
      await hook(missingPath);
    } catch (error) {
      failure = error;
    }
    assert.instanceOf(failure, Error);
    assert.include((failure as Error).message, "Identity Version");
  });

  it("requires the four own brand assets and detects gaps without imaging", () => {
    assert.deepStrictEqual(
      STORE_APPX_ASSETS.map((asset) => `${asset.name} ${asset.width}x${asset.height}`),
      [
        "StoreLogo.png 50x50",
        "Square150x150Logo.png 150x150",
        "Square44x44Logo.png 44x44",
        "Wide310x150Logo.png 310x150",
      ],
    );
    assert.deepStrictEqual(findMissingStoreAppxAssets(STORE_APPX_ASSETS.map((a) => a.name)), []);
    assert.deepStrictEqual(findMissingStoreAppxAssets(["StoreLogo.png"]), [
      "Square150x150Logo.png",
      "Square44x44Logo.png",
      "Wide310x150Logo.png",
    ]);
  });

  it("validates an unpacked manifest against the expected Store values", () => {
    const xml = renderV26Manifest();
    assert.deepStrictEqual(
      validateStoreAppxManifestXml(xml, {
        identityName: STORE_IDENTITY.identityName,
        publisher: STORE_IDENTITY.publisher,
        publisherDisplayName: STORE_IDENTITY.publisherDisplayName,
        displayName: STORE_IDENTITY.displayName,
        version: "1.0.56.0",
        applicationId: STORE_APPX_APPLICATION_ID,
      }),
      [],
    );
    // Escaped reserved names (& / Unicode) compare by decoded value.
    const escaped = renderV26Manifest({
      displayName: "Doer &amp; Co",
      publisherDisplayName: "Example &amp; Söhne",
    });
    assert.deepStrictEqual(
      validateStoreAppxManifestXml(escaped, {
        identityName: STORE_IDENTITY.identityName,
        publisher: STORE_IDENTITY.publisher,
        publisherDisplayName: "Example & Söhne",
        displayName: "Doer & Co",
        version: "1.0.56.0",
        applicationId: STORE_APPX_APPLICATION_ID,
      }),
      [],
    );
    const problems = validateStoreAppxManifestXml(xml, {
      identityName: "Other.Name",
      publisher: STORE_IDENTITY.publisher,
      publisherDisplayName: STORE_IDENTITY.publisherDisplayName,
      displayName: STORE_IDENTITY.displayName,
      version: "9.9.9.0",
      applicationId: STORE_APPX_APPLICATION_ID,
    });
    assert.isAbove(problems.length, 0);
  });

  it("rejects publisher display name mismatches, dev schemes, and missing runFullTrust", () => {
    const base = {
      identityName: STORE_IDENTITY.identityName,
      publisher: STORE_IDENTITY.publisher,
      publisherDisplayName: STORE_IDENTITY.publisherDisplayName,
      displayName: STORE_IDENTITY.displayName,
      version: "1.0.56.0",
      applicationId: STORE_APPX_APPLICATION_ID,
    };
    assert.isAbove(
      validateStoreAppxManifestXml(
        renderV26Manifest({ publisherDisplayName: "Someone Else" }),
        base,
      ).length,
      0,
    );
    // The dev-only scheme must not ship even alongside the production one.
    assert.isAbove(
      validateStoreAppxManifestXml(renderV26Manifest({ schemes: ["doer", "doer-dev"] }), base)
        .length,
      0,
    );
    // A bare string occurrence outside the protocol subtree is not evidence.
    assert.isAbove(
      validateStoreAppxManifestXml(
        `${renderV26Manifest({ schemes: [] })}<!-- Name="doer" -->`,
        base,
      ).length,
      0,
    );
    assert.isAbove(
      validateStoreAppxManifestXml(renderV26Manifest({ capabilities: "" }), base).length,
      0,
    );
  });

  it("recognizes only the appx target as a Store package", () => {
    assert.equal(isStoreAppxTarget("appx"), true);
    assert.equal(isStoreAppxTarget("nsis"), false);
    assert.equal(isStoreAppxTarget("dmg"), false);
  });

  it.effect(
    "emits a Store AppX config with explicit applicationId, display name, and minVersion",
    () =>
      Effect.gen(function* () {
        const config = (yield* createBuildConfig(
          "win",
          "appx",
          "0.0.56",
          false,
          false,
          undefined,
          undefined,
          true,
          "x64",
          STORE_IDENTITY,
          "C:/stage/store-appx-manifest-hook.cjs",
        )) as unknown as Record<string, unknown>;

        assert.deepStrictEqual(config.appx, {
          identityName: STORE_IDENTITY.identityName,
          publisher: STORE_IDENTITY.publisher,
          publisherDisplayName: STORE_IDENTITY.publisherDisplayName,
          applicationId: STORE_APPX_APPLICATION_ID,
          displayName: STORE_IDENTITY.displayName,
          languages: ["en-US"],
          minVersion: STORE_APPX_MIN_VERSION,
        });
        assert.equal(config.appxManifestCreated, "C:/stage/store-appx-manifest-hook.cjs");
        assert.deepStrictEqual((config.win as Record<string, unknown>).target, ["appx"]);
        // Only the production scheme ships in the Store manifest; doer-dev
        // stays dev-only. electron-builder maps top-level protocols to
        // windows.protocol manifest extensions.
        assert.deepStrictEqual(config.protocols, [{ name: "Doer", schemes: ["doer"] }]);
        // No NSIS payload and no app-update.yml feed: the Store owns updates.
        assert.notProperty(config, "nsis");
        assert.notProperty(config, "publish");
      }),
  );

  it.effect("omits the manifest hook when no hook path is staged", () =>
    Effect.gen(function* () {
      const config = (yield* createBuildConfig(
        "win",
        "appx",
        "0.0.56",
        false,
        false,
        undefined,
        undefined,
        true,
        "x64",
        STORE_IDENTITY,
      )) as unknown as Record<string, unknown>;

      assert.notProperty(config, "appxManifestCreated");
    }),
  );

  it.effect("keeps the direct-download NSIS config free of Store settings", () =>
    Effect.gen(function* () {
      const config = (yield* createBuildConfig(
        "win",
        "nsis",
        "0.0.44",
        false,
        false,
        undefined,
        undefined,
        true,
      )) as unknown as Record<string, unknown>;

      assert.notProperty(config, "appx");
      assert.notProperty(config, "protocols");
      assert.notProperty(config, "appxManifestCreated");
      assert.deepStrictEqual(config.nsis, { differentialPackage: true });
    }),
  );

  it.effect("refuses an AppX build without an explicit identity", () =>
    Effect.gen(function* () {
      const error = yield* createBuildConfig(
        "win",
        "appx",
        "0.0.56",
        false,
        false,
        undefined,
        undefined,
        true,
      ).pipe(Effect.flip);

      assert.instanceOf(error, MissingStoreAppxIdentityError);
    }),
  );

  it.effect("refuses an AppX build with a malformed publisher", () =>
    Effect.gen(function* () {
      const error = yield* createBuildConfig(
        "win",
        "appx",
        "0.0.56",
        false,
        false,
        undefined,
        undefined,
        true,
        "x64",
        { ...STORE_IDENTITY, publisher: "Unsigned" },
      ).pipe(Effect.flip);

      assert.instanceOf(error, InvalidStoreAppxIdentityError);
      assert.equal((error as InvalidStoreAppxIdentityError).reason, "publisher-format");
    }),
  );

  it.effect("refuses the AppX target outside Windows", () =>
    Effect.gen(function* () {
      const macError = yield* createBuildConfig(
        "mac",
        "appx",
        "0.0.56",
        false,
        false,
        undefined,
        undefined,
      ).pipe(Effect.flip);
      assert.instanceOf(macError, UnsupportedStoreAppxTargetError);

      const linuxError = yield* createBuildConfig(
        "linux",
        "appx",
        "0.0.56",
        false,
        false,
        undefined,
        undefined,
      ).pipe(Effect.flip);
      assert.instanceOf(linuxError, UnsupportedStoreAppxTargetError);
    }),
  );

  it.effect("refuses a signed AppX build: the Store signs after certification", () =>
    Effect.gen(function* () {
      const error = yield* createBuildConfig(
        "win",
        "appx",
        "0.0.56",
        true,
        false,
        undefined,
        undefined,
        true,
        "x64",
        STORE_IDENTITY,
      ).pipe(Effect.flip);

      assert.instanceOf(error, SignedStoreAppxUnsupportedError);
    }),
  );
});
