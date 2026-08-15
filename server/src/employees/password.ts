import bcrypt from "bcrypt";

/** Minimum password length enforced at registration (G4.S7.T6). */
export const MIN_PASSWORD_LENGTH = 8;

/** bcrypt cost factor — slow enough to resist brute force, fast enough for login. */
export const BCRYPT_ROUNDS = 10;

/** Hash a plaintext password into a bcrypt hash. Never store plaintext. */
export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/** Constant-time compare of a plaintext password against a stored bcrypt hash. */
export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
