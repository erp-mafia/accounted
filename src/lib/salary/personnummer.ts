import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import { createLogger } from '@/lib/logger'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const TAG_LENGTH = 16

const logger = createLogger('salary/personnummer')

/**
 * Registry code (lib/errors/structured-errors.ts) for a production deployment,
 * or a local run against a hosted Supabase, that never set
 * PERSONNUMMER_ENCRYPTION_KEY. Carried on the thrown Error so
 * withRouteContext -> errorResponse() answers with the typed 503 envelope
 * ("krypteringsnyckel saknas, kontakta supporten") instead of the generic
 * INTERNAL_ERROR 500, which reads as a transient failure and invites retries
 * that can never succeed. #1996
 */
export const PERSONNUMMER_ENCRYPTION_NOT_CONFIGURED = 'PERSONNUMMER_ENCRYPTION_NOT_CONFIGURED'

/** Hosts a local Supabase stack answers on (`supabase start`). */
const LOCAL_SUPABASE_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * The dev key is public (it is right below), so a value sealed with it in a
 * shared database can never be opened by the real key. It may be used only
 * where nothing it seals can reach one: under the test runner, or outside
 * production against a local Supabase. Not on NODE_ENV alone: `npm run dev`
 * or a script pointed at a hosted project is not production either.
 * accounted#5
 */
function devKeyAllowed(): boolean {
  if (process.env.NODE_ENV === 'production') return false
  if (process.env.VITEST) return true
  try {
    return LOCAL_SUPABASE_HOSTS.has(new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').hostname)
  } catch {
    return false
  }
}

/**
 * scrypt is slow on purpose (about 50 ms a derivation in production), and
 * every encrypt and decrypt used to derive the same key again:
 * gnubok_list_customers spent 145 s on a register with 2 149 sealed
 * personnummer, with the event loop blocked throughout (crm#2151). The key is
 * derived once per secret and salt, as lib/providers/consent-tokens.ts and
 * migration-payload.ts already do; a changed secret is derived anew.
 */
let derived: { secret: string; salt: string; key: Buffer } | undefined
function deriveKey(secret: string, salt: string): Buffer {
  if (derived?.secret !== secret || derived.salt !== salt) {
    derived = { secret, salt, key: scryptSync(secret, salt, 32) }
  }
  return derived.key
}

/** The key from the environment, or the dev key where devKeyAllowed(). */
function getEncryptionKey(): Buffer {
  const envKey = process.env.PERSONNUMMER_ENCRYPTION_KEY
  if (envKey) return deriveKey(envKey, 'gnubok-pnr-salt')
  if (devKeyAllowed()) return deriveKey('dev-only-key', 'gnubok-dev-salt')
  throw Object.assign(
    new Error(
      process.env.NODE_ENV === 'production'
        ? 'PERSONNUMMER_ENCRYPTION_KEY is required in production'
        : 'PERSONNUMMER_ENCRYPTION_KEY is required unless NEXT_PUBLIC_SUPABASE_URL is a local Supabase ' +
            '(localhost): the dev key is public and the real key can never open what it seals',
    ),
    { code: PERSONNUMMER_ENCRYPTION_NOT_CONFIGURED },
  )
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
