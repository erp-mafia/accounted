/**
 * TOTP (RFC 6238) for the E2E suite.
 *
 * Hosted enforces MFA, so enrolling and verifying a TOTP factor is part of the
 * path a real user walks. Rather than switching MFA off for the tests, the
 * suite reads the secret off the enrolment screen and computes codes here, the
 * way an authenticator app would.
 *
 * Verified against all five RFC 6238 SHA-1 test vectors in
 * tests/e2e/__tests__/totp.test.ts.
 */
import * as crypto from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Decode an RFC 4648 base32 string (padding optional) into bytes. */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, "").replace(/\s/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const char of clean) {
    const idx = B32.indexOf(char);
    if (idx === -1) throw new Error(`invalid base32 character: ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export interface TotpOptions {
  /** Period in seconds. */
  step?: number;
  /** Code length. */
  digits?: number;
  /** Evaluate at this instant instead of now. */
  atMs?: number;
  /** Step offset, e.g. -1 for the previous window. */
  offset?: number;
}

/** Current TOTP code for a base32 secret. */
export function totp(secret: string, opts: TotpOptions = {}): string {
  const { step = 30, digits = 6, atMs = Date.now(), offset = 0 } = opts;
  const counter = Math.floor(atMs / 1000 / step) + offset;

  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac("sha1", base32Decode(secret)).update(buf).digest();

  // Dynamic truncation, RFC 4226 section 5.4.
  const idx = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[idx] & 0x7f) << 24) |
    ((hmac[idx + 1] & 0xff) << 16) |
    ((hmac[idx + 2] & 0xff) << 8) |
    (hmac[idx + 3] & 0xff);

  return String(bin % 10 ** digits).padStart(digits, "0");
}

/**
 * A code guaranteed to differ from one just used. Supabase rejects a replayed
 * code inside the same step, which is what a test does when it verifies twice
 * in quick succession.
 */
export function nextDistinctTotp(secret: string, previous: string): string {
  const now = totp(secret);
  return now === previous ? totp(secret, { offset: 1 }) : now;
}
