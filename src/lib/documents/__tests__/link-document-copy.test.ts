/**
 * linkDocumentCopyToVoucher (crm#1207): the same underlag on a second
 * verifikat, a rättelse resting on the original's invoice. A document row
 * holds one verifikat for good, so the second one gets a byte-identical copy
 * archived straight onto it; the source never moves. Agents used to re-upload
 * the file, met content dedupe, and changed a byte to get a new id.
 */
import { createHash } from 'node:crypto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

const download = vi.fn()
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: () => ({ storage: { from: () => ({ download }) } }),
}))

const uploadDocument = vi.fn()
vi.mock('@/lib/core/documents/document-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/documents/document-service')>()),
  uploadDocument: (...args: unknown[]) => uploadDocument(...args),
}))

import { checkDocumentLink, linkDocumentCopyToVoucher } from '../link-document'

const DOC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const JE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const ORIGINAL_JE = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const LINE = '11111111-1111-4111-8111-111111111111'
const PERIOD = '22222222-2222-4222-8222-222222222222'

const BYTES = new TextEncoder().encode('%PDF-1.7 the supplier invoice')
const SHA = createHash('sha256').update(BYTES).digest('hex')

const HELD_BY_ORIGINAL = {
  id: DOC, file_name: 'faktura.pdf', mime_type: 'application/pdf', journal_entry_id: ORIGINAL_JE, journal_entry_line_id: null,
}
const CORRECTION = {
  id: JE, entry_date: '2026-03-02', description: 'Rättelse A2', voucher_series: 'A', voucher_number: 27,
  status: 'posted', fiscal_period_id: PERIOD,
}
const OPEN_PERIOD = { id: PERIOD, period_start: '2025-09-01', is_closed: false, locked_at: null, closed_externally: false, closing_entry_id: null }
const SOURCE = {
  id: DOC, storage_path: 'company-1/user-1/faktura.pdf', sha256_hash: SHA, file_name: 'faktura.pdf',
  mime_type: 'application/pdf', upload_source: 'api',
}

function supabaseFor(steps: Array<{ data: unknown; error?: unknown }>) {
  const mock = createQueuedMockSupabase()
  for (const step of steps) mock.enqueue({ data: step.data, error: step.error ?? null })
  return mock
}

const asClient = (s: unknown) => s as SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
  download.mockResolvedValue({ data: new Blob([BYTES]), error: null })
  uploadDocument.mockImplementation(async (_s, _u, _c, file: { name: string }, meta: Record<string, unknown>) => ({
    id: 'copy-1', file_name: file.name, journal_entry_id: meta.journal_entry_id, sha256_hash: SHA,
  }))
})

describe('checkDocumentLink with asCopy', () => {
  it('lets a document held by another verifikat through, without reading the holder', async () => {
    const { supabase, findCall } = supabaseFor([{ data: HELD_BY_ORIGINAL }, { data: CORRECTION }, { data: OPEN_PERIOD }])

    const result = await checkDocumentLink(asClient(supabase), 'company-1', { document_id: DOC, journal_entry_id: JE }, { asCopy: true })

    expect(result.ok).toBe(true)
    expect(findCall('fiscal_periods', 'select')).toBeDefined()
  })
})

describe('linkDocumentCopyToVoucher', () => {
  it('archives a byte-identical copy on the verifikat, provenance kept, the source untouched', async () => {
    const { supabase, findCall } = supabaseFor([
      { data: HELD_BY_ORIGINAL }, { data: CORRECTION }, { data: OPEN_PERIOD }, // the link rules
      { data: SOURCE },                                                          // the source row
      { data: [] },                                                              // the verifikat holds no such bytes yet
    ])

    const result = await linkDocumentCopyToVoucher(asClient(supabase), 'company-1', 'user-1', { document_id: DOC, journal_entry_id: JE })

    expect(result).toMatchObject({ ok: true, reused: false, source_document_id: DOC, document: { id: 'copy-1', journal_entry_id: JE } })
    expect(download).toHaveBeenCalledWith(SOURCE.storage_path)
    expect(uploadDocument).toHaveBeenCalledTimes(1)
    const [, userId, companyId, file, meta] = uploadDocument.mock.calls[0]!
    expect([userId, companyId]).toEqual(['user-1', 'company-1'])
    expect(file).toMatchObject({ name: 'faktura.pdf', type: 'application/pdf' })
    expect(createHash('sha256').update(new Uint8Array(file.buffer)).digest('hex')).toBe(SHA)
    expect(meta).toEqual({
      upload_source: 'api',
      journal_entry_id: JE,
      idempotency_key: `document-copy:${DOC}:${JE}`,
      extractionOwner: 'none',
    })
    // The source document is never written: its link is permanent.
    expect(findCall('document_attachments', 'update')).toBeUndefined()
  })

  it('pins the copy to the line when one is given', async () => {
    const { supabase } = supabaseFor([
      { data: HELD_BY_ORIGINAL }, { data: CORRECTION }, { data: { id: LINE } }, { data: OPEN_PERIOD },
      { data: SOURCE }, { data: [] },
    ])

    await linkDocumentCopyToVoucher(asClient(supabase), 'company-1', 'user-1', { document_id: DOC, journal_entry_id: JE, journal_entry_line_id: LINE })

    expect(uploadDocument.mock.calls[0]![4]).toMatchObject({ journal_entry_id: JE, journal_entry_line_id: LINE })
  })

  it('writes nothing when the verifikat already holds these exact bytes (a retried approval)', async () => {
    const { supabase } = supabaseFor([
      { data: HELD_BY_ORIGINAL }, { data: CORRECTION }, { data: OPEN_PERIOD },
      { data: SOURCE },
      { data: [{ id: 'copy-1', journal_entry_id: JE, sha256_hash: SHA }] },
    ])

    const result = await linkDocumentCopyToVoucher(asClient(supabase), 'company-1', 'user-1', { document_id: DOC, journal_entry_id: JE })

    expect(result).toMatchObject({ ok: true, reused: true, document: { id: 'copy-1' } })
    expect(download).not.toHaveBeenCalled()
    expect(uploadDocument).not.toHaveBeenCalled()
  })

  it('refuses to copy a file whose bytes no longer match the archived hash', async () => {
    download.mockResolvedValue({ data: new Blob([new TextEncoder().encode('something else')]), error: null })
    const { supabase } = supabaseFor([
      { data: HELD_BY_ORIGINAL }, { data: CORRECTION }, { data: OPEN_PERIOD }, { data: SOURCE }, { data: [] },
    ])

    await expect(
      linkDocumentCopyToVoucher(asClient(supabase), 'company-1', 'user-1', { document_id: DOC, journal_entry_id: JE }),
    ).rejects.toThrow(/integrity check/)
    expect(uploadDocument).not.toHaveBeenCalled()
  })

  it('refuses a verifikat in a locked period before reading or writing any file', async () => {
    const { supabase } = supabaseFor([
      { data: HELD_BY_ORIGINAL }, { data: CORRECTION },
      { data: { ...OPEN_PERIOD, is_closed: true, locked_at: '2026-09-01T00:00:00Z' } },
    ])

    const result = await linkDocumentCopyToVoucher(asClient(supabase), 'company-1', 'user-1', { document_id: DOC, journal_entry_id: JE })

    expect(result).toMatchObject({ ok: false, code: 'PERIOD_LOCKED' })
    expect(download).not.toHaveBeenCalled()
    expect(uploadDocument).not.toHaveBeenCalled()
  })

  it('answers NOT_FOUND for a verifikat outside the company', async () => {
    const { supabase } = supabaseFor([{ data: HELD_BY_ORIGINAL }, { data: null }])

    const result = await linkDocumentCopyToVoucher(asClient(supabase), 'company-1', 'user-1', { document_id: DOC, journal_entry_id: JE })

    expect(result).toEqual({ ok: false, code: 'NOT_FOUND', details: { resource: 'journal_entry', field: 'journal_entry_id' } })
    expect(uploadDocument).not.toHaveBeenCalled()
  })
})
