import { createHash, scryptSync } from 'node:crypto'
import { openAesGcm, sealAesGcm } from '@/lib/crypto/aes-gcm'

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
  return {
    payload: sealAesGcm(key(), plaintext).toString('base64'),
    payload_hash: createHash('sha256').update(plaintext).digest('hex'),
  }
}

export function openMigrationPayload<T>(payload: string): T {
  return JSON.parse(openAesGcm(key(), Buffer.from(payload, 'base64'))) as T
}
