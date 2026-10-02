import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { listRecords, typesFor } from '../list-records'

const mock = createQueuedMockSupabase()
const { enqueue, reset, findCalls } = mock
const supabase = mock.supabase as unknown as SupabaseClient

beforeEach(() => reset())

describe('typesFor', () => {
  it('takes a doc_type, a folder or untyped, and refuses anything else', () => {
    expect(typesFor(undefined)).toBeUndefined()
    expect(typesFor('untyped')).toBeNull()
    expect(typesFor('receipt')).toEqual(['receipt'])
    expect(typesFor('authority')).toEqual(['registration.bolagsverket', 'filing.bolagsverket', 'decision.skatteverket'])
    expect(typesFor('agreements')).toContain('agreement.loan')
    expect(() => typesFor('spaceship')).toThrow(/Unknown type/)
  })
})

describe('listRecords', () => {
  it('lists every document of a type, raw, with the verifikat, the earliest copy of a duplicated text, and where the next page starts', async () => {
    enqueue({
      data: [
        { id: 'd3', file_name: 'IMG_4417 (2).jpeg', doc_type: 'receipt', created_at: '2026-09-03T10:00:00Z', page_count: 1, pages_read_at: '2026-09-03', read_error: null, journal_entry_id: null },
        { id: 'd2', file_name: 'OpenAI-14-juli.pdf', doc_type: 'receipt', created_at: '2026-07-14T10:00:00Z', page_count: 1, pages_read_at: '2026-07-14', read_error: null, journal_entry_id: 'je-1' },
      ],
      count: 5,
    })
    enqueue({ data: [{ id: 'je-1', voucher_series: 'A', voucher_number: 361 }] })
    enqueue({ data: [{ document_id: 'd3', content_sha256: 'h1' }, { document_id: 'd2', content_sha256: 'h2' }] })
    enqueue({ data: [{ document_id: 'd3', content_sha256: 'h1' }, { document_id: 'd1', content_sha256: 'h1' }, { document_id: 'd2', content_sha256: 'h2' }] })
    enqueue({ data: [{ id: 'd1', created_at: '2026-08-13T10:00:00Z' }, { id: 'd2', created_at: '2026-07-14T10:00:00Z' }, { id: 'd3', created_at: '2026-09-03T10:00:00Z' }] })

    const out = await listRecords(supabase, 'co-1', { type: 'receipts', uploadedFrom: '2026-01-01', offset: 0, limit: 2 })
    expect(out).toEqual({
      total: 5,
      next_offset: 2,
      items: [
        { record_ref: 'document:d3', file_name: 'IMG_4417 (2).jpeg', doc_type: 'receipt', uploaded_at: '2026-09-03T10:00:00Z', page_count: 1, read: true, voucher: null, duplicate_of: 'document:d1' },
        { record_ref: 'document:d2', file_name: 'OpenAI-14-juli.pdf', doc_type: 'receipt', uploaded_at: '2026-07-14T10:00:00Z', page_count: 1, read: true, voucher: 'A361', duplicate_of: null },
      ],
    })
    expect(findCalls('document_attachments', 'in')).toContainEqual(['doc_type', ['receipt']])
    expect(findCalls('document_attachments', 'gte')).toContainEqual(['created_at', '2026-01-01'])
    expect(findCalls('document_attachments', 'range')).toContainEqual([0, 1])
    // The bank's JSON archives are files, not documents: kept out at the query.
    expect(findCalls('document_attachments', 'or').map((c) => c[0])).toContain('mime_type.is.null,mime_type.not.in.(application/xml,text/xml,application/json)')
    // Nothing a model read out of the document is fetched.
    expect(findCalls('document_extractions', 'select')).toEqual([])
  })

  it('marks a later copy of the same file even when the reader made different text of it', async () => {
    enqueue({
      data: [
        { id: 'p2', file_name: 'IMG_4417.jpeg', doc_type: 'receipt', created_at: '2026-08-10T08:00:00Z', page_count: 1, pages_read_at: 'x', read_error: null, journal_entry_id: null, sha256_hash: 'bytes-1' },
        { id: 'p1', file_name: 'IMG_4417.jpeg', doc_type: 'receipt', created_at: '2026-05-20T13:40:00Z', page_count: 1, pages_read_at: 'x', read_error: null, journal_entry_id: null, sha256_hash: 'bytes-1' },
      ],
      count: 2,
    })
    enqueue({ data: [{ document_id: 'p2', content_sha256: 'text-b' }, { document_id: 'p1', content_sha256: 'text-a' }] })
    enqueue({ data: [{ document_id: 'p2', content_sha256: 'text-b' }, { document_id: 'p1', content_sha256: 'text-a' }] })
    enqueue({ data: [{ id: 'p1', created_at: '2026-05-20T13:40:00Z' }, { id: 'p2', created_at: '2026-08-10T08:00:00Z' }] })
    enqueue({ data: [{ id: 'p1', created_at: '2026-05-20T13:40:00Z', sha256_hash: 'bytes-1' }, { id: 'p2', created_at: '2026-08-10T08:00:00Z', sha256_hash: 'bytes-1' }] })
    const out = await listRecords(supabase, 'co-1', { type: 'receipt' })
    expect(out.items.map((i) => [i.record_ref, i.duplicate_of])).toEqual([
      ['document:p2', 'document:p1'],
      ['document:p1', null],
    ])
  })

  it('ends with no next page and fetches nothing more when the list is empty', async () => {
    enqueue({ data: [], count: 0 })
    expect(await listRecords(supabase, 'co-1', { type: 'untyped' })).toEqual({ items: [], total: 0, next_offset: null })
    expect(findCalls('document_attachments', 'is')).toContainEqual(['doc_type', null])
    expect(findCalls('document_classifications', 'select')).toEqual([])
  })
})
