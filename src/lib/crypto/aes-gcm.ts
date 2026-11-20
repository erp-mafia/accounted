/**
 * AES-256-GCM sealing in the one layout every stored secret already uses:
 * a 12-byte IV, the 16-byte tag, then the ciphertext. Each caller keeps its
 * own key, encoding, prefix and AAD, so every value stored today opens
 * unchanged (aes-gcm.test.ts decrypts fixtures sealed by the code this
 * replaced).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

/** A 32-byte key from text key material: SHA-256 of it, as every caller derives. */
export function sha256Key(material: string): Buffer {
  return createHash('sha256').update(material).digest()
}

/** iv | tag | ciphertext. `aad`, when given, must be given again to open. */
export function sealAesGcm(key: Buffer, plaintext: string, aad?: string): Buffer {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad))
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
}

/** Opens what sealAesGcm sealed; throws when the key, tag or AAD do not match. */
export function openAesGcm(key: Buffer, sealed: Buffer, aad?: string): string {
  const decipher = createDecipheriv(ALGORITHM, key, sealed.subarray(0, IV_BYTES))
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad))
  decipher.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
  return Buffer.concat([decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8')
}
