// @effect-diagnostics nodeBuiltinImport:off
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ExperimentalConnectionsStatus } from "@t3tools/shared/experimentalConnections";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";

const SETTINGS_FILENAME = "experimental-connections.json";

export class ExperimentalConnectionsStoreError extends Schema.TaggedError<ExperimentalConnectionsStoreError>()(
  "ExperimentalConnectionsStoreError",
  { message: Schema.String },
) {}

/**
 * ExperimentalConnections - Host-scoped master switch for Google, Microsoft,
 * and local Office plugin connections.
 *
 * Off by default for new and existing installations. Persisted as a tiny JSON
 * file next to `settings.json`, so the value survives restarts and is shared
 * by web, desktop, and paired clients of this computer. Credentials are
 * preserved while the switch is off: gating denies new connect/auth/tool
 * calls, never deletes tokens.
 *
 * Durability contract: writes serialize, the file is persisted before the
 * in-memory value commits, and a storage failure is reported to the caller
 * (the Settings toggle shows an error, never a false success). On failure
 * the in-memory value fails closed to off.
 *
 * Transports stay thin: HTTP routes and MCP handlers consult this service and
 * deny with plain-language guidance. Disconnect/revoke paths never consult
 * it, so they stay available while the switch is off.
 *
 * @module ExperimentalConnections
 */
export class ExperimentalConnections extends Context.Service<
  ExperimentalConnections,
  {
    readonly get: Effect.Effect<boolean>;
    readonly setEnabled: (
      enabled: boolean,
    ) => Effect.Effect<void, ExperimentalConnectionsStoreError>;
  }
>()("@lag4/doer-cli/integrations/ExperimentalConnections") {}

const StatusJson = Schema.fromJsonString(ExperimentalConnectionsStatus);
const decodeStatus = Schema.decodeOption(StatusJson);
const encodeStatus = Schema.encodeEffect(StatusJson);

const readEnabled = (raw: string): boolean => {
  const decoded = decodeStatus(raw);
  return Option.isSome(decoded) ? decoded.value.enabled : false;
};

const SAVE_FAILED_MESSAGE =
  "Could not save the experimental-connections setting. Check disk access and try again.";

export const layer = Layer.effect(
  ExperimentalConnections,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = path.join(path.dirname(config.settingsPath), SETTINGS_FILENAME);
    const initial = yield* fs.exists(filePath).pipe(
      Effect.flatMap((exists) => (exists ? fs.readFileString(filePath) : Effect.succeed(""))),
      Effect.map((raw) => (raw === "" ? false : readEnabled(raw))),
      Effect.tapError((cause) =>
        Effect.logWarning("Could not read experimental-connections setting; defaulting to off.", {
          cause,
        }),
      ),
      Effect.orElseSucceed(() => false),
    );
    const current = yield* Ref.make(initial);
    // Serializes concurrent toggles so rapid on/off writes cannot reorder.
    const writeLock = yield* Semaphore.make(1);
    return ExperimentalConnections.of({
      get: Ref.get(current),
      setEnabled: (enabled) =>
        writeLock.withPermits(1)(
          Effect.gen(function* () {
            // The service methods run long after the layer builds, with only
            // this service in context. Provide the captured filesystem
            // dependencies here so callers stay dependency-free.
            const contents = yield* encodeStatus({ enabled }).pipe(
              Effect.mapError(
                () => new ExperimentalConnectionsStoreError({ message: SAVE_FAILED_MESSAGE }),
              ),
            );
            const saved = yield* writeFileStringAtomically({ filePath, contents }).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.result,
            );
            if (saved._tag === "Failure") {
              // Fail closed: never leave the switch enabled in memory when
              // the durable record disagrees, and never claim success.
              yield* Ref.set(current, false);
              yield* Effect.logWarning("Could not save experimental-connections setting.", {
                cause: saved.failure,
              });
              return yield* new ExperimentalConnectionsStoreError({
                message: SAVE_FAILED_MESSAGE,
              });
            }
            yield* Ref.set(current, enabled);
          }),
        ),
    });
  }),
);

/**
 * True when the experimental-connections master switch is on. Never throws:
 * an unreadable file already defaults the service to off, and a missing
 * service (unit tests composing without the layer) reads as off. Denying is
 * the safe direction — an explicit "off" must never silently become "on".
 */
export const isEnabled: Effect.Effect<boolean> = Effect.gen(function* () {
  const maybe = yield* Effect.serviceOption(ExperimentalConnections);
  if (Option.isNone(maybe)) return false;
  return yield* maybe.value.get.pipe(Effect.orElseSucceed(() => false));
});

/** In-memory instance for unit tests: no filesystem, explicit starting value. */
export const layerTest = (enabled: boolean) =>
  Layer.effect(
    ExperimentalConnections,
    Effect.gen(function* () {
      const current = yield* Ref.make(enabled);
      return ExperimentalConnections.of({
        get: Ref.get(current),
        setEnabled: (next) => Ref.set(current, next),
      });
    }),
  );
