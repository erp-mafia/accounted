import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import { createLogger } from '@/lib/logger'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const TAG_LENGTH = 16

const logger = createLogger('salary/personnummer')

/**
 * Get the encryption key from environment.
 * Falls back to a dev-only key for local development.
 */
function getEncryptionKey(): Buffer {
  const envKey = process.env.PERSONNUMMER_ENCRYPTION_KEY
  if (!envKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('PERSONNUMMER_ENCRYPTION_KEY is required in production')
    }
    // Dev-only deterministic key (NOT safe for production)
    return scryptSync('dev-only-key', 'gnubok-dev-salt', 32)
  }
  // Use scrypt to derive a 32-byte key from the env var
  return scryptSync(envKey, 'gnubok-pnr-salt', 32)
}

/**
 * Encrypt a personnummer for storage.
 * Returns a hex string: iv + ciphertext + authTag
 */
export function encryptPersonnummer(personnummer: string): string {
  const key = getEncryptionKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)

  let encrypted = cipher.update(personnummer, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  const authTag = cipher.getAuthTag()

  return iv.toString('hex') + encrypted + authTag.toString('hex')
}

/**
 * Decrypt a personnummer from storage.
 */
export function decryptPersonnummer(encrypted: string): string {
  // Tolerate legacy/unencrypted rows. A raw 12-digit personnummer (written by
  // a path that skipped encryptPersonnummer, e.g. the v1 REST create route
  // before this fix, or a seed) would otherwise be sliced as iv/ciphertext/tag
  // and throw ERR_CRYPTO_INVALID_AUTH_TAG ("Invalid authentication tag length:
  // 6"), 500-ing every decrypt-on-read path (roster, salary runs, payslips,
  // KU, AGI, MCP). Real ciphertext is 80 hex chars, so a 12-digit match is
  // unambiguously plaintext. Return it as-is and warn so the backfill can find
  // and re-encrypt it. Value is never logged. See DECISIONS.md.
  if (/^\d{12}$/.test(encrypted)) {
    logger.warn('decryptPersonnummer received an unencrypted personnummer; returning as-is (row needs backfill)')
    return encrypted
  }

  const key = getEncryptionKey()
  const ivHex = encrypted.slice(0, IV_LENGTH * 2)
  const authTagHex = encrypted.slice(-TAG_LENGTH * 2)
  const ciphertext = encrypted.slice(IV_LENGTH * 2, -TAG_LENGTH * 2)

  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}

// Pure parsing, validation and formatting helpers live in ./personnummer-format
// (no Node imports) so client components (via lib/salary/tax-column.ts) can
// use them without pulling this module's `crypto` import into the bundle.
export {
  calculateAge,
  calculateAgeAtYearStart,
  expandPersonnummerTo12,
  extractBirthDate,
  extractLast4,
  formatPersonnummer,
  maskPersonnummer,
  validatePersonnummer,
} from './personnummer-format'
import { maskPersonnummer } from './personnummer-format'

/**
 * Shape a raw `employees` row (or an embedded employee object) for a JSON
 * response: drop every personnummer-derived column and expose the display
 * form under `personnummer_masked`.
 *
 * Two columns must go, not one:
 *   - `personnummer` (the AES-256-GCM ciphertext), and
 *   - `personnummer_last4`: the mask is 'YYYYMMDD-XXXX', so a response that
 *     carries the mask AND the last four digits hands the client the full
 *     personnummer by simple concatenation, defeating the mask entirely.
 *     No UI reads employees.personnummer_last4; it exists for the DB-side
 *     uniqueness constraint and Skatteverket-bound documents (payslips, AGI,
 *     KU), which render server-side.
 *
 * The mask goes out under `personnummer_masked`, never under the writable
 * `personnummer` key: these payloads feed edit forms, and a mask returned
 * under the write key could be posted straight back into the encrypt path.
 * v1, the MCP tools and lib/salary/employee-commands.ts use the `_masked`
 * suffix for the same reason.
 */
export function maskEmployeeForResponse(
  employee: Record<string, unknown>
): Record<string, unknown> {
  const { personnummer, personnummer_last4: _last4, ...rest } = employee
  return {
    ...rest,
    personnummer_masked: maskPersonnummer(decryptPersonnummer(personnummer as string)),
  }
}
