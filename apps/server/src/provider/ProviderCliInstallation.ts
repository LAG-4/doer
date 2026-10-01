import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderInstallState,
  ProviderSetupError,
} from "@t3tools/contracts";
import {
  HostProcessArchitecture,
  HostProcessPlatform,
  HostProcessEnvironment,
  HostProcessHomeDirectory,
} from "@t3tools/shared/hostProcess";
import { parseSemver } from "@t3tools/shared/semver";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { ServerConfig } from "../config.ts";
import { ProcessRunner } from "../processRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { deriveProviderInstanceConfigMap } from "./Layers/ProviderInstanceRegistryHydration.ts";
import { OpenCodeRuntime } from "./opencodeRuntime.ts";

export const supportsCliInstallation = (driver: ProviderDriverKind) =>
  driver === "opencode" || driver === "claudeAgent" || driver === "cursor" || driver === "grok";

const defaults: Readonly<Record<string, string>> = {
  opencode: "opencode",
  claudeAgent: "claude",
  cursor: "cursor-agent",
  grok: "grok",
};
const isSetupError = Schema.is(ProviderSetupError);

/** Fixed vendor installers; clients cannot supply a command or download URL. */
export function cliInstallScript(driver: ProviderDriverKind, platform: NodeJS.Platform) {
  if (driver === "claudeAgent") {
    return platform === "win32" ? "https://claude.ai/install.ps1" : "https://claude.ai/install.sh";
  }
  if (driver === "cursor") {
    return platform === "win32"
      ? "https://cursor.com/install?win32=true"
      : "https://cursor.com/install";
  }
  return null;
}

export class ProviderCliInstallation extends Context.Service<
  ProviderCliInstallation,
  {
    readonly start: (
      instanceId: ProviderInstanceId,
      driver: ProviderDriverKind,
    ) => Effect.Effect<ProviderInstallState, ProviderSetupError>;
    readonly cancel: (
      instanceId: ProviderInstanceId,
      operationId: string,
    ) => Effect.Effect<ProviderInstallState, ProviderSetupError>;
    readonly changes: (
      instanceId: ProviderInstanceId,
      driver: ProviderDriverKind,
    ) => Stream.Stream<ProviderInstallState>;
  }
>()("@lag4/doer-cli/provider/ProviderCliInstallation") {
  static readonly layer = Layer.effect(
    ProviderCliInstallation,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      return yield* makeProviderCliInstallation(config.baseDir);
    }),
  );
}

export const makeProviderCliInstallation = Effect.fn("makeProviderCliInstallation")(function* (
  baseDir: string,
) {
  const scope = yield* Effect.scope;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const runner = yield* ProcessRunner;
  const settings = yield* ServerSettingsService;
  const openCode = yield* OpenCodeRuntime;
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  const homeDir = yield* HostProcessHomeDirectory;
  const environment = yield* HostProcessEnvironment;
  const crypto = yield* Crypto.Crypto;
  // All native instances share the same vendor installation directory.
  const gate = yield* Semaphore.make(1);
  const requestGate = yield* Semaphore.make(1);
  const states = new Map<
    ProviderInstanceId,
    SubscriptionRef.SubscriptionRef<ProviderInstallState>
  >();
  const running = new Map<ProviderInstanceId, { operationId: string; fiber: Fiber.Fiber<void> }>();
  const stateFor = Effect.fn("ProviderCliInstallation.stateFor")(function* (
    instanceId: ProviderInstanceId,
    driver: ProviderDriverKind,
  ) {
    const existing = states.get(instanceId);
    if (existing) return existing;
    const state = yield* SubscriptionRef.make<ProviderInstallState>({
      driver,
      operationId: null,
      phase: "idle",
      downloadedBytes: 0,
      totalBytes: null,
      version: null,
      installedVersion: null,
      canRemove: false,
      message: null,
    });
    states.set(instanceId, state);
    return state;
  });
  const failure = (instanceId: ProviderInstanceId, detail: string) =>
    new ProviderSetupError({ instanceId, operation: "install", detail });

  const verify = Effect.fn("ProviderCliInstallation.verify")(function* (binary: string) {
    const result = yield* runner.run({
      command: binary,
      args: ["--version"],
      timeout: "30 seconds",
      maxOutputBytes: 32 * 1024,
      outputMode: "truncate",
    });
    if (result.code !== 0 || !result.stdout.trim()) return null;
    return result.stdout.trim().split("\n")[0]!.slice(0, 200);
  });

  const install = Effect.fn("ProviderCliInstallation.install")(
    function* (
      instanceId: ProviderInstanceId,
      driver: ProviderDriverKind,
      state: SubscriptionRef.SubscriptionRef<ProviderInstallState>,
    ) {
      const current = yield* settings.getSettings;
      const entry = deriveProviderInstanceConfigMap(current)[instanceId];
      if (!entry || entry.driver !== driver)
        return yield* failure(
          instanceId,
          "This AI service was removed. Add it again before setting it up.",
        );
      const config = typeof entry.config === "object" && entry.config !== null ? entry.config : {};
      if (
        driver === "opencode" &&
        "serverUrl" in config &&
        typeof config.serverUrl === "string" &&
        config.serverUrl.trim()
      ) {
        return yield* failure(
          instanceId,
          "This OpenCode service runs on another computer. Set it up on that computer.",
        );
      }
      const configured =
        "binaryPath" in config && typeof config.binaryPath === "string"
          ? config.binaryPath.trim()
          : "";
      const native =
        driver === "claudeAgent"
          ? path.join(homeDir, ".local", "bin", platform === "win32" ? "claude.exe" : "claude")
          : driver === "cursor"
            ? platform === "win32"
              ? path.join(
                  environment.LOCALAPPDATA ?? path.join(homeDir, "AppData", "Local"),
                  "cursor-agent",
                  "cursor-agent.cmd",
                )
              : path.join(homeDir, ".local", "bin", "cursor-agent")
            : "";
      const grokRoot = path.join(baseDir, "tools", "grok");
      const ownedGrok = driver === "grok" && configured.startsWith(`${grokRoot}${path.sep}`);
      if (configured && configured !== defaults[driver] && configured !== native && !ownedGrok) {
        return yield* failure(
          instanceId,
          "This service uses a custom installation. Choose the default installation in Advanced settings to use automatic setup.",
        );
      }
      let binary = native || configured || defaults[driver]!;
      let version: string | null = null;
      if (driver === "opencode") {
        const installed = yield* openCode.ensureOpenCodeInstalled({
          binaryPath: "opencode",
          managedDir: path.join(baseDir, "tools", "opencode"),
        });
        binary = installed.binaryPath;
      } else {
        version = yield* verify(binary).pipe(Effect.orElseSucceed(() => null));
        if (!version) {
          const staging = yield* fs.makeTempDirectoryScoped({ prefix: "doer-ai-setup-" });
          if (driver === "grok") {
            const target =
              platform === "darwin" && arch === "arm64"
                ? "macos-aarch64"
                : platform === "linux" && arch === "x64"
                  ? "linux-x86_64"
                  : platform === "linux" && arch === "arm64"
                    ? "linux-aarch64"
                    : platform === "win32" && arch === "x64"
                      ? "windows-x86_64"
                      : null;
            if (!target)
              return yield* failure(
                instanceId,
                "Grok does not offer an installation for this computer yet. Choose another AI service.",
              );
            // Same public channel pointer and fallback used by x.ai's native installer.
            const fetchRelease = Effect.fn("ProviderCliInstallation.fetchGrokRelease")(function* (
              origin: string,
            ) {
              const response = yield* http
                .execute(HttpClientRequest.get(`${origin}/stable`))
                .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
              const release = (yield* response.text).trim();
              if (!parseSemver(release))
                return yield* failure(
                  instanceId,
                  "Grok returned an invalid release. Try setup again later.",
                );
              const download = yield* http
                .execute(
                  HttpClientRequest.get(
                    `${origin}/grok-${release}-${target}${platform === "win32" ? ".exe" : ""}`,
                  ),
                )
                .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
              const downloaded = path.join(staging, platform === "win32" ? "grok.exe" : "grok");
              yield* download.stream.pipe(Stream.run(fs.sink(downloaded)));
              if (platform !== "win32") yield* fs.chmod(downloaded, 0o755);
              if (!(yield* verify(downloaded)))
                return yield* failure(
                  instanceId,
                  "The Grok download could not run on this computer. Try setup again.",
                );
              const destination = path.join(
                grokRoot,
                release,
                platform === "win32" ? "grok.exe" : "grok",
              );
              yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
              yield* fs.copyFile(downloaded, destination);
              return destination;
            });
            binary = yield* fetchRelease("https://x.ai/cli").pipe(
              Effect.catch(() =>
                fetchRelease("https://storage.googleapis.com/grok-build-public-artifacts/cli"),
              ),
            );
          } else {
            const url = cliInstallScript(driver, platform);
            if (!url)
              return yield* failure(
                instanceId,
                "Automatic setup is not available for this AI service.",
              );
            const script = path.join(staging, platform === "win32" ? "install.ps1" : "install.sh");
            const response = yield* http
              .execute(HttpClientRequest.get(url))
              .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
            yield* response.stream.pipe(Stream.run(fs.sink(script)));
            const result = yield* runner.run({
              command: platform === "win32" ? "powershell.exe" : "/bin/bash",
              args:
                platform === "win32"
                  ? [
                      "-NoProfile",
                      "-NonInteractive",
                      "-ExecutionPolicy",
                      "Bypass",
                      "-Command",
                      `$ErrorActionPreference = 'Stop'; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $PSDefaultParameterValues['Invoke-WebRequest:UseBasicParsing'] = $true; & '${script.replaceAll("'", "''")}'`,
                    ]
                  : [script],
              timeout: "10 minutes",
              maxOutputBytes: 64 * 1024,
              outputMode: "truncate",
            });
            if (result.code !== 0)
              return yield* failure(
                instanceId,
                "Setup could not finish. Check your internet connection and available disk space, then try again.",
              );
          }
        }
      }
      yield* SubscriptionRef.update(
        state,
        (value) =>
          ({
            ...value,
            phase: "verifying",
            message: "Checking the installation.",
          }) satisfies ProviderInstallState,
      );
      version = yield* verify(binary);
      if (!version)
        return yield* failure(instanceId, "The installation could not start. Try setup again.");
      // Read again so a settings edit made during a download is never overwritten.
      const latest = yield* settings.getSettings;
      const latestEntry = deriveProviderInstanceConfigMap(latest)[instanceId];
      if (!latestEntry || latestEntry.driver !== driver)
        return yield* failure(instanceId, "This AI service was removed during setup.");
      const latestConfig =
        typeof latestEntry.config === "object" && latestEntry.config !== null
          ? latestEntry.config
          : {};
      if (
        "binaryPath" in latestConfig &&
        latestConfig.binaryPath !== ("binaryPath" in config ? config.binaryPath : undefined)
      ) {
        return yield* failure(
          instanceId,
          "The installation choice changed during setup. Try again with your new settings.",
        );
      }
      // Save the absolute launcher: desktop processes do not inherit a shell's updated PATH.
      yield* settings.updateSettings({
        providerInstances: {
          ...latest.providerInstances,
          [instanceId]: {
            ...latestEntry,
            enabled: true,
            config: {
              ...latestConfig,
              enabled: true,
              binaryPath: driver === "opencode" ? "opencode" : binary,
            },
          },
        },
      });
      yield* SubscriptionRef.update(
        state,
        (value) =>
          ({
            ...value,
            phase: "succeeded",
            installedVersion: version,
            executablePath: binary,
            message: "Installed. Checking account and available models.",
          }) satisfies ProviderInstallState,
      );
    },
    Effect.scoped,
    Effect.timeout("15 minutes"),
  );

  const start = Effect.fn("ProviderCliInstallation.start")(
    function* (instanceId: ProviderInstanceId, driver: ProviderDriverKind) {
      if (!supportsCliInstallation(driver))
        return yield* failure(instanceId, "Automatic setup is not available for this AI service.");
      const state = yield* stateFor(instanceId, driver);
      const current = yield* SubscriptionRef.get(state);
      if (
        running.has(instanceId) &&
        ["downloading", "extracting", "verifying"].includes(current.phase)
      )
        return current;
      const operationId = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(() => failure(instanceId, "Could not start setup. Try again.")),
      );
      const next: ProviderInstallState = {
        ...current,
        operationId,
        phase: "downloading",
        message: "Installing. This may take a few minutes.",
      };
      yield* SubscriptionRef.set(state, next);
      const work = gate.withPermit(install(instanceId, driver, state)).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? SubscriptionRef.update(state, (value) => {
                const error = Cause.findErrorOption(exit.cause);
                const cancelled = Cause.hasInterruptsOnly(exit.cause);
                return {
                  ...value,
                  phase: cancelled ? "cancelled" : "failed",
                  message: cancelled
                    ? "Setup cancelled. You can try again."
                    : Option.isSome(error) && isSetupError(error.value)
                      ? error.value.detail
                      : "Setup could not finish. Check your internet connection and try again.",
                } satisfies ProviderInstallState;
              })
            : Effect.void,
        ),
        Effect.ignoreCause,
        Effect.ensuring(
          Effect.sync(() => {
            if (running.get(instanceId)?.operationId === operationId) running.delete(instanceId);
          }),
        ),
      );
      const fiber = yield* Effect.forkIn(Effect.interruptible(work), scope);
      running.set(instanceId, { operationId, fiber });
      return next;
    },
    requestGate.withPermit,
    Effect.uninterruptible,
  );
  const cancel = Effect.fn("ProviderCliInstallation.cancel")(function* (
    instanceId: ProviderInstanceId,
    operationId: string,
  ) {
    const active = running.get(instanceId);
    const state = states.get(instanceId);
    if (!state || (yield* SubscriptionRef.get(state)).operationId !== operationId)
      return yield* failure(
        instanceId,
        "This setup is no longer current. Refresh its status before cancelling.",
      );
    if (active?.operationId === operationId) yield* Fiber.interrupt(active.fiber);
    return yield* SubscriptionRef.get(state);
  });
  return {
    start,
    cancel,
    changes: (instanceId: ProviderInstanceId, driver: ProviderDriverKind) =>
      Stream.unwrap(stateFor(instanceId, driver).pipe(Effect.map(SubscriptionRef.changes))),
  };
});
