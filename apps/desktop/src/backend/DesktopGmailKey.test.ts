import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { DesktopEnvironment, layer as environmentLayer } from "../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import { ElectronSafeStorage } from "../electron/ElectronSafeStorage.ts";
import { resolveGmailEncryptionKey } from "./DesktopGmailKey.ts";

const testEnvironment = (directory: string, platform: NodeJS.Platform) =>
  environmentLayer({
    dirname: directory,
    homeDirectory: directory,
    platform,
    processArch: "x64",
    appVersion: "1.0.0",
    appPath: directory,
    isPackaged: true,
    resourcesPath: directory,
    runningUnderArm64Translation: false,
  }).pipe(Layer.provide(DesktopConfig.layerTest({ T3CODE_HOME: directory })));

it.effect("persists only OS-protected bytes and reuses the per-install key", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const files = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* files.makeTempDirectoryScoped({ prefix: "doer-key-test-" });
      let encryptionCalls = 0;
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const dependencies = Layer.mergeAll(
        testEnvironment(directory, "win32"),
        Layer.mock(ElectronSafeStorage)({
          isEncryptionAvailable: Effect.succeed(true),
          selectedStorageBackend: Effect.succeed(Option.none()),
          encryptString: (key) =>
            Effect.sync(() => {
              encryptionCalls++;
              return encoder.encode(`os-protected:${key.split("").toReversed().join("")}`);
            }),
          decryptString: (bytes) =>
            Effect.succeed(
              decoder.decode(bytes).slice("os-protected:".length).split("").toReversed().join(""),
            ),
        }),
      );
      const key = yield* resolveGmailEncryptionKey.pipe(Effect.provide(dependencies));
      const environment = yield* DesktopEnvironment.pipe(Effect.provide(dependencies));
      expect(key).toMatch(/^[A-Za-z0-9+/]{43}=$/);
      const persisted = yield* files.readFileString(
        path.join(environment.stateDir, "gmail-encryption-key.bin"),
      );
      expect(persisted).not.toContain(key);
      expect(yield* resolveGmailEncryptionKey.pipe(Effect.provide(dependencies))).toBe(key);
      expect(encryptionCalls).toBe(1);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("disables Gmail when OS storage is unavailable or Linux uses plaintext fallback", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const files = yield* FileSystem.FileSystem;
      const directory = yield* files.makeTempDirectoryScoped({
        prefix: "doer-key-unavailable-test-",
      });
      for (const [available, backend] of [
        [false, "gnome_libsecret"],
        [true, "basic_text"],
        [true, "unknown"],
      ] as const) {
        expect(
          yield* resolveGmailEncryptionKey.pipe(
            Effect.provideService(ElectronSafeStorage, {
              isEncryptionAvailable: Effect.succeed(available),
              selectedStorageBackend: Effect.succeed(Option.some(backend)),
              encryptString: () => Effect.die("Must not encrypt with unsafe storage"),
              decryptString: () => Effect.die("Must not decrypt with unsafe storage"),
            }),
            Effect.provide(testEnvironment(directory, "linux")),
          ),
        ).toBeUndefined();
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
