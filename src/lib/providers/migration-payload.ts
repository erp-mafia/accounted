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

/** Business content only: provider object-key order and fetch timestamps are not changes. */
export function migrationSourceHash(value: unknown): string {
  const dto = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const { _raw, createdAt: _created, updatedAt: _updated, ...business } = dto
  const raw = _raw && typeof _raw === 'object' ? _raw as Record<string, unknown> : {}
  const references = Object.fromEntries(['customerRef','supplierRef','journalEntryRef','CustomerNumber','SupplierNumber','CustomerId','SupplierId','uploadRefs','attachmentRefs']
    .filter(key => raw[key] !== undefined).map(key => [key,Array.isArray(raw[key]) ? (raw[key] as {id?:string}[]).slice().sort((a,b)=>String(a.id).localeCompare(String(b.id),'en')) : raw[key]]))
  // Bokio can return the same identified invoice rows in a different order.
  // Preserve order when IDs are absent or repeated: those rows lack a stable key.
  const lines = business.lines
  if (Array.isArray(lines) && lines.every(line => line && typeof line === 'object' && line.id != null)
    && new Set(lines.map(line => String(line.id))).size === lines.length) {
    business.lines = lines.slice().sort((a,b) => String(a.id).localeCompare(String(b.id),'en'))
  }
  function stable(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(stable)
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input)
      .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, item]) => [key, stable(item)]))
    return input
  }
  return createHash('sha256').update(JSON.stringify(stable({ ...business, references }))).digest('hex')
}
