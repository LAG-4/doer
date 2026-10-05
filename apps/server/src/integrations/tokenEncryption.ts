// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

const PREFIX = Buffer.from("doer-gmail-v1\0");

/** The desktop supplies a key protected by the OS keyring; CLI hosts must provision one. */
export function readEncryptionKey(value: string | undefined): Buffer | null {
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return null;
  const key = Buffer.from(value, "base64");
  return key.length === 32 ? key : null;
}

export function encryptTokens(plaintext: string, key: Uint8Array): Uint8Array {
  const nonce = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(PREFIX);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([PREFIX, nonce, cipher.getAuthTag(), ciphertext]);
}

export function decryptTokens(bytes: Uint8Array, key: Uint8Array): string {
  const stored = Buffer.from(bytes);
  if (!stored.subarray(0, PREFIX.length).equals(PREFIX)) {
    throw new Error("Gmail credentials need a secure migration.");
  }
  const offset = PREFIX.length;
  const decipher = NodeCrypto.createDecipheriv(
    "aes-256-gcm",
    key,
    stored.subarray(offset, offset + 12),
  );
  decipher.setAAD(PREFIX);
  decipher.setAuthTag(stored.subarray(offset + 12, offset + 28));
  return Buffer.concat([decipher.update(stored.subarray(offset + 28)), decipher.final()]).toString(
    "utf8",
  );
}

export function isEncryptedTokenFile(bytes: Uint8Array): boolean {
  return Buffer.from(bytes).subarray(0, PREFIX.length).equals(PREFIX);
}
