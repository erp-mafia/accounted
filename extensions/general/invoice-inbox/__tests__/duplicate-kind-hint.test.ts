import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

// The duplicate branch of processArchivedDocument returns before any upload,
// entitlement check or Bedrock call, so only the history append needs a mock.
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: vi.fn().mockResolvedValue(undefined),
}))

import { processArchivedDocument } from '@/extensions/general/invoice-inbox/lib/upload-and-extract'
import { appendProcessingHistory } from '@/lib/processing-history/append'

const FILE = { name: 'faktura.pdf', buffer: new ArrayBuffer(8), type: 'application/pdf' }

interface AdoptedRow {
  id: string
  status: string
  extracted_data: unknown
  matched_supplier_id: string | null
  matched_transaction_id: string | null
  kind_hint: 'supplier_invoice' | 'receipt' | null
  created_supplier_invoice_id: string | null
  created_journal_entry_id: string | null
}

function makeAdoptedRow(overrides: Partial<AdoptedRow> = {}): AdoptedRow {
  return {
    id: 'inbox-1',
    status: 'received',
    extracted_data: { documentKind: 'receipt' },
    matched_supplier_id: null,
    matched_transaction_id: null,
    kind_hint: null,
    created_supplier_invoice_id: null,
    created_journal_entry_id: null,
    ...overrides,
  }
}

/**
 * The duplicate branch: the item lookup, then (at most) the guarded
 * kind_hint update. `updateRows` is what the UPDATE ... RETURNING id gives
 * back: one row when the guard passed, none when a concurrent booking won.
 */
function mockSupabaseFor(
  row: AdoptedRow,
  opts: { updateRows?: Array<{ id: string }>; updateError?: { message: string } | null } = {},
) {
  const mock = createQueuedMockSupabase()
  mock.enqueue({ data: [row], error: null })
  mock.enqueue({
    data: opts.updateRows ?? [{ id: row.id }],
    error: opts.updateError ?? null,
  })
  return mock
}

function historyPayload(): Record<string, unknown> {
  const call = vi.mocked(appendProcessingHistory).mock.calls[0]?.[0] as
    | { payload: Record<string, unknown> }
    | undefined
  return call?.payload ?? {}
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('duplicate delivery keeps the sender kind hint (#2569)', () => {
  it('adopts an incoming supplier_invoice hint on an unhinted open item', async () => {
    const { supabase, findCall } = mockSupabaseFor(makeAdoptedRow())

    const result = await processArchivedDocument(
      supabase as never,
      'user-1',
      'company-1',
      { id: 'doc-1', deduplicated: true },
      FILE,
      'email',
      { from: 'sender@example.com', kindHint: 'supplier_invoice' },
    )

    expect(result).toMatchObject({ duplicate: true, inbox_item_id: 'inbox-1' })
    expect(findCall('invoice_inbox_items', 'update')?.[0]).toEqual({
      kind_hint: 'supplier_invoice',
    })
    expect(historyPayload()).toMatchObject({
      reason: 'duplicate_content',
      kind_hint_incoming: 'supplier_invoice',
      kind_hint_before: null,
      kind_hint_after: 'supplier_invoice',
      kind_hint_skipped: null,
    })
  })

  it('guards the update with the consumption predicates, not just the id', async () => {
    const { supabase, findCalls } = mockSupabaseFor(makeAdoptedRow())

    await processArchivedDocument(
      supabase as never,
      'user-1',
      'company-1',
      { id: 'doc-1', deduplicated: true },
      FILE,
      'email',
      { kindHint: 'supplier_invoice' },
    )

    // The row was read a statement earlier: the write must re-check the same
    // predicate itself, and ask for the changed row back.
    expect(findCalls('invoice_inbox_items', 'is').map((args) => args[0])).toEqual([
      'created_supplier_invoice_id',
      'created_journal_entry_id',
      'matched_transaction_id',
    ])
    expect(findCalls('invoice_inbox_items', 'eq').map((args) => args[0])).toContain('id')
    expect(findCalls('invoice_inbox_items', 'select').at(-1)).toEqual(['id'])
  })

  it('does not re-badge when a concurrent booking wins the race', async () => {
    // The lookup sees an open item, but by the time the UPDATE runs another
    // request has booked it: the guarded write matches zero rows.
    const { supabase, findCall } = mockSupabaseFor(makeAdoptedRow({ kind_hint: 'receipt' }), {
      updateRows: [],
    })

    await processArchivedDocument(
      supabase as never,
      'user-1',
      'company-1',
      { id: 'doc-1', deduplicated: true },
      FILE,
      'email',
      { kindHint: 'supplier_invoice' },
    )

    // The write was attempted (the pre-check could not know) but changed
    // nothing, so the history must not claim the new value.
    expect(findCall('invoice_inbox_items', 'update')?.[0]).toEqual({
      kind_hint: 'supplier_invoice',
    })
    expect(historyPayload()).toMatchObject({
      kind_hint_incoming: 'supplier_invoice',
      kind_hint_before: 'receipt',
      kind_hint_after: 'receipt',
      kind_hint_skipped: 'consumed',
    })
  })

  it('lets the newer tag win over an older one: +ver first, then +lev', async () => {
    const { supabase, findCall } = mockSupabaseFor(makeAdoptedRow({ kind_hint: 'receipt' }))

    await processArchivedDocument(
      supabase as never,
      'user-1',
      'company-1',
      { id: 'doc-1', deduplicated: true },
      FILE,
      'email',
      { kindHint: 'supplier_invoice' },
    )

    expect(findCall('invoice_inbox_items', 'update')?.[0]).toEqual({
      kind_hint: 'supplier_invoice',
    })
    expect(historyPayload()).toMatchObject({
      kind_hint_before: 'receipt',
      kind_hint_after: 'supplier_invoice',
      kind_hint_skipped: null,
    })
  })

  it('leaves a consumed item alone: history records the hint that was not applied', async () => {
    const { supabase, findCall } = mockSupabaseFor(
      makeAdoptedRow({ kind_hint: 'receipt', created_supplier_invoice_id: 'si-1' }),
    )

    await processArchivedDocument(
      supabase as never,
      'user-1',
      'company-1',
      { id: 'doc-1', deduplicated: true },
      FILE,
      'email',
      { kindHint: 'supplier_invoice' },
    )

    expect(findCall('invoice_inbox_items', 'update')).toBeUndefined()
    expect(historyPayload()).toMatchObject({
      kind_hint_incoming: 'supplier_invoice',
      kind_hint_before: 'receipt',
      kind_hint_after: 'receipt',
      kind_hint_skipped: 'consumed',
    })
  })

  it('leaves an item alone once it is booked directly or matched to a transaction', async () => {
    for (const consumed of [
      { created_journal_entry_id: 'je-1' },
      { matched_transaction_id: 'tx-1' },
    ]) {
      vi.clearAllMocks()
      const { supabase, findCall } = mockSupabaseFor(makeAdoptedRow(consumed))

      await processArchivedDocument(
        supabase as never,
        'user-1',
        'company-1',
        { id: 'doc-1', deduplicated: true },
        FILE,
        'email',
        { kindHint: 'supplier_invoice' },
      )

      expect(findCall('invoice_inbox_items', 'update')).toBeUndefined()
      expect(historyPayload()).toMatchObject({ kind_hint_after: null, kind_hint_skipped: 'consumed' })
    }
  })

  it('does not write when the hint is unchanged', async () => {
    const { supabase, findCall } = mockSupabaseFor(
      makeAdoptedRow({ kind_hint: 'supplier_invoice' }),
    )

    await processArchivedDocument(
      supabase as never,
      'user-1',
      'company-1',
      { id: 'doc-1', deduplicated: true },
      FILE,
      'email',
      { kindHint: 'supplier_invoice' },
    )

    expect(findCall('invoice_inbox_items', 'update')).toBeUndefined()
    expect(historyPayload()).toMatchObject({
      kind_hint_before: 'supplier_invoice',
      kind_hint_after: 'supplier_invoice',
      kind_hint_skipped: null,
    })
  })

  it('does not clear an existing hint when the duplicate carries none', async () => {
    const { supabase, findCall } = mockSupabaseFor(makeAdoptedRow({ kind_hint: 'receipt' }))

    await processArchivedDocument(
      supabase as never,
      'user-1',
      'company-1',
      { id: 'doc-1', deduplicated: true },
      FILE,
      'upload',
    )

    expect(findCall('invoice_inbox_items', 'update')).toBeUndefined()
    expect(historyPayload()).toMatchObject({
      kind_hint_incoming: null,
      kind_hint_before: 'receipt',
      kind_hint_after: 'receipt',
      kind_hint_skipped: null,
    })
  })

  it('reports the unchanged hint when the update fails', async () => {
    const { supabase, findCall } = mockSupabaseFor(makeAdoptedRow(), { updateError: { message: 'boom' } })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await processArchivedDocument(
      supabase as never,
      'user-1',
      'company-1',
      { id: 'doc-1', deduplicated: true },
      FILE,
      'email',
      { kindHint: 'supplier_invoice' },
    )

    expect(findCall('invoice_inbox_items', 'update')?.[0]).toEqual({
      kind_hint: 'supplier_invoice',
    })
    expect(result).toMatchObject({ duplicate: true })
    expect(historyPayload()).toMatchObject({
      kind_hint_incoming: 'supplier_invoice',
      kind_hint_after: null,
      kind_hint_skipped: 'write_failed',
    })
    consoleError.mockRestore()
  })
})
