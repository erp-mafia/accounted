import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { archiveBankFileOriginal, bankFileOriginalPath, recordBankFileArrival } from '../arrival'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const IMPORT_ID = '33333333-3333-4333-8333-333333333333'
const BYTES = new TextEncoder().encode('Datum;Text;Belopp\n2026-10-01;Hyra;-100,00\n')
const FILE_HASH = 'f'.repeat(64)
const PATH = `documents/${COMPANY}/arrivals/bank_file/${FILE_HASH}/kontoutdrag_oktober.csv`
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

let mock: ReturnType<typeof createQueuedMockSupabase>
let supabase: SupabaseClient
let bucket: { upload: ReturnType<typeof vi.fn>; download: ReturnType<typeof vi.fn> }

beforeEach(() => {
  vi.clearAllMocks()
  mock = createQueuedMockSupabase()
  supabase = mock.supabase as unknown as SupabaseClient
  bucket = mock.supabase.storage.from('documents') as typeof bucket
})

const arrivalInput = {
  companyId: COMPANY,
  importId: IMPORT_ID,
  fileHash: FILE_HASH,
  filename: 'kontoutdrag oktober.csv',
  format: 'seb',
  transactionCount: 2,
  importedCount: 2,
  dateFrom: '2026-10-01',
  dateTo: '2026-10-31',
  fetchedBy: { type: 'user' as const, user_id: USER },
  via: 'app' as const,
}

describe('bankFileOriginalPath', () => {
  it('keys the original by company and content hash, with the file name as one plain segment', () => {
    expect(bankFileOriginalPath(COMPANY, FILE_HASH, 'kontoutdrag oktober.csv')).toBe(PATH)
    expect(bankFileOriginalPath(COMPANY, FILE_HASH, '../../etc/passwd')).toBe(
      `documents/${COMPANY}/arrivals/bank_file/${FILE_HASH}/passwd`,
    )
  })

  it('names nothing for a hash or company id that cannot be a key', () => {
    expect(bankFileOriginalPath(COMPANY, '../other', 'a.csv')).toBeNull()
    expect(bankFileOriginalPath('company-1', FILE_HASH, 'a.csv')).toBeNull()
  })
})

describe('archiveBankFileOriginal', () => {
  it('stores the file as it came, without overwriting, and describes it', async () => {
    const ref = await archiveBankFileOriginal(supabase, {
      companyId: COMPANY, fileHash: FILE_HASH, filename: 'kontoutdrag oktober.csv', bytes: BYTES, mime: 'text/csv',
    })
    expect(mock.supabase.storage.from).toHaveBeenCalledWith('documents')
    expect(bucket.upload).toHaveBeenCalledWith(PATH, BYTES, { contentType: 'text/csv', upsert: false })
    expect(ref).toEqual({ path: PATH, sha256: sha(BYTES), size: BYTES.byteLength, mime: 'text/csv' })
  })

  it('reuses the object an earlier preview of the same file stored, describing the bytes there', async () => {
    const stored = new TextEncoder().encode('earlier copy')
    bucket.upload.mockResolvedValueOnce({ data: null, error: { message: 'The resource already exists' } })
    bucket.download.mockResolvedValueOnce({ data: new Blob([stored], { type: 'text/csv' }), error: null })
    const ref = await archiveBankFileOriginal(supabase, {
      companyId: COMPANY, fileHash: FILE_HASH, filename: 'kontoutdrag oktober.csv', bytes: BYTES, mime: '',
    })
    expect(bucket.download).toHaveBeenCalledWith(PATH)
    expect(ref).toEqual({ path: PATH, sha256: sha(stored), size: stored.byteLength, mime: 'text/csv' })
  })

  it('returns null instead of throwing when Storage refuses or throws', async () => {
    bucket.upload.mockResolvedValueOnce({ data: null, error: { message: 'denied' } })
    bucket.download.mockResolvedValueOnce({ data: null, error: { message: 'not found' } })
    await expect(archiveBankFileOriginal(supabase, {
      companyId: COMPANY, fileHash: FILE_HASH, filename: 'a.csv', bytes: BYTES,
    })).resolves.toBeNull()
    bucket.upload.mockRejectedValueOnce(new Error('network'))
    await expect(archiveBankFileOriginal(supabase, {
      companyId: COMPANY, fileHash: FILE_HASH, filename: 'a.csv', bytes: BYTES,
    })).resolves.toBeNull()
    await expect(archiveBankFileOriginal(supabase, {
      companyId: COMPANY, fileHash: 'not-a-hash', filename: 'a.csv', bytes: BYTES,
    })).resolves.toBeNull()
  })
})

describe('recordBankFileArrival', () => {
  it('records the import as a bank_file arrival pointing at the original parse archived', async () => {
    bucket.download.mockResolvedValueOnce({ data: new Blob([BYTES], { type: 'text/csv' }), error: null })
    mock.enqueue({ data: null }) // no arrival yet
    mock.enqueue({ data: [{ id: 'arrival-1' }] })
    await recordBankFileArrival(supabase, arrivalInput)

    expect(bucket.download).toHaveBeenCalledWith(PATH)
    const [row] = mock.findCall('arrivals', 'upsert') as [Record<string, unknown>]
    expect(row).toMatchObject({
      company_id: COMPANY,
      source: 'bank_file',
      source_ref: IMPORT_ID,
      fetched_by: { type: 'user', user_id: USER },
      original_path: PATH,
      original_sha256: sha(BYTES),
      original_mime: 'text/csv',
      original_size: BYTES.byteLength,
    })
    expect(row.source_meta).toEqual({
      via: 'app',
      bank_file_import_id: IMPORT_ID,
      filename: 'kontoutdrag oktober.csv',
      file_hash: FILE_HASH,
      format: 'seb',
      transaction_count: 2,
      imported_count: 2,
      date_from: '2026-10-01',
      date_to: '2026-10-31',
    })
    expect(mock.findCall('arrival_outputs', 'upsert')).toBeUndefined()
  })

  it('uses an original the caller just archived without reading it back', async () => {
    mock.enqueue({ data: null })
    mock.enqueue({ data: [{ id: 'arrival-1' }] })
    await recordBankFileArrival(supabase, {
      ...arrivalInput,
      via: 'partner_api',
      original: { path: PATH, sha256: 'a'.repeat(64), size: 10, mime: 'text/csv' },
    })
    expect(bucket.download).not.toHaveBeenCalled()
    const [row] = mock.findCall('arrivals', 'upsert') as [Record<string, unknown>]
    expect(row).toMatchObject({ original_path: PATH, original_sha256: 'a'.repeat(64), original_size: 10 })
  })

  it('still records the arrival when no original was kept, and says so', async () => {
    bucket.download.mockResolvedValueOnce({ data: null, error: { message: 'Object not found' } })
    mock.enqueue({ data: null })
    mock.enqueue({ data: [{ id: 'arrival-1' }] })
    await recordBankFileArrival(supabase, arrivalInput)
    const [row] = mock.findCall('arrivals', 'upsert') as [Record<string, unknown>]
    expect(row).toMatchObject({ original_path: null, original_sha256: null })
    expect(row.source_meta).toMatchObject({ original_missing: 'not_archived' })
  })

  it('never throws', async () => {
    bucket.download.mockRejectedValueOnce(new Error('network'))
    await expect(recordBankFileArrival(supabase, arrivalInput)).resolves.toBeUndefined()
    mock.enqueue({ data: null, error: { message: 'boom' } })
    await expect(recordBankFileArrival(supabase, {
      ...arrivalInput, original: { path: PATH },
    })).resolves.toBeUndefined()
  })
})
