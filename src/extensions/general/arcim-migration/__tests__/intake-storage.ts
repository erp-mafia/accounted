import { vi } from 'vitest'

/**
 * The `sie-files` bucket as /sie-data and /import-sie use it: upload refuses
 * an existing key (upsert: false, the bucket is WORM), download answers what
 * was stored or a not-found error. `files` is the bucket's content.
 */
export function memoryIntakeStorage(initial: Record<string, string> = {}) {
  const files = new Map<string, Blob>(Object.entries(initial).map(([path, text]) => [path, new Blob([text])]))
  const bucket = {
    upload: vi.fn(async (path: string, body: Blob) => {
      if (files.has(path)) return { data: null, error: { message: 'The resource already exists' } }
      files.set(path, body)
      return { data: { path }, error: null }
    }),
    download: vi.fn(async (path: string) => {
      const blob = files.get(path)
      return blob ? { data: blob, error: null } : { data: null, error: { message: 'Object not found' } }
    }),
  }
  const storage = { from: vi.fn((name: string) => {
    if (name !== 'sie-files') throw new Error(`unexpected bucket ${name}`)
    return bucket
  }) }
  return { storage, bucket, files }
}

/** A well-formed intake path for a company. */
export const intakePath = (companyId: string, id = '0f8fad5b-d9cb-469f-a165-70867728950e') =>
  `${companyId}/sie-intake/${id}.se`
