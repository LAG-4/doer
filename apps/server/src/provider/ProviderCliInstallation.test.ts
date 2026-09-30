import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import {
  HostProcessArchitecture,
  HostProcessPlatform,
  HostProcessHomeDirectory,
} from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ProcessRunner } from "../processRunner.ts";
import { layerTest as settingsLayerTest, ServerSettingsService } from "../serverSettings.ts";
import { cliInstallScript, makeProviderCliInstallation } from "./ProviderCliInstallation.ts";
import { OpenCodeRuntime } from "./opencodeRuntime.ts";

const id = ProviderInstanceId.make("claudeAgent");
const driver = ProviderDriverKind.make("claudeAgent");

const makeHarness = Effect.fn("ProviderCliInstallation.test.makeHarness")(function* (
  options: {
    readonly platform?: NodeJS.Platform;
    readonly custom?: string;
    readonly alreadyInstalled?: boolean;
    readonly kind?: "claudeAgent" | "cursor" | "grok";
    readonly grokFallback?: boolean;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "doer-cli-install-test-" });
  const configuredId = ProviderInstanceId.make(options.kind ?? "claudeAgent");
  const configuredDriver = ProviderDriverKind.make(options.kind ?? "claudeAgent");
  const settings = yield* ServerSettingsService;
  if (options.custom)
    yield* settings.updateSettings({
      providerInstances: {
        [id]: { driver, enabled: false, config: { binaryPath: options.custom } },
      },
    });
  const enteredInstaller = yield* Deferred.make<void>();
  const releasedInstaller = yield* Deferred.make<void>();
  let installed = options.alreadyInstalled ?? false;
  let fail = false;
  let wait = false;
  const downloads: string[] = [];
  const calls: string[] = [];
  const installation = yield* makeProviderCliInstallation(baseDir).pipe(
    Effect.provideService(HostProcessPlatform, options.platform ?? "darwin"),
    Effect.provideService(HostProcessArchitecture, options.platform === "win32" ? "x64" : "arm64"),
    Effect.provideService(HostProcessHomeDirectory, `${baseDir}/home`),
    Effect.provide(
      Layer.mock(OpenCodeRuntime)({
        createOpenCodeSdkClient: () => {
          throw new Error("Installation must not start a provider session.");
        },
        ensureOpenCodeInstalled: () =>
          Effect.succeed({ binaryPath: `${baseDir}/opencode`, freshInstall: true }),
      }),
    ),
    Effect.provideService(ProcessRunner, {
      run: (input) =>
        Effect.gen(function* () {
          calls.push(input.command);
          const isInstaller = input.command === "/bin/bash" || input.command === "powershell.exe";
          if (isInstaller) {
            yield* Deferred.succeed(enteredInstaller, undefined);
            if (wait) yield* Deferred.await(releasedInstaller);
            if (!fail) installed = true;
            if (input.command === "powershell.exe") {
              assert.include(input.args.join(" "), "Tls12");
              assert.include(input.args.join(" "), "UseBasicParsing");
            }
          }
          return {
            stdout: installed && !isInstaller ? "2.1.198" : "",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(installed ? 0 : 1),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    }),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          downloads.push(request.url);
          if (request.url.endsWith("/stable"))
            return HttpClientResponse.fromWeb(
              request,
              new Response("2.1.198", {
                status: options.grokFallback && request.url.startsWith("https://x.ai/") ? 503 : 200,
              }),
            );
          if (request.url.includes("/grok-")) installed = true;
          return HttpClientResponse.fromWeb(request, new Response("vendor installer fixture"));
        }),
      ),
    ),
  );
  return {
    installation,
    id: configuredId,
    driver: configuredDriver,
    settings,
    downloads,
    calls,
    enteredInstaller,
    setFail: (value: boolean) => {
      fail = value;
    },
    setWait: () => {
      wait = true;
    },
  };
});

const terminal = (h: Effect.Success<ReturnType<typeof makeHarness>>) =>
  h.installation.changes(h.id, h.driver).pipe(
    Stream.filter((state) => ["succeeded", "failed", "cancelled"].includes(state.phase)),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

it.effect.each([
  { kind: "claudeAgent", platform: "darwin" },
  { kind: "claudeAgent", platform: "win32" },
  { kind: "cursor", platform: "darwin" },
  { kind: "cursor", platform: "win32" },
] as const)(
  "installs and enables $kind on $platform without shell PATH changes",
  ({ kind, platform }) =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ platform, kind });
      const started = yield* h.installation.start(h.id, h.driver);
      assert.equal(started.phase, "downloading");
      const completed = yield* terminal(h);
      assert.equal(completed.phase, "succeeded");
      assert.equal(completed.installedVersion, "2.1.198");
      assert.equal(completed.canRemove, false);
      assert.deepEqual(h.downloads, [cliInstallScript(h.driver, platform)]);
      const entry = (yield* h.settings.getSettings).providerInstances[h.id];
      assert.equal(entry?.enabled, true);
      assert.propertyVal(entry?.config, "binaryPath", completed.executablePath);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(settingsLayerTest(), NodeServices.layer))),
);

it.effect.each(["darwin", "win32"] as const)(
  "installs a verified Grok binary on %s with the vendor's download fallback",
  (platform) =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ kind: "grok", platform, grokFallback: true });
      yield* h.installation.start(h.id, h.driver);
      const completed = yield* terminal(h);
      assert.equal(completed.phase, "succeeded");
      assert.include(completed.executablePath ?? "", "/tools/grok/2.1.198/grok");
      assert.equal(h.downloads.length, 3);
      assert.isTrue(
        h.downloads[2]!.startsWith(
          "https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-2.1.198-",
        ),
      );
      assert.propertyVal(
        (yield* h.settings.getSettings).providerInstances[h.id]?.config,
        "binaryPath",
        completed.executablePath,
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(settingsLayerTest(), NodeServices.layer))),
);

it.effect("reuses a native install and never downloads over a custom executable", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ alreadyInstalled: true });
    yield* h.installation.start(id, driver);
    assert.equal((yield* terminal(h)).phase, "succeeded");
    assert.deepEqual(h.downloads, []);
    const custom = yield* makeHarness({ custom: "/custom/claude" });
    yield* custom.installation.start(id, driver);
    const failed = yield* terminal(custom);
    assert.equal(failed.phase, "failed");
    assert.include(failed.message ?? "", "custom installation");
    assert.deepEqual(custom.downloads, []);
    assert.deepEqual(custom.calls, []);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(settingsLayerTest(), NodeServices.layer))),
);

it.effect("allows retry after a failed installer without enabling a broken service", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    h.setFail(true);
    yield* h.installation.start(id, driver);
    assert.equal((yield* terminal(h)).phase, "failed");
    assert.equal((yield* h.settings.getSettings).providerInstances[id], undefined);
    h.setFail(false);
    yield* h.installation.start(id, driver);
    assert.equal((yield* terminal(h)).phase, "succeeded");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(settingsLayerTest(), NodeServices.layer))),
);

it.effect("deduplicates starts and cancels only the current operation", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    h.setWait();
    const started = yield* h.installation.start(id, driver);
    yield* Deferred.await(h.enteredInstaller);
    assert.equal((yield* h.installation.start(id, driver)).operationId, started.operationId);
    const stale = yield* h.installation.cancel(id, "stale").pipe(Effect.flip);
    assert.equal(stale._tag, "ProviderSetupError");
    yield* h.installation.cancel(id, started.operationId!);
    assert.equal((yield* terminal(h)).phase, "cancelled");
    assert.equal((yield* h.settings.getSettings).providerInstances[id], undefined);
    assert.equal(h.downloads.length, 1);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(settingsLayerTest(), NodeServices.layer))),
);
