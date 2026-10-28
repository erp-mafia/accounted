/**
 * Tests for the read-only bank-import duplicate preview.
 *
 * previewDuplicates runs the decision function ingestTransactions runs
 * (Layer-1 external_id, the content bridge with counting semantics, the
 * currency guard and both mirrors), because the wizard shows its answer as
 * "these rows will be skipped". Row-by-row agreement with the commit is
 * pinned in ingest-identical-rows.test.ts. The queue order per call is:
 * booked map page(s), unbooked map page(s), then one external_id chunk query
 * per 500 rows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { previewDuplicates, type PreviewTransaction } from '../dedup-preview'
import { createQueuedMockSupabase } from '@/tests/helpers'

const COMPANY_ID = 'company-1'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

function makePreviewRow(overrides: Partial<PreviewTransaction> = {}): PreviewTransaction {
  return {
    date: '2024-06-15',
    amount: -250.0,
    description: 'ICA Maxi Solna',
    external_id: `csv_lunar_${Math.random().toString(36).slice(2, 8)}`,
    currency: 'SEK',
    ...overrides,
  }
}

describe('previewDuplicates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  // (a) Layer 1: exact external_id collision.
  it('flags an exact external_id hit under by_reason.external_id', async () => {
    const raw = makePreviewRow({ external_id: 'csv_lunar_stored' })

    enqueue({ data: [] }) // booked map
    enqueue({ data: [] }) // unbooked map
    enqueue({ data: [{ external_id: 'csv_lunar_stored' }] }) // external_id chunk

    const result = await previewDuplicates(supabase as never, COMPANY_ID, [raw])

    expect(result.duplicate_row_indexes).toEqual([0])
    expect(result.duplicate_count).toBe(1)
    expect(result.by_reason).toEqual({ external_id: 1, content_bridge: 0 })
  })

  // (b) Layer 2: content bridge against a stored unbooked import-feed row
  // whose description bridges by prefix containment.
  it('flags a content-bridge hit (same date+öre, prefix description) under by_reason.content_bridge', async () => {
    const raw = makePreviewRow({ description: 'ICA Maxi Solna Kortköp' })

    enqueue({ data: [] }) // booked map
    enqueue({
      data: [{
        date: '2024-06-15', amount: -250.0,
        original_description: 'ICA Maxi Solna', description: 'ICA Maxi Solna',
        import_source: 'csv_lunar', currency: 'SEK',
      }],
    }) // unbooked map: stored CSV twin, stored title is a prefix of incoming
    enqueue({ data: [] }) // external_id chunk: different id, no Layer-1 hit

    const result = await previewDuplicates(supabase as never, COMPANY_ID, [raw])

    expect(result.duplicate_row_indexes).toEqual([0])
    expect(result.by_reason).toEqual({ external_id: 0, content_bridge: 1 })
  })

  // (c) Counting semantics: N stored twins flag exactly N incoming rows.
  it('flags exactly one of two identical incoming rows against one stored twin', async () => {
    const rows = [
      makePreviewRow({ external_id: 'csv_lunar_a' }),
      makePreviewRow({ external_id: 'csv_lunar_b' }),
    ]

    enqueue({ data: [] }) // booked map
    enqueue({
      data: [{
        date: '2024-06-15', amount: -250.0,
        original_description: 'ICA Maxi Solna', description: 'ICA Maxi Solna',
        import_source: 'csv_lunar', currency: 'SEK',
      }],
    }) // unbooked map: ONE stored twin
    enqueue({ data: [] }) // external_id chunk

    const result = await previewDuplicates(supabase as never, COMPANY_ID, rows)

    expect(result.duplicate_row_indexes).toEqual([0])
    expect(result.duplicate_count).toBe(1)
    expect(result.by_reason.content_bridge).toBe(1)
  })

  // (d) A same-(date, öre) row with a non-bridging description is NOT flagged
  // (mirrors ingest's same-channel different-description semantics).
  it('does not flag a same-(date, öre) row whose description does not bridge', async () => {
    const raw = makePreviewRow({ description: 'Coop Stockholm' })

    enqueue({ data: [] }) // booked map
    enqueue({
      data: [{
        date: '2024-06-15', amount: -250.0,
        original_description: 'ICA Maxi Solna', description: 'ICA Maxi Solna',
        import_source: 'csv_lunar', currency: 'SEK',
      }],
    }) // unbooked map
    enqueue({ data: [] }) // external_id chunk

    const result = await previewDuplicates(supabase as never, COMPANY_ID, [raw])

    expect(result.duplicate_row_indexes).toEqual([])
    expect(result.duplicate_count).toBe(0)
  })

  // (e) Currency guard: identical titles and öre in DIFFERENT currencies never
  // bridge (a stored 250,00 EUR row is not the incoming 250,00 SEK row).
  it('does not flag across currencies (stored EUR vs incoming SEK, same öre and title)', async () => {
    const raw = makePreviewRow({ currency: 'SEK' })

    enqueue({ data: [] }) // booked map
    enqueue({
      data: [{
        date: '2024-06-15', amount: -250.0,
        original_description: 'ICA Maxi Solna', description: 'ICA Maxi Solna',
        import_source: 'csv_lunar', currency: 'EUR',
      }],
    }) // unbooked map: EUR twin in the same (date, öre) bucket
    enqueue({ data: [] }) // external_id chunk

    const result = await previewDuplicates(supabase as never, COMPANY_ID, [raw])

    expect(result.duplicate_row_indexes).toEqual([])
    expect(result.duplicate_count).toBe(0)
  })

  // (f) Pagination: a stored twin beyond the 1000-row PostgREST page must
  // still land in the map (the fetchAllRows fix; the old un-paginated query
  // silently truncated at 1000 rows and missed it).
  it('flags a twin served on the second stored page (>1000 rows)', async () => {
    const raw = makePreviewRow()

    // Page 1: exactly 1000 filler rows in other (date, öre) buckets, which
    // forces fetchAllRows to request a second page.
    const filler = Array.from({ length: 1000 }, (_, i) => ({
      date: '2024-06-01',
      amount: -(i + 1),
      original_description: `Filler ${i}`,
      description: `Filler ${i}`,
      import_source: 'csv_lunar',
      currency: 'SEK',
    }))
    enqueue({ data: filler }) // booked map page 1 (full page)
    enqueue({
      data: [{
        date: '2024-06-15', amount: -250.0,
        original_description: 'ICA Maxi Solna', description: 'ICA Maxi Solna',
        import_source: 'csv_lunar', currency: 'SEK',
      }],
    }) // booked map page 2: the twin
    enqueue({ data: [] }) // unbooked map
    enqueue({ data: [] }) // external_id chunk

    const result = await previewDuplicates(supabase as never, COMPANY_ID, [raw])

    expect(result.duplicate_row_indexes).toEqual([0])
    expect(result.by_reason.content_bridge).toBe(1)
  })

  // (g) The cross-channel mirror. Execute skips a row whose only stored twin
  // is worded differently by another channel when the bucket counts match
  // (CSV shows the payee, the bank feed the OCR line). The preview runs the
  // same decision, so given the channel execute will stamp it flags the row
  // too; it used to under-count here.
  it('flags a cross-channel mirror twin whose description does not bridge', async () => {
    const raw = makePreviewRow({ description: 'TELENOR', import_source: 'csv_lunar' })

    enqueue({ data: [] }) // booked map
    enqueue({
      data: [{
        id: 'tx-feed', date: '2024-06-15', amount: -250.0,
        original_description: 'Bg 5050-1055 OCR 12345', description: 'Bg 5050-1055 OCR 12345',
        import_source: 'enable_banking', bank_connection_id: 'conn-1', currency: 'SEK',
        external_id: 'eb_scope_2024-06-15_-25000_0',
      }],
    }) // unbooked map: the feed's copy of the same payment
    enqueue({ data: [] }) // external_id chunk

    const result = await previewDuplicates(supabase as never, COMPANY_ID, [raw])

    expect(result.duplicate_row_indexes).toEqual([0])
    expect(result.by_reason).toEqual({ external_id: 0, content_bridge: 1 })
  })

  // crm#1491: a SEB file read as Länsförsäkringar stored its rows with the Typ
  // word as description and a lansforsakringar_ id. Read correctly, the same
  // file carries seb_ ids and the Text column, so neither Layer 1 nor the text
  // bridge matches; the cross-channel mirror (csv_seb vs csv_lansforsakringar,
  // one row each in the bucket) still keeps the re-import from duplicating it.
  it('flags a re-import of a SEB file whose rows were stored under the Länsförsäkringar id', async () => {
    const raw = makePreviewRow({
      description: 'BRIDGEKLUBBEN AVGIFT',
      import_source: 'csv_seb',
      external_id: 'seb_0123456789abcdef',
    })

    enqueue({
      data: [{
        id: 'tx-lf', date: '2024-06-15', amount: -250.0,
        original_description: 'Annan', description: 'Annan',
        import_source: 'csv_lansforsakringar', currency: 'SEK',
        external_id: 'lansforsakringar_fedcba9876543210',
      }],
    }) // booked map: the earlier import, booked
    enqueue({ data: [] }) // unbooked map
    enqueue({ data: [] }) // external_id chunk: the id changed with the format

    const result = await previewDuplicates(supabase as never, COMPANY_ID, [raw])

    expect(result.duplicate_row_indexes).toEqual([0])
    expect(result.by_reason).toEqual({ external_id: 0, content_bridge: 1 })
  })

  // The mirror is gated on the batch being an import feed, exactly as in
  // execute: without a channel the description requirement stays.
  it('does not mirror when the rows carry no import_source', async () => {
    const raw = makePreviewRow({ description: 'TELENOR' })

    enqueue({ data: [] }) // booked map
    enqueue({
      data: [{
        id: 'tx-feed', date: '2024-06-15', amount: -250.0,
        original_description: 'Bg 5050-1055 OCR 12345', description: 'Bg 5050-1055 OCR 12345',
        import_source: 'enable_banking', bank_connection_id: 'conn-1', currency: 'SEK',
        external_id: 'eb_scope_2024-06-15_-25000_0',
      }],
    }) // unbooked map
    enqueue({ data: [] }) // external_id chunk

    const result = await previewDuplicates(supabase as never, COMPANY_ID, [raw])

    expect(result.duplicate_row_indexes).toEqual([])
  })

  it('returns an empty result for an empty batch without querying', async () => {
    const result = await previewDuplicates(supabase as never, COMPANY_ID, [])

    expect(result).toEqual({
      duplicate_row_indexes: [],
      duplicate_count: 0,
      by_reason: { external_id: 0, content_bridge: 0 },
    })
    expect(supabase.from).not.toHaveBeenCalled()
  })
})
