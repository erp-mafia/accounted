/**
 * Staging gnubok_link_transaction_to_journal_entry, generated from the
 * operation transactions.link-journal-entry (lib/operations/transactions.ts).
 * The staging dry run is the service's own (linkTransactionToJournalEntry in
 * lib/transactions/link-journal-entry.ts), so the approver sees what the v1
 * endpoint would answer, and every refusal the approval would give comes at
 * staging: among them a row already in a samlingsverifikat or split (a
 * transaction_voucher_links bank line) and a credit note as the invoice,
 * which the hand-written tool staged and the approval then refused.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The sale-first rule (defer_invoice_booking) has its own suites
// (lib/invoices/__tests__/sale-first.test.ts and the deferred-door tests);
// here no invoice needs its sale booked first.
vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSaleBeforeSettlement: vi.fn(async () => ({ ok: true, required: false })),
  planSaleBeforeSettlementById: vi.fn(async () => ({ ok: true, required: false })),
  planSalesBeforeBatchSettlement: vi.fn(async () => ({ ok: true, plans: [] })),
}))
import { createQueuedMockSupabase, enqueueBankLinkLeg } from '@/tests/helpers'
import { tools } from '../server'

const link = tools.find((t) => t.name === 'gnubok_link_transaction_to_journal_entry')!

const TX_ID = '11111111-1111-4111-8111-111111111111'
const JE_ID = '33333333-3333-4333-8333-333333333333'
const INV_ID = '22222222-2222-4222-8222-222222222222'
const actor = { type: 'api_key' } as never

const bankRow = {
  id: TX_ID,
  date: '2026-08-31',
  amount: 1250,
  currency: 'SEK',
  exchange_rate: null,
  description: 'BG 123-4567',
  merchant_name: 'Kund AB',
  cash_account_id: null,
  journal_entry_id: null,
  invoice_id: null,
  is_business: true,
  potential_invoice_id: null,
  potential_supplier_invoice_id: null,
  potential_rot_rut_payout_request_id: null,
  transaction_voucher_links: [],
}
const postedEntry = { id: JE_ID, status: 'posted', voucher_series: 'A', voucher_number: 12, entry_date: '2026-09-02' }
const openInvoice = {
  id: INV_ID,
  status: 'sent',
  total: 1250,
  paid_amount: 0,
  remaining_amount: 1250,
  currency: 'SEK',
  exchange_rate: null,
  paid_at: null,
  invoice_number: '1042',
  credited_invoice_id: null,
  customer: { name: 'Kund AB' },
}

type Staged = {
  staged: boolean
  preview: Record<string, unknown>
  next?: { tool?: string }
  period_status?: { date?: string }
}

/** The period_status lookups + the pending_operations insert. */
function enqueueStage(enqueue: (r: { data?: unknown; error?: unknown }) => void) {
  enqueue({ data: { bookkeeping_locked_through: null }, error: null }) // company_settings
  enqueue({ data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null }) // fiscal_periods
  enqueue({ data: { id: 'op-link-1' }, error: null }) // pending_operations insert
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_link_transaction_to_journal_entry: staged from the operation', () => {
  it('stages the link with the title, the approval card rows and the later date for the period check', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: bankRow, error: null })
    enqueue({ data: postedEntry, error: null })
    enqueueBankLinkLeg(enqueue)
    enqueueStage(enqueue)

    const result = (await link.execute(
      { transaction_id: TX_ID, journal_entry_id: JE_ID },
      'company-1', 'user-1', supabase as never, actor,
    )) as Staged

    expect(result.staged).toBe(true)
    // The ids stay in params; the verifikat's own text stays out (free text).
    expect(result.preview).not.toHaveProperty('journal_entry_id')
    expect(result.preview).not.toHaveProperty('voucher_description')
    expect(result.preview).toMatchObject({
      transaction_description: 'Kund AB',
      transaction_amount: 1250,
      transaction_currency: 'SEK',
      transaction_date: '2026-08-31',
      voucher_label: 'A-12',
      voucher_date: '2026-09-02',
      invoice_id: null,
      invoice_number: null,
      invoice_remaining_after: null,
      will_be_fully_paid: null,
    })
    expect(result.next?.tool).toBe('gnubok_query_journal')
    const inserted = findCall('pending_operations', 'insert')?.[0] as Record<string, unknown>
    expect(inserted).toMatchObject({
      operation_type: 'link_transaction_journal_entry',
      title: 'Länka Kund AB → verifikat A-12',
      params: { transaction_id: TX_ID, journal_entry_id: JE_ID },
    })
    // The later of the row's date and the verifikat's: a locked September
    // must not hide behind an open August.
    expect(findCall('fiscal_periods', 'lte')).toEqual(['period_start', '2026-09-02'])
  })

  it('with invoice_id: names the invoice in the title and says whether it is settled in full', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: bankRow, error: null })
    enqueue({ data: postedEntry, error: null })
    enqueueBankLinkLeg(enqueue)
    enqueue({ data: openInvoice, error: null })
    // invoice_settlement_side (#3440), then the voucher's lines on that side.
    enqueue({ data: { settlement_side: 'ar_credit', account_prefix: '151', entry_side: 'credit' }, error: null })
    enqueue({ data: [{ account_number: '1510', debit_amount: 0, credit_amount: 1250 }], error: null })
    enqueueStage(enqueue)

    const result = (await link.execute(
      { transaction_id: TX_ID, journal_entry_id: JE_ID, invoice_id: INV_ID },
      'company-1', 'user-1', supabase as never, actor,
    )) as Staged

    expect(result.preview).toMatchObject({
      invoice_id: INV_ID,
      invoice_number: '1042',
      invoice_remaining_after: 0,
      will_be_fully_paid: true,
    })
    expect(result.next?.tool).toBe('gnubok_get_ar_ledger')
    const inserted = findCall('pending_operations', 'insert')?.[0] as Record<string, unknown>
    expect(inserted.title).toBe('Länka Kund AB → verifikat A-12 + faktura 1042')
  })

  it('refuses a row already in a samlingsverifikat, which the hand-written tool staged', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { ...bankRow, transaction_voucher_links: [{ journal_entry_id: 'je-sum', role: 'bank_line' }] }, error: null })

    await expect(link.execute(
      { transaction_id: TX_ID, journal_entry_id: JE_ID },
      'company-1', 'user-1', supabase as never, actor,
    )).rejects.toMatchObject({ code: 'LINK_TX_TX_ALREADY_LINKED' })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('refuses a credit note as the invoice, which the hand-written tool staged', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: bankRow, error: null })
    enqueue({ data: postedEntry, error: null })
    enqueueBankLinkLeg(enqueue)
    enqueue({ data: { ...openInvoice, credited_invoice_id: 'inv-original' }, error: null })

    await expect(link.execute(
      { transaction_id: TX_ID, journal_entry_id: JE_ID, invoice_id: INV_ID },
      'company-1', 'user-1', supabase as never, actor,
    )).rejects.toMatchObject({ code: 'LINK_TX_INVOICE_CREDIT_NOTE' })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('refuses a draft verifikat with its code', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: bankRow, error: null })
    enqueue({ data: { ...postedEntry, status: 'draft' }, error: null })

    await expect(link.execute(
      { transaction_id: TX_ID, journal_entry_id: JE_ID },
      'company-1', 'user-1', supabase as never, actor,
    )).rejects.toMatchObject({ code: 'LINK_TX_JE_NOT_POSTED' })
  })

  it('rejects a non-uuid id before any query runs', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(link.execute(
      { transaction_id: TX_ID, journal_entry_id: 'A-12' },
      'company-1', 'user-1', supabase as never, actor,
    )).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('is search-only, like before: gnubok_reconcile_match is the listed link tool', () => {
    expect(link.catalogVisibility).toBe('search')
  })
})
