/**
 * Phone-number PII primitives for the WhatsApp channel.
 *
 * Three representations, three purposes:
 *   - hashPhone:    HMAC-SHA256 with a server-side pepper (WHATSAPP_PHONE_HASH_KEY).
 *                   The DB lookup key. A plain sha256 would be brute-forceable
 *                   over the ~10^9 phone-number space, hence the pepper.
 *   - encryptPhone: AES-256-GCM (WHATSAPP_PHONE_ENCRYPTION_KEY), mirrors the
 *                   lib/auth/bankid.ts codec (iv 12 | tag 16 | ciphertext) but
 *                   with its own key: self-hosters without BankID must be able
 *                   to run this channel. Stored hex-encoded in a text column.
 *   - maskPhone:    display-only shape for the settings panel.
 *
 * Keys are deliberately NOT shared with the BankID key material.
 */

import crypto from 'crypto'

const ALGORITHM = 'aes-256-gcm'

/** Meta sends wa_id / from as E.164 digits without '+'. Normalize to digits only. */
export function normalizePhone(raw: string): string {
  return String(raw ?? '').replace(/\D/g, '')
}

function getHashKey(): Buffer {
  const key = process.env.WHATSAPP_PHONE_HASH_KEY
  if (!key) throw new Error('WHATSAPP_PHONE_HASH_KEY is required for WhatsApp operations')
  return Buffer.from(key, 'utf8')
}

function getEncryptionKey(): Buffer {
  const key = process.env.WHATSAPP_PHONE_ENCRYPTION_KEY
  if (!key) throw new Error('WHATSAPP_PHONE_ENCRYPTION_KEY is required for WhatsApp operations')
  return Buffer.from(key, 'hex')
}

/** Peppered lookup hash (hex). Input is normalized first so '+46 70...' and '4670...' collide. */
export function hashPhone(rawPhone: string): string {
  return crypto.createHmac('sha256', getHashKey()).update(normalizePhone(rawPhone)).digest('hex')
}

/**
 * Peppered hash for any other low-entropy secret stored in this channel
 * (link codes: 30^6 values, a smaller space than the phone numbers the
 * pepper exists for). Same key, same reason: a plain sha256 over a space
 * that small is enumerable offline in seconds, so hashing at rest would
 * protect nothing.
 */
export function hashSecret(value: string): string {
  return crypto.createHmac('sha256', getHashKey()).update(value).digest('hex')
}

/** AES-256-GCM encrypt a phone number. Returns hex(iv | tag | ciphertext) for a text column. */
export function encryptPhone(rawPhone: string): string {
  const key = getEncryptionKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(normalizePhone(rawPhone), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('hex')
}

/** Decrypt a stored hex(iv | tag | ciphertext) value back to the digit string. */
export function decryptPhone(stored: string): string {
  const key = getEncryptionKey()
  const raw = Buffer.from(stored, 'hex')
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(12, 28)
  const encrypted = raw.subarray(28)
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

/**
 * Mask for display: '+46 70 *** ** 67'. Keeps country code + two leading
 * digits + two trailing digits; everything in between is starred. Works for
 * any E.164 length; very short inputs degrade to a fully starred value.
 */
export function maskPhone(rawPhone: string): string {
  const digits = normalizePhone(rawPhone)
  if (digits.length < 8) return '+** *** ** **'
  const cc = digits.slice(0, 2)
  const lead = digits.slice(2, 4)
  const tail = digits.slice(-2)
  return `+${cc} ${lead} *** ** ${tail}`
}
