import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'

// Source snapshots can contain private customer identities. They have the same
// key lifecycle as the encrypted customer register, with a distinct KDF salt.
let cached: { secret: string; key: Buffer } | undefined
function key(): Buffer {
  const secret = process.env.PERSONNUMMER_ENCRYPTION_KEY
  if (!secret) throw new Error('PERSONNUMMER_ENCRYPTION_NOT_CONFIGURED')
  if (cached?.secret !== secret) cached = { secret, key: scryptSync(secret, 'accounted-provider-migration-v1', 32) }
  return cached.key
}

export function sealMigrationPayload(value: unknown): { payload: string; payload_hash: string } {
  const plaintext = JSON.stringify(value)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    payload: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64'),
    payload_hash: createHash('sha256').update(plaintext).digest('hex'),
  }
}

export function openMigrationPayload<T>(payload: string): T {
  const bytes = Buffer.from(payload, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12))
  decipher.setAuthTag(bytes.subarray(12, 28))
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')) as T
}
