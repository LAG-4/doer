import { describe, expect, it } from "vite-plus/test";
import {
  decryptTokens,
  encryptTokens,
  isEncryptedTokenFile,
  readEncryptionKey,
} from "./tokenEncryption.ts";

describe("Gmail token encryption", () => {
  const key = Buffer.alloc(32, 7);
  it("stores no plaintext and authenticates ciphertext with a fresh nonce", () => {
    const first = encryptTokens("private-refresh-token", key);
    const second = encryptTokens("private-refresh-token", key);
    expect(Buffer.from(first).includes(Buffer.from("private-refresh-token"))).toBe(false);
    expect(first).not.toEqual(second);
    expect(isEncryptedTokenFile(first)).toBe(true);
    expect(decryptTokens(first, key)).toBe("private-refresh-token");
    const tampered = Uint8Array.from(first);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    expect(() => decryptTokens(tampered, key)).toThrow();
    expect(() => decryptTokens(first, Buffer.alloc(32, 8))).toThrow();
  });
  it("does not accept plaintext or malformed keys", () => {
    expect(() => decryptTokens(Buffer.from("{}"), key)).toThrow();
    expect(readEncryptionKey(undefined)).toBeNull();
    expect(readEncryptionKey("abc")).toBeNull();
    expect(readEncryptionKey(key.toString("base64"))).toEqual(key);
  });
});
