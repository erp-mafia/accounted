import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn() }))
vi.mock('@/lib/ai', () => ({ getAiStatus: vi.fn() }))
vi.mock('@/lib/entitlements/has-capability', () => ({ hasCapability: vi.fn() }))
vi.mock('@/lib/suppliers/match-supplier', () => ({ matchSupplierId: vi.fn() }))
vi.mock('@/lib/processing-history/append', () => ({ appendProcessingHistory: vi.fn() }))
vi.mock('@/lib/operations/inbox-bank-match', () => ({ proposeBankMatchForInboxItem: vi.fn() }))
vi.mock('../lib/upload-and-extract', () => ({
  readForInbox: vi.fn(),
  isSandboxCompany: vi.fn(),
  countPdfPages: vi.fn(),
  maxPagesForAutoExtract: vi.fn(),
}))
vi.mock('@/lib/documents/inbox-extraction/mirror-extraction', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/inbox-extraction/mirror-extraction')>()),
  mirrorExtractionToDocument: vi.fn(),
}))

import {
  readingRetryOf,
  retryProviderUnavailableReadings,
  PROVIDER_RETRY_BATCH,
  PROVIDER_RETRY_GAPS_MS,
  PROVIDER_RETRY_MAX_ATTEMPTS,
  PROVIDER_RETRY_WINDOW_MS,
} from '../lib/provider-retry'
import { readForInbox, isSandboxCompany, countPdfPages, maxPagesForAutoExtract, type InboxReading } from '../lib/upload-and-extract'
import { getAiStatus } from '@/lib/ai'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { matchSupplierId } from '@/lib/suppliers/match-supplier'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { proposeBankMatchForInboxItem } from '@/lib/operations/inbox-bank-match'
import { mirrorExtractionToDocument } from '@/lib/documents/inbox-extraction/mirror-extraction'
import { emptyResult } from '@/lib/documents/inbox-extraction/extract-invoice-fields'

/**
 * The sweep's provider retry reads again only documents whose reading failed
 * because the AI provider could not take the call, at most three readings in
 * all, with a gap before each, and never over a person's edit.
 */

const NOW = Date.parse('2026-10-26T12:00:00.000Z')
const SELECTED_AT = '2026-10-26T09:00:00.123+00:00'
const SELECTED_UPDATED_AT = '2026-10-26T09:00:01.456789+00:00'

type Calls = { method: string; args: unknown[] }[]

function candidate(id: string, stamp = 'failed:provider_unavailable', over: Record<string, unknown> = {}) {
  return {
    id,
    company_id: 'co-1',
    document_id: `doc-${id}`,
    correlation_id: `corr-${id}`,
    created_at: `2026-10-26T08:${id.padStart(2, '0')}:00.000000+00:00`,
    updated_at: SELECTED_UPDATED_AT,
    extracted_data: emptyResult(),
    matched_supplier_id: null,
    document_attachments: {
      id: `doc-${id}`,
      company_id: 'co-1',
      storage_path: `documents/co-1/user-1/${id}.pdf`,
      mime_type: 'application/pdf',
      file_name: `${id}.pdf`,
      extraction_model: stamp,
      extracted_at: SELECTED_AT,
    },
    ...over,
  }
}

function read(over: Partial<InboxReading> = {}): InboxReading {
  const extracted = emptyResult()
  extracted.supplier.name = 'Leverantören AB'
  extracted.totals.total = 1250
  return { extracted, rawText: '{"supplier":{}}', model: 'claude-x', extractionSkipped: false, skipReason: null, failure: null, ...over }
}

function stampAsked(calls: Calls): unknown {
  return calls.find((c) => c.method === 'eq' && c.args[0] === 'document_attachments.extraction_model')?.args[1]
}

function setup(opts: {
  due?: Record<string, unknown[]>
  claim?: unknown[]
  write?: unknown[]
  selectError?: { message: string }
} = {}) {
  const selects: Calls[] = []
  const mock = createTableMockSupabase({
    invoice_inbox_items: (calls) => {
      if (calls[0]?.method === 'select') {
        selects.push(calls)
        if (opts.selectError) return { error: opts.selectError }
        return { data: opts.due?.[String(stampAsked(calls))] ?? [] }
      }
      return { data: opts.write ?? [{ id: 'written' }] }
    },
    // The claim is the update guarded on extracted_at; a restamp is not.
    document_attachments: (calls) =>
      calls.some((c) => c.method === 'eq' && c.args[0] === 'extracted_at') ? { data: opts.claim ?? [{ id: 'claimed' }] } : { data: null },
  })
  const download = vi.fn().mockResolvedValue({ data: new Blob(['%PDF-1.7']), error: null })
  const supabase = { ...mock.supabase, storage: { from: vi.fn(() => ({ download })) } }
  return { ...mock, supabase: supabase as never, selects, download }
}

/** Every chain on a table, split into its calls. */
function chains(calls: { table: string; method: string; args: unknown[] }[], table: string, first: string): Calls[] {
  const out: Calls[] = []
  for (const c of calls) {
    if (c.table !== table) continue
    if (c.method === first) out.push([])
    out[out.length - 1]?.push({ method: c.method, args: c.args })
  }
  return out.filter((chain) => chain[0]?.method === first)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getAiStatus).mockReturnValue({ configured: true } as never)
  vi.mocked(hasCapability).mockResolvedValue(true)
  vi.mocked(isSandboxCompany).mockResolvedValue(false)
  vi.mocked(countPdfPages).mockResolvedValue(2)
  vi.mocked(maxPagesForAutoExtract).mockReturnValue(8)
  vi.mocked(matchSupplierId).mockResolvedValue(null)
  vi.mocked(readForInbox).mockResolvedValue(read())
})

describe('retryProviderUnavailableReadings: selection', () => {
  it('asks only for provider failures under the cap, each past its own gap, among open uncorrected items in the window', async () => {
    const { supabase, selects } = setup()

    await retryProviderUnavailableReadings(supabase, NOW)

    // One select per attempt that may still be retried: none for the last.
    expect(PROVIDER_RETRY_MAX_ATTEMPTS).toBe(3)
    expect(selects.map(stampAsked)).toEqual(['failed:provider_unavailable', 'failed:provider_unavailable:2'])
    selects.forEach((calls, i) => {
      const filter = (method: string, column: string) => calls.find((c) => c.method === method && c.args[0] === column)?.args[1]
      expect(filter('eq', 'status')).toBe('received')
      expect(filter('eq', 'extraction_skipped')).toBe(false)
      expect(filter('is', 'created_supplier_invoice_id')).toBeNull()
      expect(filter('is', 'created_journal_entry_id')).toBeNull()
      // No person's correction on the item, no reading on the document.
      expect(calls.some((c) => c.method === 'is' && c.args[0] === 'extracted_data->personFields' && c.args[1] === null)).toBe(true)
      expect(calls.some((c) => c.method === 'is' && c.args[0] === 'document_attachments.extracted_data' && c.args[1] === null)).toBe(true)
      expect(filter('gt', 'created_at')).toBe(new Date(NOW - PROVIDER_RETRY_WINDOW_MS).toISOString())
      // The gap: 15 minutes after the upload's reading, two hours after the first retry.
      expect(filter('lt', 'document_attachments.extracted_at')).toBe(new Date(NOW - PROVIDER_RETRY_GAPS_MS[i]).toISOString())
      expect(calls.find((c) => c.method === 'limit')?.args[0]).toBe(PROVIDER_RETRY_BATCH)
    })
    expect(PROVIDER_RETRY_GAPS_MS).toEqual([15 * 60 * 1000, 120 * 60 * 1000])
    // Two weeks: wide enough for an operator to re-queue an outage's backlog by restamping it.
    expect(PROVIDER_RETRY_WINDOW_MS).toBe(14 * 24 * 60 * 60 * 1000)
  })

  it('reads at most a batch per pass, oldest items first', async () => {
    const { supabase } = setup({
      due: {
        'failed:provider_unavailable': [candidate('5'), candidate('6'), candidate('7')],
        'failed:provider_unavailable:2': [candidate('1', 'failed:provider_unavailable:2'), candidate('2', 'failed:provider_unavailable:2'), candidate('3', 'failed:provider_unavailable:2')],
      },
    })

    const summary = await retryProviderUnavailableReadings(supabase, NOW)

    expect(readForInbox).toHaveBeenCalledTimes(PROVIDER_RETRY_BATCH)
    expect(summary).toEqual({ attempted: 3, read: 3, unavailable: 0 })
    expect(vi.mocked(mirrorExtractionToDocument).mock.calls.map(([doc]) => doc).sort()).toEqual(['doc-1', 'doc-2', 'doc-3'])
  })

  it('does nothing on a deployment without an AI backend', async () => {
    vi.mocked(getAiStatus).mockReturnValue({ configured: false } as never)
    const { supabase, tables } = setup({ due: { 'failed:provider_unavailable': [candidate('1')] } })

    await expect(retryProviderUnavailableReadings(supabase, NOW)).resolves.toEqual({ attempted: 0, read: 0, unavailable: 0 })
    expect(tables()).toEqual([])
    expect(readForInbox).not.toHaveBeenCalled()
  })

  it('never throws: a failed select reads nothing', async () => {
    const { supabase } = setup({ selectError: { message: 'boom' } })
    await expect(retryProviderUnavailableReadings(supabase, NOW)).resolves.toEqual({ attempted: 0, read: 0, unavailable: 0 })
    expect(readForInbox).not.toHaveBeenCalled()
  })
})

describe('retryProviderUnavailableReadings: one retry', () => {
  it('claims the document before reading: the next attempt is counted on the stamp it was selected with', async () => {
    const { supabase, calls } = setup({ due: { 'failed:provider_unavailable': [candidate('1')] } })
    let claimsBeforeReading = -1
    vi.mocked(readForInbox).mockImplementation(async () => {
      claimsBeforeReading = chains(calls, 'document_attachments', 'update').length
      return read()
    })

    await retryProviderUnavailableReadings(supabase, NOW)

    // The attempt is spent before the reading starts.
    expect(claimsBeforeReading).toBe(1)
    const [claim] = chains(calls, 'document_attachments', 'update')
    expect(claim[0].args[0]).toMatchObject({ extraction_model: 'failed:provider_unavailable:2', extracted_at: expect.any(String) })
    expect(claim.slice(1)).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['id', 'doc-1'] },
        { method: 'eq', args: ['extraction_model', 'failed:provider_unavailable'] },
        { method: 'eq', args: ['extracted_at', SELECTED_AT] },
        { method: 'is', args: ['extracted_data', null] },
      ]),
    )
  })

  it('reads no file whose key is not inside the item company', async () => {
    const elsewhere = candidate('1', 'failed:provider_unavailable:2')
    elsewhere.document_attachments = { ...elsewhere.document_attachments, storage_path: 'documents/co-2/user-9/1.pdf' }
    const { supabase, download } = setup({ due: { 'failed:provider_unavailable:2': [elsewhere] } })

    const summary = await retryProviderUnavailableReadings(supabase, NOW)

    expect(summary).toEqual({ attempted: 1, read: 0, unavailable: 0 })
    expect(download).not.toHaveBeenCalled()
    expect(readForInbox).not.toHaveBeenCalled()
  })

  it('reads no document of another company, whatever its key', async () => {
    const otherCompany = candidate('1', 'failed:provider_unavailable:2')
    otherCompany.document_attachments = { ...otherCompany.document_attachments, company_id: 'co-2', storage_path: 'documents/user-9/1.pdf' }
    const { supabase, download, calls } = setup({ due: { 'failed:provider_unavailable:2': [otherCompany] } })

    await retryProviderUnavailableReadings(supabase, NOW)

    expect(download).not.toHaveBeenCalled()
    expect(readForInbox).not.toHaveBeenCalled()
    // Not even claimed: the stamp stays as it was.
    expect(chains(calls, 'document_attachments', 'update')).toEqual([])
  })

  it('writes the reading onto the item with a compare-and-set on updated_at, then mirrors it to the document', async () => {
    vi.mocked(matchSupplierId).mockResolvedValue('sup-1')
    const { supabase, calls, download } = setup({ due: { 'failed:provider_unavailable:2': [candidate('1', 'failed:provider_unavailable:2')] } })

    const summary = await retryProviderUnavailableReadings(supabase, NOW)

    expect(summary).toEqual({ attempted: 1, read: 1, unavailable: 0 })
    expect(download).toHaveBeenCalledWith('documents/co-1/user-1/1.pdf')
    const [write] = chains(calls, 'invoice_inbox_items', 'update')
    expect(write[0].args[0]).toMatchObject({ matched_supplier_id: 'sup-1', extracted_data: expect.objectContaining({ totals: expect.objectContaining({ total: 1250 }) }) })
    expect(write.slice(1)).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['id', '1'] },
        { method: 'eq', args: ['company_id', 'co-1'] },
        { method: 'eq', args: ['status', 'received'] },
        { method: 'eq', args: ['updated_at', SELECTED_UPDATED_AT] },
        { method: 'is', args: ['created_supplier_invoice_id', null] },
        { method: 'is', args: ['created_journal_entry_id', null] },
      ]),
    )
    expect(mirrorExtractionToDocument).toHaveBeenCalledWith('doc-1', expect.objectContaining({ rawText: '{"supplier":{}}', model: 'claude-x' }))
    expect(proposeBankMatchForInboxItem).toHaveBeenCalledWith(supabase, 'co-1', '1')
    expect(appendProcessingHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'DocumentExtractionRetried',
        correlationId: 'corr-1',
        actor: { type: 'system', id: 'invoice-inbox-sweep' },
        payload: expect.objectContaining({ attempt: 3, outcome: 'read', reason: 'provider_unavailable' }),
      }),
    )
  })

  it('keeps a hand-picked supplier when the reading matches none', async () => {
    const { supabase, calls } = setup({ due: { 'failed:provider_unavailable': [candidate('1', 'failed:provider_unavailable', { matched_supplier_id: 'picked' })] } })
    await retryProviderUnavailableReadings(supabase, NOW)
    const [write] = chains(calls, 'invoice_inbox_items', 'update')
    expect(write[0].args[0]).toMatchObject({ matched_supplier_id: 'picked' })
  })

  it('drops the reading when the item changed while it was read (a person edited it): nothing is overwritten', async () => {
    const { supabase, calls } = setup({ due: { 'failed:provider_unavailable': [candidate('1')] }, write: [] })

    const summary = await retryProviderUnavailableReadings(supabase, NOW)

    expect(summary).toEqual({ attempted: 1, read: 0, unavailable: 0 })
    expect(chains(calls, 'invoice_inbox_items', 'update')).toHaveLength(1)
    expect(mirrorExtractionToDocument).not.toHaveBeenCalled()
    expect(proposeBankMatchForInboxItem).not.toHaveBeenCalled()
    // Only the claim touched the document: the person's correction there stands.
    expect(chains(calls, 'document_attachments', 'update')).toHaveLength(1)
    expect(appendProcessingHistory).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ outcome: 'refused' }) }))
  })

  it('reads nothing when another run or a person got to the document first', async () => {
    const { supabase, calls } = setup({ due: { 'failed:provider_unavailable': [candidate('1')] }, claim: [] })

    const summary = await retryProviderUnavailableReadings(supabase, NOW)

    expect(summary).toEqual({ attempted: 0, read: 0, unavailable: 0 })
    expect(readForInbox).not.toHaveBeenCalled()
    expect(chains(calls, 'invoice_inbox_items', 'update')).toHaveLength(0)
  })

  it('keeps the claimed stamp when the provider fails again, so the next pass may try once more', async () => {
    vi.mocked(readForInbox).mockResolvedValue(read({ extracted: emptyResult(), rawText: null, model: null, failure: 'provider_unavailable' }))
    const { supabase, calls } = setup({ due: { 'failed:provider_unavailable': [candidate('1')] } })

    const summary = await retryProviderUnavailableReadings(supabase, NOW)

    expect(summary).toEqual({ attempted: 1, read: 0, unavailable: 1 })
    expect(chains(calls, 'document_attachments', 'update')).toHaveLength(1)
    expect(chains(calls, 'invoice_inbox_items', 'update')).toHaveLength(0)
    expect(mirrorExtractionToDocument).not.toHaveBeenCalled()
  })
})

describe('retryProviderUnavailableReadings: never retries anything else', () => {
  it('stamps a failure that is not the provider as failed:no_raw_text, which no select asks for again', async () => {
    vi.mocked(readForInbox).mockResolvedValue(read({ extracted: emptyResult(), rawText: null, model: null, failure: 'error' }))
    const { supabase, calls, selects } = setup({ due: { 'failed:provider_unavailable': [candidate('1')] } })

    const summary = await retryProviderUnavailableReadings(supabase, NOW)

    expect(summary).toEqual({ attempted: 1, read: 0, unavailable: 0 })
    const [, restamp] = chains(calls, 'document_attachments', 'update')
    expect(restamp[0].args[0]).toMatchObject({ extraction_model: 'failed:no_raw_text' })
    // Guarded on the claim, so it never lands on a document that got a reading meanwhile.
    expect(restamp.slice(1)).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['extraction_model', 'failed:provider_unavailable:2'] },
        { method: 'is', args: ['extracted_data', null] },
      ]),
    )
    expect(chains(calls, 'invoice_inbox_items', 'update')).toHaveLength(0)
    expect(selects.map(stampAsked)).not.toContain('failed:no_raw_text')
  })

  it('stamps a skip with its reason', async () => {
    vi.mocked(readForInbox).mockResolvedValue(read({ extracted: emptyResult(), rawText: null, model: null, extractionSkipped: true, skipReason: 'too_many_pages' }))
    const { supabase, calls } = setup({ due: { 'failed:provider_unavailable': [candidate('1')] } })

    await retryProviderUnavailableReadings(supabase, NOW)

    const [, restamp] = chains(calls, 'document_attachments', 'update')
    expect(restamp[0].args[0]).toMatchObject({ extraction_model: 'skipped:too_many_pages' })
  })

  it.each([
    ['failed:no_raw_text'],
    ['failed:exception'],
    ['failed:provider_unavailable:3'],
    ['claude-sonnet-4-5'],
  ])('leaves a document stamped %s alone even if a select returned it', async (stamp) => {
    const { supabase, calls } = setup({ due: { 'failed:provider_unavailable': [candidate('1', stamp)] } })

    const summary = await retryProviderUnavailableReadings(supabase, NOW)

    expect(summary).toEqual({ attempted: 0, read: 0, unavailable: 0 })
    expect(chains(calls, 'document_attachments', 'update')).toHaveLength(0)
    expect(readForInbox).not.toHaveBeenCalled()
  })
})

describe('retryProviderUnavailableReadings: the upload path gates', () => {
  it('gives a company without the ai capability the skip stamp and makes no call', async () => {
    vi.mocked(hasCapability).mockResolvedValue(false)
    const { supabase, calls } = setup({ due: { 'failed:provider_unavailable': [candidate('1')] } })

    await retryProviderUnavailableReadings(supabase, NOW)

    expect(readForInbox).not.toHaveBeenCalled()
    const [, restamp] = chains(calls, 'document_attachments', 'update')
    expect(restamp[0].args[0]).toMatchObject({ extraction_model: 'skipped:no_ai_entitlement' })
  })

  it('gives a sandbox company the skip stamp and makes no call', async () => {
    vi.mocked(isSandboxCompany).mockResolvedValue(true)
    const { supabase, calls } = setup({ due: { 'failed:provider_unavailable': [candidate('1')] } })

    await retryProviderUnavailableReadings(supabase, NOW)

    expect(readForInbox).not.toHaveBeenCalled()
    const [, restamp] = chains(calls, 'document_attachments', 'update')
    expect(restamp[0].args[0]).toMatchObject({ extraction_model: 'skipped:sandbox' })
  })

  it('reads a long PDF through the same page gate as the upload', async () => {
    vi.mocked(countPdfPages).mockResolvedValue(12)
    const { supabase } = setup({ due: { 'failed:provider_unavailable': [candidate('1')] } })

    await retryProviderUnavailableReadings(supabase, NOW)

    expect(readForInbox).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ companyId: 'co-1', pageCount: 12, gatedByPageCount: true, maxAutoExtractPages: 8 }),
    )
  })

  it('reads with the mail the item came with, as its upload was read (crm#1749)', async () => {
    const mailed = candidate('1', 'failed:provider_unavailable', {
      email_subject: 'Your invoice of Nov 7, 2026',
      email_received_at: '2026-11-07T07:41:00+00:00',
    })
    const { supabase, selects } = setup({ due: { 'failed:provider_unavailable': [mailed, candidate('2')] } })

    await retryProviderUnavailableReadings(supabase, NOW)

    const asked = selects[0].find((c) => c.method === 'select')?.args[0]
    expect(asked).toContain('email_subject, email_received_at')
    expect(vi.mocked(readForInbox).mock.calls.map(([, job]) => job.emailContext)).toEqual([
      { subject: 'Your invoice of Nov 7, 2026', receivedAt: '2026-11-07T07:41:00+00:00' },
      { subject: null, receivedAt: null },
    ])
  })
})

describe('readingRetryOf: what the Inkorg promises', () => {
  const filed = new Date(NOW - 60 * 60 * 1000).toISOString()

  it('promises a reading within a quarter of an hour after the upload failed, within two hours after one retry', () => {
    expect(readingRetryOf('failed:provider_unavailable', filed, NOW)).toBe('scheduled')
    expect(readingRetryOf('failed:provider_unavailable:2', filed, NOW)).toBe('scheduled_later')
  })

  it('promises nothing more at the cap, or for an item older than the window the sweep looks in', () => {
    expect(readingRetryOf('failed:provider_unavailable:3', filed, NOW)).toBe('exhausted')
    const old = new Date(NOW - PROVIDER_RETRY_WINDOW_MS - 1000).toISOString()
    expect(readingRetryOf('failed:provider_unavailable', old, NOW)).toBe('exhausted')
    expect(readingRetryOf('failed:provider_unavailable', null, NOW)).toBe('exhausted')
  })

  it('says nothing for any other stamp', () => {
    for (const stamp of ['failed:no_raw_text', 'failed:exception', 'skipped:sandbox', 'claude-sonnet-4-5', null, undefined]) {
      expect(readingRetryOf(stamp, filed, NOW)).toBeNull()
    }
  })
})
