import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** AES-256-GCM secret encryption/decryption (G3.S2.T2). */
export interface SecretCipher {
  /** Encrypt a plaintext secret into a self-contained `v1:iv:tag:data` payload. */
  encrypt(plaintext: string): string;
  /** Decrypt a `v1:` payload back to the plaintext. Throws on tamper/wrong key. */
  decrypt(payload: string): string;
}

const PREFIX = "v1";

/**
 * Dev-only fallback AES-256 key (64 hex chars) so local runs work without
 * `ENCRYPTION_KEY` (used by defaultSecretCipher in app.ts and the worker
 * plugin's auto-sync credential resolution).
 */
export const DEV_ONLY_ENCRYPTION_KEY =
  "d3d1e5d0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6";

/** The active SecretCipher: `ENCRYPTION_KEY` env, else the dev-only fallback key. */
export function defaultSecretCipher(): SecretCipher {
  const key = process.env.ENCRYPTION_KEY ?? DEV_ONLY_ENCRYPTION_KEY;
  return createSecretCipher(key);
}

/**
 * Build a SecretCipher from a 32-byte hex key. Prefer `ENCRYPTION_KEY` in
 * production; a dev-only fallback key keeps local runs working like the
 * ConsoleMailer/memory stores do for the rest of the auth stack.
 */
export function createSecretCipher(keyHex: string): SecretCipher {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) {
    throw new Error(`encryption key must be 32 bytes (64 hex chars), got ${key.length} bytes`);
  }
  return {
    encrypt(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [PREFIX, iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(":");
    },
    decrypt(payload) {
      const [prefix, ivB64, tagB64, dataB64] = payload.split(":");
      if (prefix !== PREFIX || !ivB64 || !tagB64 || !dataB64) {
        throw new Error("invalid encrypted payload");
      }
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
      decipher.setAuthTag(Buffer.from(tagB64, "base64"));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(dataB64, "base64")),
        decipher.final(),
      ]);
      return decrypted.toString("utf8");
    },
  };
}
