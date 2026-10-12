/**
 * The SIE intake: where a browser upload and a provider migration's
 * server-side fetch both leave a file, and the only place the import reads
 * one back from by path. The read refuses every path outside the active
 * company's intake folder before storage is asked.
 */
import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { archiveSIEIntakeText, isSIEIntakePath, readSIEIntakeFile } from '../sie-intake'
import { SIEIntakeNotFoundError, SIEIntakePathError, SIEJobValidationError } from '../sie-jobs'

function memoryBucket(initial: Record<string, string> = {}) {
  const files = new Map<string, Blob>(Object.entries(initial).map(([k, v]) => [k, new Blob([v])]))
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
  const supabase = { storage: { from: vi.fn(() => bucket) } } as unknown as SupabaseClient
  return { supabase, bucket, files }
}

const SIE = '#FLAGGA 0\n#SIETYP 4\n#FNAMN "Bolaget AB"\n#KONTO 1930 "Företagskonto"\n'
const OWN = 'company-1/sie-intake/0f8fad5b-d9cb-469f-a165-70867728950e.se'

describe('isSIEIntakePath', () => {
  it('accepts only the active company\'s intake shape', () => {
    expect(isSIEIntakePath('company-1', OWN)).toBe(true)
    expect(isSIEIntakePath('company-2', OWN)).toBe(false)
    expect(isSIEIntakePath('company-1', 'company-1/sie-intake/../../company-2/sie-intake/0f8fad5b-d9cb-469f-a165-70867728950e.se')).toBe(false)
    expect(isSIEIntakePath('company-1', 'company-1/sie-jobs/0f8fad5b-d9cb-469f-a165-70867728950e.se')).toBe(false)
    expect(isSIEIntakePath('company-1', 'company-1/sie-intake/x/0f8fad5b-d9cb-469f-a165-70867728950e.se')).toBe(false)
    expect(isSIEIntakePath('company-1', '/company-1/sie-intake/0f8fad5b-d9cb-469f-a165-70867728950e.se')).toBe(false)
  })
})

describe('readSIEIntakeFile', () => {
  it('reads the active company\'s own file', async () => {
    const { supabase } = memoryBucket({ [OWN]: SIE })
    const file = await readSIEIntakeFile(supabase, 'company-1', OWN, 'migration-sie-2026.se')
    expect(await file.text()).toBe(SIE)
    expect(file.name).toBe('migration-sie-2026.se')
  })

  it('refuses another company\'s path without asking storage, as a validation error to callers that only know the parent', async () => {
    const foreign = OWN.replace('company-1', 'company-2')
    const { supabase, bucket } = memoryBucket({ [foreign]: SIE })
    const read = readSIEIntakeFile(supabase, 'company-1', foreign, 'export.se')
    await expect(read).rejects.toBeInstanceOf(SIEIntakePathError)
    await expect(read).rejects.toBeInstanceOf(SIEJobValidationError)
    expect(bucket.download).not.toHaveBeenCalled()
  })

  it('refuses a traversal that starts with the company prefix', async () => {
    const { supabase, bucket } = memoryBucket()
    await expect(readSIEIntakeFile(supabase, 'company-1',
      'company-1/sie-intake/../../company-2/sie-intake/0f8fad5b-d9cb-469f-a165-70867728950e.se', 'export.se',
    )).rejects.toBeInstanceOf(SIEIntakePathError)
    expect(bucket.download).not.toHaveBeenCalled()
  })

  it('answers a well-formed path with no file as not found', async () => {
    const { supabase } = memoryBucket()
    const read = readSIEIntakeFile(supabase, 'company-1', OWN, 'export.se')
    await expect(read).rejects.toBeInstanceOf(SIEIntakeNotFoundError)
    await expect(read).rejects.toThrow('hittades inte')
  })

  it('refuses a filename that is not an SIE file name, as before', async () => {
    const { supabase } = memoryBucket({ [OWN]: SIE })
    const read = readSIEIntakeFile(supabase, 'company-1', OWN, 'export.exe')
    await expect(read).rejects.toBeInstanceOf(SIEJobValidationError)
    await expect(read).rejects.not.toBeInstanceOf(SIEIntakePathError)
  })
})

describe('archiveSIEIntakeText', () => {
  it('writes the text to a content-addressed intake path the read accepts', async () => {
    const { supabase, files } = memoryBucket()
    const { path, bytes } = await archiveSIEIntakeText(supabase, 'company-1', SIE)
    const hash = createHash('sha256').update(SIE).digest('hex')
    expect(path).toBe(`company-1/sie-intake/${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}.se`)
    expect(isSIEIntakePath('company-1', path)).toBe(true)
    expect(bytes).toBe(Buffer.byteLength(SIE, 'utf8'))
    expect(await files.get(path)!.text()).toBe(SIE)
    expect(await (await readSIEIntakeFile(supabase, 'company-1', path, 'export.se')).text()).toBe(SIE)
  })

  it('reuses the object when the same export is fetched again', async () => {
    const { supabase, files } = memoryBucket()
    const first = await archiveSIEIntakeText(supabase, 'company-1', SIE)
    const second = await archiveSIEIntakeText(supabase, 'company-1', SIE)
    expect(second.path).toBe(first.path)
    expect(files.size).toBe(1)
  })

  it('refuses to reuse a different object found at the path', async () => {
    const { supabase, files } = memoryBucket()
    const { path } = await archiveSIEIntakeText(supabase, 'company-1', SIE)
    files.set(path, new Blob(['#FLAGGA 0\n']))
    await expect(archiveSIEIntakeText(supabase, 'company-1', SIE)).rejects.toThrow('kunde inte arkiveras')
  })

  it('refuses an empty file without writing anything', async () => {
    const { supabase, bucket } = memoryBucket()
    await expect(archiveSIEIntakeText(supabase, 'company-1', '')).rejects.toBeInstanceOf(SIEJobValidationError)
    expect(bucket.upload).not.toHaveBeenCalled()
  })
})
