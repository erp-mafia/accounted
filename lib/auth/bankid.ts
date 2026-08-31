/**
 * BankID authentication helpers.
 *
 * BankID is only available on the hosted deployment (requires TIC Identity API).
 * Self-hosted deployments never show the BankID option.
 */

import crypto from 'crypto'

const ALGORITHM = 'aes-256-gcm'

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

// isBankIdEnabled lives in ./bankid-flags (no Node imports) so the login,
// register and security-settings client components can read the flag
// without pulling this module's `crypto` import, and with it the browser
// crypto polyfill, into their bundles. Re-exported here for server callers.
export { isBankIdEnabled } from './bankid-flags'

// ---------------------------------------------------------------------------
// Personnummer hashing (for lookup)
// ---------------------------------------------------------------------------

/** SHA-256 hash of a personnummer for fast DB lookup. */
export function hashPersonalNumber(personalNumber: string): string {
  return crypto.createHash('sha256').update(personalNumber).digest('hex')
}

// ---------------------------------------------------------------------------
// Personnummer encryption (for display in settings)
// ---------------------------------------------------------------------------

function getEncryptionKey(): Buffer {
  const key = process.env.BANKID_ENCRYPTION_KEY
  if (!key) throw new Error('BANKID_ENCRYPTION_KEY is required for BankID operations')
  return Buffer.from(key, 'hex')
}

/** AES-256-GCM encrypt a personnummer for storage. */
export function encryptPersonalNumber(personalNumber: string): Buffer {
  const key = getEncryptionKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)

  const encrypted = Buffer.concat([cipher.update(personalNumber, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  // Format: iv (12) + tag (16) + ciphertext
  return Buffer.concat([iv, tag, encrypted])
}

/** AES-256-GCM decrypt a stored personnummer. */
export function decryptPersonalNumber(data: Buffer): string {
  const key = getEncryptionKey()

  const iv = data.subarray(0, 12)
  const tag = data.subarray(12, 28)
  const encrypted = data.subarray(28)

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

// ---------------------------------------------------------------------------
// Storage codec (bankid_identities.personal_number_enc)
// ---------------------------------------------------------------------------

/**
 * Encrypt a personnummer and encode it for a PostgREST bytea insert.
 *
 * Passing a raw Buffer to supabase-js serializes it as JSON
 * ('{"type":"Buffer","data":[...]}'), storing that literal text in the
 * column instead of the bytes. PostgREST's bytea input format is a
 * '\x'-prefixed hex string, which is what this returns.
 */
export function encryptPersonalNumberForStorage(personalNumber: string): string {
  return '\\x' + encryptPersonalNumber(personalNumber).toString('hex')
}

/** Legacy shape written by supabase-js Buffer serialization before 2026-07. */
type SerializedBuffer = { type: 'Buffer'; data: number[] }

function isSerializedBuffer(value: unknown): value is SerializedBuffer {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as SerializedBuffer).type === 'Buffer' &&
    Array.isArray((value as SerializedBuffer).data)
  )
}

/**
 * Decode and decrypt a personal_number_enc value as read back through
 * PostgREST (a '\x'-prefixed hex string) or a raw Buffer.
 *
 * Tolerates rows written before migration 20260727170000, where the column
 * holds the UTF-8 text of a JSON-serialized Buffer rather than the raw
 * iv|tag|ciphertext bytes.
 */
export function decryptStoredPersonalNumber(stored: string | Buffer | SerializedBuffer): string {
  let raw: Buffer
  if (Buffer.isBuffer(stored)) {
    raw = stored
  } else if (typeof stored === 'string') {
    raw = stored.startsWith('\\x')
      ? Buffer.from(stored.slice(2), 'hex')
      : Buffer.from(stored, 'utf8')
  } else if (isSerializedBuffer(stored)) {
    raw = Buffer.from(stored.data)
  } else {
    throw new Error('Unsupported personal_number_enc value')
  }

  // Legacy JSON-serialized Buffer stored as text: unwrap to the real bytes.
  if (raw[0] === 0x7b) {
    try {
      const parsed: unknown = JSON.parse(raw.toString('utf8'))
      if (isSerializedBuffer(parsed)) raw = Buffer.from(parsed.data)
    } catch {
      // Not JSON after all: treat as raw ciphertext.
    }
  }

  return decryptPersonalNumber(raw)
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Mask a personnummer for display: "XXXXXXXX-1234" */
export function maskPersonalNumber(personalNumber: string): string {
  if (personalNumber.length < 4) return '****'
  const last4 = personalNumber.slice(-4)
  const masked = personalNumber.length === 12 ? 'XXXXXXXX' : 'XXXXXX'
  return `${masked}-${last4}`
}
