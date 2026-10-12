import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { DesktopEnvironment } from "../app/DesktopEnvironment.ts";
import { ElectronSafeStorage } from "../electron/ElectronSafeStorage.ts";

class GmailKeyError extends Schema.TaggedError<GmailKeyError>()("GmailKeyError", {
  message: Schema.String,
}) {}

/** The server gets a per-install key; only its OS-encrypted form is persisted. */
export const resolveGmailEncryptionKey = Effect.gen(function* () {
  const storage = yield* Effect.serviceOption(ElectronSafeStorage);
  if (Option.isNone(storage)) return undefined;
  if (!(yield* storage.value.isEncryptionAvailable)) return undefined;
  const backend = yield* storage.value.selectedStorageBackend;
  if (Option.isSome(backend) && ["basic_text", "unknown"].includes(backend.value)) return undefined;
  const environment = yield* DesktopEnvironment;
  if (environment.platform === "linux" && Option.isNone(backend)) return undefined;
  const files = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const target = environment.path.join(environment.stateDir, "gmail-encryption-key.bin");
  const keyPattern = /^[A-Za-z0-9+/]{43}=$/;
  if (yield* files.exists(target)) {
    const encrypted = yield* files.readFile(target);
    const key = yield* storage.value.decryptString(encrypted);
    if (!keyPattern.test(key))
      return yield* new GmailKeyError({ message: "Invalid Gmail encryption key." });
    return key;
  }
  const key = Base64.encode(yield* crypto.randomBytes(32));
  const encrypted = yield* storage.value.encryptString(key);
  yield* files.makeDirectory(environment.stateDir, { recursive: true });
  // Exclusive creation prevents another app instance from replacing the key.
  yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* files.open(target, { flag: "wx", mode: 0o600 });
      yield* file.writeAll(encrypted);
      yield* file.sync;
    }),
  );
  return key;
}).pipe(
  Effect.catch(() =>
    Effect.logWarning("Secure Gmail storage is unavailable; Gmail sign-in is disabled.").pipe(
      Effect.as(undefined),
    ),
  ),
);
