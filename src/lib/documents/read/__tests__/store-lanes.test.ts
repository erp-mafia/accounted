import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('../router', () => ({ readDocumentBytes: vi.fn() }))
vi.mock('@/lib/core/documents/document-service', () => ({ downloadDocumentObject: vi.fn() }))
vi.mock('@/lib/ai', () => ({ getAiStatus: vi.fn(() => ({ configured: true })) }))
vi.mock('@/lib/arkiv/usage', () => ({ recordArkivUsage: vi.fn(async () => undefined) }))

import { planForDocument, readAndStoreDocument, readUnreadDocuments } from '../store'
import { readDocumentBytes } from '../router'
import { downloadDocumentObject } from '@/lib/core/documents/document-service'
import { recordArkivUsage } from '@/lib/arkiv/usage'

const mock = createQueuedMockSupabase()
const { enqueue, reset, findCalls } = mock
const supabase = mock.supabase as unknown as SupabaseClient
const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>
const now = new Date('2026-09-17T12:00:00Z')
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString()
const base = { id: 'doc-1', company_id: 'co-1', storage_path: 'documents/co-1/a.pdf', mime_type: 'application/pdf', pages_read_at: null, read_error: null, doc_type: null, journal_entry_id: null, journal_entry_line_id: null }
const readOk = (pages: Array<[number, 'pdf_text' | 'claude_vision']>) => ({ ok: true, reader: pages[0]?.[1] ?? 'pdf_text', pageCount: pages.length, pages: pages.map(([pageNo, reader]) => ({ pageNo, text: 't', reader, hasTextLayer: reader === 'pdf_text' })) })

beforeEach(() => {
  reset()
  vi.clearAllMocks()
  process.env.ARKIV_BRAIN_COMPANY_IDS = 'co-1'
  asMock(downloadDocumentObject).mockResolvedValue({ blob: new Blob([Buffer.from('%PDF-')]), error: null, resolvedPath: 'p' })
})
afterEach(() => {
  delete process.env.ARKIV_BRAIN_COMPANY_IDS
})

describe('planForDocument', () => {
  it('follows the lanes: live in full, tied history text only, loose history one page, an acting type in full on the second pass', () => {
    expect(planForDocument({ ...base, created_at: daysAgo(2) }, now)).toEqual({ lane: 'live', allowModel: true, maxModelPages: null })
    expect(planForDocument({ ...base, created_at: daysAgo(90), journal_entry_id: 'je' }, now)).toEqual({ lane: 'history_tied', allowModel: false, maxModelPages: null, tier: 'extraction' })
    expect(planForDocument({ ...base, created_at: daysAgo(90) }, now)).toEqual({ lane: 'history_loose', allowModel: true, maxModelPages: 1, tier: 'extraction' })
    expect(planForDocument({ ...base, created_at: daysAgo(90), pages_read_at: 'x', read_error: 'partial:budget', doc_type: 'agreement.loan' }, now)).toEqual({ lane: 'history_loose', allowModel: true, maxModelPages: null, tier: 'extraction' })
    expect(planForDocument({ ...base, created_at: daysAgo(90), pages_read_at: 'x', read_error: 'partial:budget', doc_type: 'receipt' }, now)).toBeNull()
    // The shelf is on for every company: a company nobody listed is read the same way.
    process.env.ARKIV_BRAIN_COMPANY_IDS = 'someone-else'
    expect(planForDocument({ ...base, created_at: daysAgo(90) }, now)).toEqual({ lane: 'history_loose', allowModel: true, maxModelPages: 1, tier: 'extraction' })
  })
})

describe('readAndStoreDocument, the meter', () => {
  it('counts every page read and the vision pages once more', async () => {
    asMock(readDocumentBytes).mockResolvedValue(readOk([[1, 'pdf_text'], [2, 'claude_vision'], [3, 'claude_vision']]))
    enqueue({}) // delete pages
    enqueue({}) // insert pages
    enqueue({}) // stamp
    const out = await readAndStoreDocument(supabase, { ...base, created_at: daysAgo(1) }, { allowModel: true, maxModelPages: 1 })
    expect(out).toMatchObject({ status: 'read', pages: 3 })
    expect(readDocumentBytes).toHaveBeenCalledWith(expect.any(Buffer), 'application/pdf', { allowModel: true, maxModelPages: 1 })
    expect(recordArkivUsage).toHaveBeenCalledWith(supabase, 'co-1', 'pages_read', 3)
    expect(recordArkivUsage).toHaveBeenCalledWith(supabase, 'co-1', 'pages_vision', 2)
  })
})

describe('readUnreadDocuments, the lanes and the budget', () => {
  it('reads the unread batch by lane: text only for tied history, one model page for loose history', async () => {
    asMock(readDocumentBytes).mockResolvedValue(readOk([[1, 'pdf_text']]))
    enqueue({ data: [] }) // retry batch, asked for first
    enqueue({ data: [{ ...base, id: 'tied', created_at: daysAgo(60), journal_entry_id: 'je' }, { ...base, id: 'loose', created_at: daysAgo(60) }, { ...base, id: 'new', created_at: daysAgo(1) }] })
    for (let i = 0; i < 9; i++) enqueue({}) // three reads, three writes each
    const onRead = vi.fn(async () => undefined)
    const counts = await readUnreadDocuments(supabase, 10, { now, onRead })
    expect(counts).toEqual({ processed: 3, read: 3, skipped: 0, errors: 0 })
    expect(onRead.mock.calls.map((c) => (c as unknown as [{ id: string }, { pages: number }])[0].id)).toEqual(['tied', 'loose', 'new'])
    expect(asMock(readDocumentBytes).mock.calls.map((c) => c[2])).toEqual([
      { allowModel: false, maxModelPages: null, tier: 'extraction' },
      { allowModel: true, maxModelPages: 1, tier: 'extraction' },
      { allowModel: true, maxModelPages: null },
    ])
  })

  it('leaves gated voucher-tied history alone without a budget, and spends the budget on it when there is one', async () => {
    asMock(readDocumentBytes).mockResolvedValue(readOk([[1, 'claude_vision'], [2, 'claude_vision']]))
    const tied = { ...base, id: 'tied', created_at: daysAgo(60), journal_entry_id: 'je', pages_read_at: 'x', read_error: 'ai_gated', mime_type: 'image/jpeg' }
    enqueue({ data: [tied] }) // retry batch, asked for first
    enqueue({ data: [] }) // unread batch
    expect(await readUnreadDocuments(supabase, 10, { now })).toEqual({ processed: 0, read: 0, skipped: 0, errors: 0 })
    expect(readDocumentBytes).not.toHaveBeenCalled()

    reset()
    enqueue({ data: [tied, { ...tied, id: 'tied-2' }] }) // retry batch
    enqueue({ data: { units: 3 } }) // vision pages spent today
    for (let i = 0; i < 3; i++) enqueue({}) // one read: delete, insert, stamp
    enqueue({ data: [] }) // unread batch, asked for last
    expect(await readUnreadDocuments(supabase, 10, { now, budgetPagesPerDay: 4 })).toEqual({ processed: 1, read: 1, skipped: 0, errors: 0 })
    expect(readDocumentBytes).toHaveBeenCalledTimes(1)
    expect(readDocumentBytes).toHaveBeenCalledWith(expect.any(Buffer), 'image/jpeg', { allowModel: true, maxModelPages: null, tier: 'extraction' })
    expect(findCalls('arkiv_usage_daily', 'eq')).toEqual([
      ['company_id', 'co-1'],
      ['activity', 'pages_vision'],
      ['day', '2026-09-17'],
    ])
  })

  it('finishes a loose history document that turned out to be an acting type, and skips one that did not', async () => {
    asMock(readDocumentBytes).mockResolvedValue(readOk([[1, 'claude_vision']]))
    enqueue({
      data: [
        { ...base, id: 'loan', created_at: daysAgo(60), pages_read_at: 'x', read_error: 'partial:ai_gated', doc_type: 'agreement.loan' },
        { ...base, id: 'receipt', created_at: daysAgo(60), pages_read_at: 'x', read_error: 'partial:ai_gated', doc_type: 'receipt' },
        { ...base, id: 'untyped', created_at: daysAgo(60), pages_read_at: 'x', read_error: 'ai_gated' },
      ],
    })
    for (let i = 0; i < 6; i++) enqueue({})
    enqueue({ data: [] }) // unread batch, asked for last
    expect(await readUnreadDocuments(supabase, 10, { now })).toMatchObject({ processed: 2, read: 2 })
    expect(asMock(readDocumentBytes).mock.calls.map((c) => c[2])).toEqual([
      { allowModel: true, maxModelPages: null, tier: 'extraction' },
      { allowModel: true, maxModelPages: 1, tier: 'extraction' },
    ])
  })
})
