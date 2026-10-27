import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

const switchStateMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/bank-feed/switch-campaign', () => ({
  switchStateFor: (...args: unknown[]) => switchStateMock(...args),
}))

import {
  countBankSwitchDue,
  listBankSwitchDue,
  countCollectedPaymentsToBook,
  countCollectionSettlementsToBook,
  countDeadlinesNeedingAction,
  countFailedPeppolDeliveries,
  countInboxDocuments,
  getOverdueInvoicesDue,
  summarizeOverdueInvoices,
  countPendingOperations,
  countCollectionDecisionsAndBatch,
  countReminderBatchReady,
  countReconciliationDue,
  countSuggestedMatches,
  countUnclassifiedDocuments,
  REVIEW_RECENT_DAYS,
  countSupplierInvoicesAwaitingApproval,
  countUnbookedSkattekontoRows,
  countUnbookedTransactions,
  countVerifikatMissingDocument,
  listExpensePayoutsDue,
  listExpensePayoutSuggestions,
  listSkattekontoPaymentDue,
  countSkattekontoPaymentDue,
  listRotRutPayoutSetSuggestions,
  listSuggestedMatches,
} from '../categories'
import {
  MATCHABLE_INVOICE_STATUSES,
  MATCHABLE_SUPPLIER_INVOICE_STATUSES,
} from '@/lib/bookkeeping/matchable-statuses'

const { supabase: mockSupabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()
const supabase = mockSupabase as unknown as SupabaseClient
const COMPANY = 'company-1'

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

describe('listBankSwitchDue', () => {
  const NOW = new Date('2026-10-20T08:00:00Z')

  it('is empty while the campaign is off or does not apply', async () => {
    switchStateMock.mockResolvedValue(null)
    await expect(listBankSwitchDue(supabase, COMPANY, NOW)).resolves.toEqual([])
    await expect(countBankSwitchDue(supabase, COMPANY, NOW)).resolves.toBe(0)
    expect(switchStateMock).toHaveBeenCalledWith({ supabase, companyId: COMPANY }, { now: NOW })
  })

  it('answers one row per pending connection with the deadline math from the campaign state', async () => {
    switchStateMock.mockResolvedValue({
      state: 'pending',
      pending: [{ connection_id: 'c1', bank_name: 'Swedbank' }, { connection_id: 'c2', bank_name: 'SEB' }],
      uncovered: [{ connection_id: 'c3', bank_name: 'Wise' }],
      open_payments: 0,
      deadline: '2026-11-09',
      days_left: 20,
      passed: false,
      urgent: false,
    })
    await expect(listBankSwitchDue(supabase, COMPANY, NOW)).resolves.toEqual([
      { connection_id: 'c1', bank_name: 'Swedbank', deadline: '2026-11-09', days_left: 20, passed: false, urgent: false },
      { connection_id: 'c2', bank_name: 'SEB', deadline: '2026-11-09', days_left: 20, passed: false, urgent: false },
    ])
    await expect(countBankSwitchDue(supabase, COMPANY, NOW)).resolves.toBe(2)
  })

  it('keeps the row past the deadline, marked passed and urgent, so it says the connection has ended', async () => {
    switchStateMock.mockResolvedValue({
      state: 'pending',
      pending: [{ connection_id: 'c1', bank_name: 'Swedbank' }],
      uncovered: [],
      open_payments: 0,
      deadline: '2026-11-09',
      days_left: -3,
      passed: true,
      urgent: true,
    })
    await expect(listBankSwitchDue(supabase, COMPANY, NOW)).resolves.toEqual([
      { connection_id: 'c1', bank_name: 'Swedbank', deadline: '2026-11-09', days_left: -3, passed: true, urgent: true },
    ])
  })

  it('soft-fails to empty when the state cannot be read', async () => {
    switchStateMock.mockRejectedValue(new Error('boom'))
    await expect(listBankSwitchDue(supabase, COMPANY, NOW)).resolves.toEqual([])
  })
})

describe('countUnbookedTransactions', () => {
  it('returns the head count from transactions', async () => {
    enqueue({ count: 4 })
    await expect(countUnbookedTransactions(supabase, COMPANY)).resolves.toBe(4)
    expect(mockSupabase.from).toHaveBeenCalledWith('transactions')
  })

  it('soft-fails to 0 on query error', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(countUnbookedTransactions(supabase, COMPANY)).resolves.toBe(0)
  })
})

describe('countSupplierInvoicesAwaitingApproval', () => {
  it('counts registered invoices but never credit notes', async () => {
    // A credit note is a reversal with nothing to attest; the detail page
    // offers no attest button for it, so counting one here made an item
    // nobody could clear (support case 2026-09-04).
    enqueue({ count: 1 })
    await expect(countSupplierInvoicesAwaitingApproval(supabase, COMPANY)).resolves.toBe(1)
    const eqCalls = findCalls('supplier_invoices', 'eq')
    expect(eqCalls).toContainEqual(['status', 'registered'])
    expect(eqCalls).toContainEqual(['is_credit_note', false])
  })

  it('counts nothing for a company on kontantmetoden: it has no attest step (crm#1156)', async () => {
    // The detail page and the list never offer Attestera under
    // kontantmetoden, so a registered invoice counted here was an Att göra
    // item nobody could clear.
    enqueue({ count: 2 })
    enqueue({ data: { accounting_method: 'cash' } })
    await expect(countSupplierInvoicesAwaitingApproval(supabase, COMPANY)).resolves.toBe(0)
    expect(findCall('company_settings', 'select')).toEqual(['accounting_method'])
    expect(findCalls('company_settings', 'eq')).toContainEqual(['company_id', COMPANY])
  })

  it('keeps counting under faktureringsmetoden, and for a company with no setting', async () => {
    enqueue({ count: 2 })
    enqueue({ data: { accounting_method: 'accrual' } })
    await expect(countSupplierInvoicesAwaitingApproval(supabase, COMPANY)).resolves.toBe(2)
    // The credit-note exclusion is unchanged by the method gate.
    expect(findCalls('supplier_invoices', 'eq')).toContainEqual(['is_credit_note', false])
    reset()
    enqueue({ count: 2 })
    enqueue({ data: null })
    await expect(countSupplierInvoicesAwaitingApproval(supabase, COMPANY)).resolves.toBe(2)
  })

  it('soft-fails to 0 when either read fails', async () => {
    enqueue({ error: { message: 'boom' } })
    enqueue({ data: { accounting_method: 'accrual' } })
    await expect(countSupplierInvoicesAwaitingApproval(supabase, COMPANY)).resolves.toBe(0)
    reset()
    enqueue({ count: 2 })
    enqueue({ error: { message: 'settings boom' } })
    await expect(countSupplierInvoicesAwaitingApproval(supabase, COMPANY)).resolves.toBe(0)
  })
})

describe('countUnbookedSkattekontoRows', () => {
  it('counts only settled, unbooked, non-ignored skattekonto rows', async () => {
    enqueue({ count: 3 })
    await expect(countUnbookedSkattekontoRows(supabase, COMPANY)).resolves.toBe(3)
    expect(mockSupabase.from).toHaveBeenCalledWith('skattekonto_transactions')
    // Same predicate as the Transaktioner inbox: Skatteverket status 'booked'
    // (upcoming charges have nothing to book), no verifikat, not ignored.
    const eqCalls = findCalls('skattekonto_transactions', 'eq')
    expect(eqCalls).toContainEqual(['status', 'booked'])
    expect(eqCalls).toContainEqual(['is_ignored', false])
    expect(findCall('skattekonto_transactions', 'is')).toEqual(['journal_entry_id', null])
  })

  it('soft-fails to 0 on query error', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(countUnbookedSkattekontoRows(supabase, COMPANY)).resolves.toBe(0)
  })
})

describe('countInboxDocuments', () => {
  it('counts only items whose document is still unlinked', async () => {
    enqueue({
      data: [
        { id: 'i1', document_id: 'd1' },
        { id: 'i2', document_id: 'd2' },
        { id: 'i3', document_id: 'd3' },
      ],
    })
    enqueue({ count: 2 }) // one of the three docs is already linked elsewhere
    await expect(countInboxDocuments(supabase, COMPANY)).resolves.toBe(2)
    expect(mockSupabase.from).toHaveBeenCalledWith('invoice_inbox_items')
    expect(mockSupabase.from).toHaveBeenCalledWith('document_attachments')
  })

  it('leaves out a receipt riding on its invoice and an open half whose other half is booked, as Behöver dig does', async () => {
    const companionIds = vi.fn().mockResolvedValue(new Set(['i2', 'i3']))
    enqueue({ data: [{ id: 'i1', document_id: 'd1' }, { id: 'i2', document_id: 'd2' }, { id: 'i3', document_id: 'd3' }, { id: 'i4', document_id: 'd4' }] })
    enqueue({ count: 2 })
    await expect(countInboxDocuments(supabase, COMPANY, { companionIds })).resolves.toBe(2)
    // Only the invoice and the lone item are asked about.
    expect(findCall('document_attachments', 'in')).toEqual(['id', ['d1', 'd4']])
    expect(companionIds).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: 'i1' })]))
  })

  it('counts every item when the pairing cannot be read', async () => {
    const companionIds = vi.fn().mockRejectedValue(new Error('boom'))
    enqueue({ data: [{ id: 'i1', document_id: 'd1' }, { id: 'i2', document_id: 'd2' }] })
    enqueue({ count: 2 })
    await expect(countInboxDocuments(supabase, COMPANY, { companionIds })).resolves.toBe(2)
  })

  it('returns 0 without a document query when no unconsumed items exist', async () => {
    enqueue({ data: [] })
    await expect(countInboxDocuments(supabase, COMPANY)).resolves.toBe(0)
    expect(mockSupabase.from).not.toHaveBeenCalledWith('document_attachments')
  })

  it('chunks the document id filter so large inboxes stay under URL limits', async () => {
    // 200 deduped ids → two .in() chunks of 150 + 50, counts summed.
    enqueue({
      data: Array.from({ length: 200 }, (_, i) => ({
        id: `item-${i}`,
        document_id: `doc-${i}`,
      })),
    })
    enqueue({ count: 140 })
    enqueue({ count: 45 })
    await expect(countInboxDocuments(supabase, COMPANY)).resolves.toBe(185)
    // 1 inbox query + 2 chunked document queries.
    expect(mockSupabase.from).toHaveBeenCalledTimes(3)
  })

  it('soft-fails to 0 on query error', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(countInboxDocuments(supabase, COMPANY)).resolves.toBe(0)
  })
})

describe('countVerifikatMissingDocument', () => {
  // Predicate semantics (needs-doc source types, current versions, waivers)
  // now live in the verifikat_without_documents RPC and are pinned by
  // tests/pg/document-surfaces-unification.pg.test.ts against real Postgres.
  // These tests cover only the delegation contract.
  it('delegates to the verifikat_without_documents RPC and returns its total', async () => {
    enqueue({ data: { ok: true, total_count: 3, verifikat: [] }, error: null })
    await expect(countVerifikatMissingDocument(supabase, COMPANY)).resolves.toBe(3)
    expect(mockSupabase.rpc).toHaveBeenCalledWith('verifikat_without_documents', {
      p_company_id: COMPANY,
      p_limit: 1,
      p_offset: 0,
    })
  })

  it('soft-fails to 0 when the RPC errors', async () => {
    enqueue({ data: null, error: { message: 'boom' } })
    await expect(countVerifikatMissingDocument(supabase, COMPANY)).resolves.toBe(0)
  })

  it('soft-fails to 0 on a not-ok envelope (tenant guard)', async () => {
    enqueue({ data: { ok: false, code: 'VERIFIKAT_WITHOUT_DOCUMENTS_FORBIDDEN' }, error: null })
    await expect(countVerifikatMissingDocument(supabase, COMPANY)).resolves.toBe(0)
  })
})

describe('Avräkningar rows', () => {
  it('counts the payouts and collected payments of the company that the page counts as waiting for a person', async () => {
    enqueue({ count: 2 })
    await expect(countCollectionSettlementsToBook(supabase, COMPANY)).resolves.toBe(2)
    expect(findCalls('collection_settlements', 'eq')).toEqual(expect.arrayContaining([['company_id', COMPANY]]))
    expect(findCalls('collection_settlements', 'in')).toEqual([['status', ['received', 'needs_mapping']]])
    enqueue({ count: 3 })
    await expect(countCollectedPaymentsToBook(supabase, COMPANY)).resolves.toBe(3)
    expect(findCalls('collection_collected_payments', 'eq')).toEqual(expect.arrayContaining([['company_id', COMPANY]]))
    expect(findCalls('collection_collected_payments', 'in')).toEqual([['status', ['pending', 'needs_review']]])
  })

  it('soft-fails to 0 on query error', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(countCollectionSettlementsToBook(supabase, COMPANY)).resolves.toBe(0)
    enqueue({ error: { message: 'boom' } })
    await expect(countCollectedPaymentsToBook(supabase, COMPANY)).resolves.toBe(0)
  })
})

describe('simple head counts', () => {
  it.each([
    ['countSupplierInvoicesAwaitingApproval', countSupplierInvoicesAwaitingApproval, 'supplier_invoices'],
    ['countDeadlinesNeedingAction', countDeadlinesNeedingAction, 'deadlines'],
    ['countPendingOperations', countPendingOperations, 'pending_operations'],
  ] as const)('%s returns the count and targets the right table', async (_name, fn, table) => {
    enqueue({ count: 3 })
    await expect(fn(supabase, COMPANY)).resolves.toBe(3)
    expect(mockSupabase.from).toHaveBeenCalledWith(table)
  })
})

function item(kind: 'open' | 'start' | 'approve_step', invoiceId: string, caseId: string | null = null) {
  return { kind, invoice_id: invoiceId, case_id: caseId }
}

describe('getOverdueInvoicesDue: one grouped row per company (crm#1084, accounted#19)', () => {
  const TODAY = '2026-10-13'
  const overdueRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'inv-1',
    invoice_number: 'F-1',
    customer_id: 'cust-1',
    status: 'sent',
    due_date: '2026-09-30',
    total: 1250,
    total_sek: 1250,
    remaining_amount: 1250,
    currency: 'SEK',
    ...overrides,
  })

  it('reads the Förfallna rows by the due date and the open remainder, never the stored status', async () => {
    enqueue({ data: [overdueRow()] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    await expect(getOverdueInvoicesDue(supabase, COMPANY, TODAY)).resolves.toMatchObject({ count: 1 })
    expect(findCalls('invoices', 'in')).toContainEqual(['status', ['sent', 'overdue', 'partially_paid']])
    expect(findCalls('invoices', 'eq')).toContainEqual(['company_id', COMPANY])
    expect(findCalls('invoices', 'eq')).toContainEqual(['document_type', 'invoice'])
    expect(findCalls('invoices', 'eq')).not.toContainEqual(['status', 'overdue'])
    expect(findCalls('invoices', 'is')).toContainEqual(['credited_invoice_id', null])
    expect(findCalls('invoices', 'lt')).toContainEqual(['due_date', TODAY])
    expect(findCalls('invoices', 'gt')).toContainEqual(['remaining_amount', 0])
    expect(mockSupabase.rpc).toHaveBeenCalledWith('collection_open_invoice_ids', { p_company_id: COMPANY })
    expect(mockSupabase.rpc).toHaveBeenCalledWith('collection_attention_case_ids', { p_company_id: COMPANY })
  })

  it('groups every overdue invoice into one item: count, amount still owed, oldest due date', async () => {
    enqueue({
      data: [
        overdueRow({ id: 'a', due_date: '2026-08-31', remaining_amount: 1000 }),
        overdueRow({ id: 'b', status: 'partially_paid', due_date: '2026-09-15', total: 2000, total_sek: 2000, remaining_amount: 500.25 }),
        overdueRow({ id: 'c', due_date: '2026-10-12', remaining_amount: 99.5 }),
      ],
    })
    enqueue({ data: [] })
    enqueue({ data: [] })
    await expect(getOverdueInvoicesDue(supabase, COMPANY, TODAY)).resolves.toEqual({
      count: 3,
      remaining_sek: 1599.75,
      unconverted_count: 0,
      oldest_due_date: '2026-08-31',
      oldest_days_overdue: 43,
    })
  })

  it('leaves out the invoices "Hos inkasso" lists: an open case past delivery, or one a person must look at', async () => {
    enqueue({
      data: [
        overdueRow({ id: 'with-provider' }),
        overdueRow({ id: 'delivered-only' }),
        overdueRow({ id: 'refused-handover' }),
        overdueRow({ id: 'plain' }),
      ],
    })
    enqueue({
      data: [
        { invoice_id: 'with-provider', in_collection: true },
        // The provider only delivered the invoice: still the user's to follow up.
        { invoice_id: 'delivered-only', in_collection: false },
      ],
    })
    enqueue({ data: [{ invoice_id: 'refused-handover', reason: 'submission_failed' }] })
    const group = await getOverdueInvoicesDue(supabase, COMPANY, TODAY)
    expect(group).toMatchObject({ count: 2, remaining_sek: 2500 })
  })

  it('is null when nothing is overdue, or only invoices at the collections provider', async () => {
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    await expect(getOverdueInvoicesDue(supabase, COMPANY, TODAY)).resolves.toBeNull()

    enqueue({ data: [overdueRow({ id: 'x' })] })
    enqueue({ data: [{ invoice_id: 'x', in_collection: true }] })
    enqueue({ data: [] })
    await expect(getOverdueInvoicesDue(supabase, COMPANY, TODAY)).resolves.toBeNull()
  })

  it('a failed collections read leaves nothing out: shown, never hidden', async () => {
    enqueue({ data: [overdueRow()] })
    enqueue({ data: null, error: { message: 'boom' } })
    enqueue({ data: null, error: { message: 'boom' } })
    await expect(getOverdueInvoicesDue(supabase, COMPANY, TODAY)).resolves.toMatchObject({ count: 1 })
  })

  it('soft-fails to null when the invoice read fails', async () => {
    enqueue({ data: null, error: { message: 'boom' } })
    enqueue({ data: [] })
    enqueue({ data: [] })
    await expect(getOverdueInvoicesDue(supabase, COMPANY, TODAY)).resolves.toBeNull()
  })
})

describe('summarizeOverdueInvoices', () => {
  const TODAY = '2026-10-13'
  const row = (overrides: Record<string, unknown>) =>
    ({ due_date: '2026-10-01', total: 100, total_sek: 100, remaining_amount: 100, currency: 'SEK', ...overrides }) as never

  it('sums a foreign invoice at its own SEK amount, the remainder pro rata', () => {
    expect(
      summarizeOverdueInvoices(
        [row({ currency: 'EUR', total: 200, total_sek: 2300, remaining_amount: 50 }), row({ remaining_amount: 10.1 })],
        TODAY,
      ),
    ).toMatchObject({ count: 2, remaining_sek: 585.1, unconverted_count: 0 })
  })

  it('counts a foreign invoice without a SEK amount instead of mixing currencies into the sum', () => {
    expect(
      summarizeOverdueInvoices([row({ currency: 'USD', total_sek: null, remaining_amount: 70 }), row({})], TODAY),
    ).toMatchObject({ count: 2, remaining_sek: 100, unconverted_count: 1 })
  })

  it('is null for no rows', () => {
    expect(summarizeOverdueInvoices([], TODAY)).toBeNull()
  })
})

describe('countPendingOperations and the collections batch', () => {
  it('leaves the daily batches (collections, reminders) to their own rows', async () => {
    enqueue({ count: 2 })
    await expect(countPendingOperations(supabase, COMPANY)).resolves.toBe(2)
    expect(findCall('pending_operations', 'not')).toEqual(['operation_type', 'in', '(collections_daily_batch,reminder_daily_batch)'])
    expect(findCall('pending_operations', 'neq')).toEqual(['actor_type', 'system'])
  })

  it('counts the items of the pending batch less the removed ones', async () => {
    enqueue({ data: [], error: null })
    enqueue({ data: [{ id: 'op-1', params: { items: [item('open', 'i1'), item('open', 'i2'), item('start', 'i3')] } }], error: null })
    enqueue({ data: [{ invoice_id: 'i3', kind: 'start' }], error: null })
    await expect(countCollectionDecisionsAndBatch(supabase, COMPANY)).resolves.toEqual({ decision: 0, batchReady: 2 })
    expect(findCalls('collection_batch_removals', 'eq')).toContainEqual(['pending_operation_id', 'op-1'])
    expect(findCalls('pending_operations', 'eq')).toContainEqual(['operation_type', 'collections_daily_batch'])
    expect(findCalls('collection_cases', 'eq')).toContainEqual(['stage', 'awaiting_decision'])
  })

  it('counts a decision the batch proposes once, in the batch row', async () => {
    enqueue({ data: [{ id: 'case-1' }, { id: 'case-2' }], error: null })
    enqueue({ data: [{ id: 'op-1', params: { items: [item('open', 'i1'), item('approve_step', 'i9', 'case-1')] } }], error: null })
    enqueue({ data: [], error: null })
    await expect(countCollectionDecisionsAndBatch(supabase, COMPANY)).resolves.toEqual({ decision: 1, batchReady: 2 })
  })

  it('gives a decision taken out of the batch back to the decision row', async () => {
    enqueue({ data: [{ id: 'case-1' }], error: null })
    enqueue({ data: [{ id: 'op-1', params: { items: [item('open', 'i1'), item('approve_step', 'i9', 'case-1')] } }], error: null })
    enqueue({ data: [{ invoice_id: 'i9', kind: 'approve_step' }], error: null })
    await expect(countCollectionDecisionsAndBatch(supabase, COMPANY)).resolves.toEqual({ decision: 1, batchReady: 1 })
  })

  it('counts decisions alone without a pending batch, and soft-fails each part', async () => {
    enqueue({ data: [{ id: 'case-1' }], error: null })
    enqueue({ data: [], error: null })
    await expect(countCollectionDecisionsAndBatch(supabase, COMPANY)).resolves.toEqual({ decision: 1, batchReady: 0 })
    enqueue({ data: null, error: { message: 'boom' } })
    enqueue({ data: null, error: { message: 'boom' } })
    await expect(countCollectionDecisionsAndBatch(supabase, COMPANY)).resolves.toEqual({ decision: 0, batchReady: 0 })
  })
})

describe('countReminderBatchReady', () => {
  const reminder = (invoiceId: string) => ({ kind: 'reminder', invoice_id: invoiceId, level: 1, bank: 'fresh' })

  it('counts the reminders of the pending batch less the ones taken out', async () => {
    enqueue({ data: [{ id: 'op-1', params: { items: [reminder('i1'), reminder('i2'), reminder('i3')] } }], error: null })
    enqueue({ data: [{ invoice_id: 'i3' }], error: null })
    await expect(countReminderBatchReady(supabase, COMPANY)).resolves.toBe(2)
    expect(findCalls('pending_operations', 'eq')).toContainEqual(['operation_type', 'reminder_daily_batch'])
    expect(findCalls('collection_batch_removals', 'eq')).toContainEqual(['kind', 'reminder'])
    expect(mockSupabase.from).not.toHaveBeenCalledWith('event_log')
  })

  it('counts nothing without a pending batch, and soft-fails to 0', async () => {
    enqueue({ data: [], error: null })
    await expect(countReminderBatchReady(supabase, COMPANY)).resolves.toBe(0)
    enqueue({ data: null, error: { message: 'boom' } })
    await expect(countReminderBatchReady(supabase, COMPANY)).resolves.toBe(0)
    enqueue({ data: [{ id: 'op-1', params: { items: [reminder('i1')] } }], error: null })
    enqueue({ data: null, error: { message: 'denied' } })
    await expect(countReminderBatchReady(supabase, COMPANY)).resolves.toBe(0)
  })
})

// Issue #1259: the badge delegates to listSuggestedMatches so it can never
// claim a number the list refuses to render. A raw head count over the hint
// columns counted pointers at invoices settled by a different transaction.
describe('countSuggestedMatches', () => {
  it('counts only hints whose candidate is still matchable', async () => {
    enqueue({
      data: [
        {
          id: 'tx-1',
          date: '2026-06-01',
          description: 'ICA',
          amount: 423,
          currency: 'SEK',
          potential_invoice_id: 'inv-1',
          potential_supplier_invoice_id: null,
        },
        {
          id: 'tx-2',
          date: '2026-05-30',
          description: 'TELIA',
          amount: -549,
          currency: 'SEK',
          potential_invoice_id: null,
          potential_supplier_invoice_id: 'sinv-paid',
        },
      ],
    })
    // inv-1 is still open; sinv-paid was settled by another transaction, so the
    // status/remaining filters exclude it server-side.
    enqueue({
      data: [
        { id: 'inv-1', invoice_number: 'F-1', total: 423, customer: { name: 'Kund AB' } },
      ],
    })
    enqueue({ data: [] })

    await expect(countSuggestedMatches(supabase, COMPANY)).resolves.toBe(1)
    expect(mockSupabase.from).toHaveBeenCalledWith('transactions')
  })

  it('returns 0 when the only hint points at an invoice settled elsewhere', async () => {
    enqueue({
      data: [
        {
          id: 'tx-1',
          date: '2026-06-01',
          description: 'MONTHLY FEE',
          amount: -549,
          currency: 'SEK',
          potential_invoice_id: null,
          potential_supplier_invoice_id: 'sinv-paid',
        },
      ],
    })
    enqueue({ data: [] })
    await expect(countSuggestedMatches(supabase, COMPANY)).resolves.toBe(0)
  })

  it('soft-fails to 0 on query error', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(countSuggestedMatches(supabase, COMPANY)).resolves.toBe(0)
  })

  it('clamps the scan so the badge cannot walk an unbounded hint set', async () => {
    enqueue({ data: [] })
    await countSuggestedMatches(supabase, COMPANY)
    expect(findCall('transactions', 'limit')).toEqual([200])
  })
})

describe('listSuggestedMatches', () => {
  it('maps a ROT/RUT payout hint to a confirmable row pointing at the begäran', async () => {
    enqueue({
      data: [
        {
          id: 'tx-skv',
          date: '2026-07-10',
          description: 'Skatteverket',
          amount: 3000,
          currency: 'SEK',
          potential_invoice_id: null,
          potential_supplier_invoice_id: null,
          potential_rot_rut_payout_request_id: 'rr-1',
        },
      ],
    })
    // Only the payout lookup runs: the invoice / supplier id lists are empty.
    enqueue({
      data: [{ id: 'rr-1', name: 'ROT 2026-07', requested_total: '3000.00', decided_total: null }],
    })

    const matches = await listSuggestedMatches(supabase, COMPANY)
    expect(matches).toEqual([
      {
        transaction_id: 'tx-skv',
        transaction_date: '2026-07-10',
        transaction_description: 'Skatteverket',
        transaction_amount: 3000,
        transaction_currency: 'SEK',
        kind: 'rot_rut_payout',
        candidate_id: 'rr-1',
        candidate_number: 'ROT 2026-07',
        counterparty_name: 'Skatteverket',
        candidate_total: 3000,
      },
    ])
    const lookup = findCall('rot_rut_payout_requests', 'is')
    expect(lookup).toEqual(['settlement_journal_entry_id', null])
  })

  it('offers a bundled Skatteverket payout (sum of several begäran) with request_ids', async () => {
    enqueue({ data: [] }) // no hinted rows
    enqueue({ data: [] }) // expense_claims: nobody is owed
    enqueue({
      data: [
        { id: 'rr-1', name: 'ROT 2026-07', deduction_type: 'rot', status: 'submitted', requested_total: '3000.00', decided_total: null, settlement_journal_entry_id: null },
        { id: 'rr-2', name: 'RUT 2026-07', deduction_type: 'rut', status: 'submitted', requested_total: '2250.00', decided_total: null, settlement_journal_entry_id: null },
      ],
    })
    enqueue({
      data: [
        {
          id: 'tx-bundle',
          date: '2026-07-12',
          description: 'SKATTEVERKET',
          merchant_name: null,
          amount: 5250,
          currency: 'SEK',
          is_business: null,
          journal_entry_id: null,
          potential_rot_rut_payout_request_id: null,
        },
        {
          id: 'tx-other',
          date: '2026-07-11',
          description: 'Kund AB',
          merchant_name: null,
          amount: 4000,
          currency: 'SEK',
          is_business: null,
          journal_entry_id: null,
          potential_rot_rut_payout_request_id: null,
        },
      ],
    })

    const matches = await listSuggestedMatches(supabase, COMPANY)
    expect(matches).toEqual([
      {
        transaction_id: 'tx-bundle',
        transaction_date: '2026-07-12',
        transaction_description: 'SKATTEVERKET',
        transaction_amount: 5250,
        transaction_currency: 'SEK',
        kind: 'rot_rut_payout',
        candidate_id: 'rr-1',
        candidate_number: 'ROT 2026-07 + RUT 2026-07',
        counterparty_name: 'Skatteverket',
        candidate_total: 5250,
        request_ids: ['rr-1', 'rr-2'],
      },
    ])
    // The scan is bounded to the pool's amount range and to unbooked, unreviewed rows.
    const gte = findCall('transactions', 'gte')
    const lte = findCall('transactions', 'lte')
    expect(gte).toEqual(['amount', 2250])
    expect(lte).toEqual(['amount', 5250])
  })

  it('returns no bundle suggestions for a company with fewer than two open begäran', async () => {
    enqueue({
      data: [
        { id: 'rr-1', name: 'ROT 2026-07', deduction_type: 'rot', status: 'submitted', requested_total: 3000, decided_total: null, settlement_journal_entry_id: null },
      ],
    })
    await expect(listRotRutPayoutSetSuggestions(supabase, COMPANY)).resolves.toEqual([])
    expect(findCalls('transactions', 'select')).toEqual([])
  })

  it('maps invoice and supplier-invoice hints to confirmable rows', async () => {
    enqueue({
      data: [
        {
          id: 'tx-1',
          date: '2026-06-01',
          description: 'ICA BANKEN',
          amount: 423,
          currency: 'SEK',
          potential_invoice_id: 'inv-1',
          potential_supplier_invoice_id: null,
        },
        {
          id: 'tx-2',
          date: '2026-05-30',
          description: 'TELIA',
          amount: -549,
          currency: 'SEK',
          potential_invoice_id: null,
          potential_supplier_invoice_id: 'sinv-1',
        },
      ],
    })
    enqueue({
      data: [
        { id: 'inv-1', invoice_number: 'F-2026-12', total: 423, customer: { name: 'Kund AB' } },
      ],
    })
    enqueue({
      data: [
        {
          id: 'sinv-1',
          supplier_invoice_number: 'TEL-99',
          total: 549,
          supplier: { name: 'Telia AB' },
        },
      ],
    })

    const matches = await listSuggestedMatches(supabase, COMPANY)
    expect(matches).toEqual([
      {
        transaction_id: 'tx-1',
        transaction_date: '2026-06-01',
        transaction_description: 'ICA BANKEN',
        transaction_amount: 423,
        transaction_currency: 'SEK',
        kind: 'invoice',
        candidate_id: 'inv-1',
        candidate_number: 'F-2026-12',
        counterparty_name: 'Kund AB',
        candidate_total: 423,
      },
      {
        transaction_id: 'tx-2',
        transaction_date: '2026-05-30',
        transaction_description: 'TELIA',
        transaction_amount: -549,
        transaction_currency: 'SEK',
        kind: 'supplier_invoice',
        candidate_id: 'sinv-1',
        candidate_number: 'TEL-99',
        counterparty_name: 'Telia AB',
        candidate_total: 549,
      },
    ])
  })

  it('drops rows whose hinted candidate no longer exists', async () => {
    enqueue({
      data: [
        {
          id: 'tx-1',
          date: '2026-06-01',
          description: 'X',
          amount: 100,
          currency: 'SEK',
          potential_invoice_id: 'inv-gone',
          potential_supplier_invoice_id: null,
        },
      ],
    })
    enqueue({ data: [] }) // invoice lookup finds nothing (deleted candidate)
    await expect(listSuggestedMatches(supabase, COMPANY)).resolves.toEqual([])
  })

  it('returns [] on transaction query error', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(listSuggestedMatches(supabase, COMPANY)).resolves.toEqual([])
  })

  // Regression: the hint columns are written once and never revisited, so an
  // invoice paid off by a DIFFERENT transaction leaves a stale pointer. The
  // candidate lookup must revalidate instead of trusting it, or the worklist
  // renders a one-click confirm row whose endpoint can only answer
  // ALREADY_PAID.
  it('revalidates hinted candidates against the matchable statuses', async () => {
    enqueue({
      data: [
        {
          id: 'tx-1',
          date: '2026-06-01',
          description: 'X',
          amount: 100,
          currency: 'SEK',
          potential_invoice_id: 'inv-1',
          potential_supplier_invoice_id: null,
        },
        {
          id: 'tx-2',
          date: '2026-06-02',
          description: 'Y',
          amount: -100,
          currency: 'SEK',
          potential_invoice_id: null,
          potential_supplier_invoice_id: 'sinv-1',
        },
      ],
    })
    enqueue({ data: [] })
    enqueue({ data: [] })

    await listSuggestedMatches(supabase, COMPANY)

    // Both revalidation conditions, not just the id filter: findCall returns
    // only the FIRST .in() per table, which is the id one, so the status
    // filter needs findCalls to be covered at all. The third call is the
    // open pool the several-invoice search reads, under the same statuses.
    expect(findCalls('invoices', 'in')).toEqual([
      ['id', ['inv-1']],
      ['status', [...MATCHABLE_INVOICE_STATUSES]],
      ['status', [...MATCHABLE_INVOICE_STATUSES]],
    ])
    expect(findCall('invoices', 'gt')).toEqual(['remaining_amount', 0])
    expect(findCalls('supplier_invoices', 'in')).toEqual([
      ['id', ['sinv-1']],
      ['status', [...MATCHABLE_SUPPLIER_INVOICE_STATUSES]],
      ['status', [...MATCHABLE_SUPPLIER_INVOICE_STATUSES]],
    ])
    expect(findCall('supplier_invoices', 'gt')).toEqual(['remaining_amount', 0])
  })

  it('drops a hint whose invoice has since been settled elsewhere', async () => {
    enqueue({
      data: [
        {
          id: 'tx-1',
          date: '2026-06-01',
          description: 'MONTHLY FEE',
          amount: -549,
          currency: 'SEK',
          potential_invoice_id: null,
          potential_supplier_invoice_id: 'sinv-paid',
        },
      ],
    })
    enqueue({ data: [] })
    // The status/remaining filters exclude the settled invoice server-side, so
    // the lookup comes back empty and the row must not be offered.
    enqueue({ data: [] })

    await expect(listSuggestedMatches(supabase, COMPANY)).resolves.toEqual([])
  })

  // The badge scans up to 200 hints (SUGGESTED_MATCH_SCAN_CAP), past the 150
  // ids per .in() that countInboxDocuments already chunks for: PostgREST puts
  // them in the GET query string, and a 414 would come back as a silent 0.
  it('chunks the candidate id list at 150 ids per lookup', async () => {
    const txRows = Array.from({ length: 151 }, (_, i) => ({
      id: `tx-${i}`,
      date: '2026-06-01',
      description: 'X',
      amount: 100,
      currency: 'SEK',
      potential_invoice_id: `inv-${i}`,
      potential_supplier_invoice_id: null,
    }))
    enqueue({ data: txRows })
    enqueue({ data: [] }) // chunk 1
    enqueue({ data: [] }) // chunk 2

    await listSuggestedMatches(supabase, COMPANY, 200)

    const idFilters = findCalls('invoices', 'in').filter(([col]) => col === 'id')
    expect(idFilters).toHaveLength(2)
    expect((idFilters[0][1] as string[]).length).toBe(150)
    expect((idFilters[1][1] as string[]).length).toBe(1)
  })

  // Previously the candidate results were consumed without checking .error, so
  // a 414 / 500 / RLS change yielded empty maps, an empty list and a zero badge
  // with nothing logged.
  it('returns [] and logs with companyId when a candidate lookup fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    enqueue({
      data: [
        {
          id: 'tx-1',
          date: '2026-06-01',
          description: 'X',
          amount: 100,
          currency: 'SEK',
          potential_invoice_id: 'inv-1',
          potential_supplier_invoice_id: null,
        },
      ],
    })
    enqueue({ error: { message: 'boom' } })

    await expect(listSuggestedMatches(supabase, COMPANY)).resolves.toEqual([])
    expect(consoleError).toHaveBeenCalled()
    const logged = consoleError.mock.calls.map((c) => String(c[0])).join('\n')
    expect(logged).toContain('candidate lookup failed')
    expect(logged).toContain(COMPANY)
    consoleError.mockRestore()
  })

  it('logs the tenant with the transaction query failure too', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    enqueue({ error: { message: 'boom' } })
    await expect(listSuggestedMatches(supabase, COMPANY)).resolves.toEqual([])
    expect(String(consoleError.mock.calls[0]?.[0])).toContain(COMPANY)
    consoleError.mockRestore()
  })
})

describe('countReconciliationDue', () => {
  const CASH_A = '11111111-1111-4111-8111-111111111111'
  const CASH_B = '22222222-2222-4222-8222-222222222222'
  const CASH_B_DUP = '33333333-3333-4333-8333-333333333333'
  // Today 2026-08-23 → previous month end 2026-07-31.
  const TODAY = new Date('2026-08-23T10:00:00Z')

  it('is zero for a company that never signed anything off (adoption gate)', async () => {
    enqueue({ data: [] })
    await expect(countReconciliationDue(supabase, COMPANY, TODAY)).resolves.toBe(0)
    expect(mockSupabase.from).toHaveBeenCalledTimes(1)
    expect(mockSupabase.from).toHaveBeenCalledWith('account_reconciliations')
  })

  it('counts reconcilable accounts without an active sign-off through the previous month end', async () => {
    enqueue({
      data: [
        // bank A signed through July: covered.
        { account_key: `bank:${CASH_A}`, through_date: '2026-07-31', reopened_at: null },
        // skattekonto signed through June only: due.
        { account_key: 'skattekonto', through_date: '2026-06-30', reopened_at: null },
        // bank B signed through July but reopened: due.
        { account_key: `bank:${CASH_B}`, through_date: '2026-07-31', reopened_at: '2026-08-02T08:00:00Z' },
      ],
    })
    enqueue({
      data: [
        { id: CASH_A, iban: 'SE1', currency: 'SEK', updated_at: '2026-08-01' },
        { id: CASH_B, iban: 'SE2', currency: 'SEK', updated_at: '2026-08-01' },
        // Reconnect duplicate of B (same IBAN + currency): counts once.
        { id: CASH_B_DUP, iban: 'SE2', currency: 'SEK', updated_at: '2026-07-01' },
      ],
    })
    enqueue({ count: 12 })
    // Due: skattekonto + bank B (deduplicated) = 2.
    await expect(countReconciliationDue(supabase, COMPANY, TODAY)).resolves.toBe(2)
    expect(mockSupabase.from).toHaveBeenCalledWith('cash_accounts')
    expect(mockSupabase.from).toHaveBeenCalledWith('skattekonto_transactions')
  })

  it('ignores the skattekonto when it has no rows', async () => {
    enqueue({ data: [{ account_key: `bank:${CASH_A}`, through_date: '2026-05-31', reopened_at: null }] })
    enqueue({ data: [{ id: CASH_A, iban: null, currency: 'SEK', updated_at: null }] })
    enqueue({ count: 0 })
    await expect(countReconciliationDue(supabase, COMPANY, TODAY)).resolves.toBe(1)
  })

  it('soft-fails to 0 on a query error', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(countReconciliationDue(supabase, COMPANY, TODAY)).resolves.toBe(0)
  })
})

describe('listExpensePayoutsDue', () => {
  it('groups registered claims into one item per person, oldest debt first', async () => {
    enqueue({
      data: [
        { id: 'c1', employee_id: null, claimant_name: 'Jakob', liability_account: '2893', amount_sek: '1240.00', expense_date: '2026-09-03' },
        { id: 'c2', employee_id: 'emp-1', claimant_name: 'Anna Berg', liability_account: '2820', amount_sek: 1196, expense_date: '2026-09-02' },
        { id: 'c3', employee_id: 'emp-1', claimant_name: 'Anna Berg', liability_account: '2820', amount_sek: 400, expense_date: '2026-09-06' },
        // Same owner name twice: one person, one transfer.
        { id: 'c4', employee_id: null, claimant_name: 'Jakob', liability_account: '2893', amount_sek: 0.1, expense_date: '2026-09-07' },
      ],
    })
    const people = await listExpensePayoutsDue(supabase, COMPANY)
    expect(mockSupabase.from).toHaveBeenCalledWith('expense_claims')
    expect(findCalls('expense_claims', 'eq')).toContainEqual(['status', 'registered'])
    expect(people).toEqual([
      {
        key: 'emp-1',
        employee_id: 'emp-1',
        claimant_name: 'Anna Berg',
        liability_account: '2820',
        claim_count: 2,
        claim_ids: ['c2', 'c3'],
        total_sek: 1596,
        oldest_expense_date: '2026-09-02',
      },
      {
        key: 'owner:jakob',
        employee_id: null,
        claimant_name: 'Jakob',
        liability_account: '2893',
        claim_count: 2,
        claim_ids: ['c1', 'c4'],
        // 1240 + 0.1 in öre-safe arithmetic, never 1240.1000000000001.
        total_sek: 1240.1,
        oldest_expense_date: '2026-09-03',
      },
    ])
  })

  it('soft-fails to an empty list on query error', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(listExpensePayoutsDue(supabase, COMPANY)).resolves.toEqual([])
  })
})

describe('listExpensePayoutSuggestions', () => {
  it('pairs an unbooked SEK outflow with the person whose open total it equals', async () => {
    // Open claims: Anna 1 596 (two receipts), owner 1 240.
    enqueue({
      data: [
        { id: 'c2', employee_id: 'emp-1', claimant_name: 'Anna Berg', liability_account: '2820', amount_sek: 1196, expense_date: '2026-09-02' },
        { id: 'c3', employee_id: 'emp-1', claimant_name: 'Anna Berg', liability_account: '2820', amount_sek: 400, expense_date: '2026-09-06' },
        { id: 'c1', employee_id: null, claimant_name: 'Jakob', liability_account: '2893', amount_sek: 1240, expense_date: '2026-09-03' },
      ],
    })
    // Unbooked outflows: one repays Anna exactly, one is a different amount.
    enqueue({
      data: [
        { id: 'tx-1', date: '2026-09-10', description: 'Överföring Anna Berg', amount: -1596, currency: 'SEK', is_business: null, journal_entry_id: null },
        { id: 'tx-2', date: '2026-09-10', description: 'Telia', amount: -2450, currency: 'SEK', is_business: null, journal_entry_id: null },
      ],
    })
    const out = await listExpensePayoutSuggestions(supabase, COMPANY)
    expect(findCalls('transactions', 'in')).toContainEqual(['amount', [-1596, -1240]])
    expect(out).toEqual([
      {
        transaction_id: 'tx-1',
        transaction_date: '2026-09-10',
        transaction_description: 'Överföring Anna Berg',
        transaction_amount: -1596,
        transaction_currency: 'SEK',
        kind: 'expense_payout',
        candidate_id: 'emp-1',
        candidate_number: null,
        counterparty_name: 'Anna Berg',
        candidate_total: 1596,
        claim_ids: ['c2', 'c3'],
      },
    ])
  })

  it('does nothing for a company without open claims', async () => {
    enqueue({ data: [] })
    await expect(listExpensePayoutSuggestions(supabase, COMPANY)).resolves.toEqual([])
    expect(mockSupabase.from).not.toHaveBeenCalledWith('transactions')
  })
})

describe('listSkattekontoPaymentDue', () => {
  const TODAY = '2026-09-08'
  const company = { org_number: '559547-0021', entity_type: 'aktiebolag' }
  // Queue order follows the function's `from` calls: upcoming rows and the
  // balance snapshot (one parallel wave), then the company's bank payments to
  // the skattekonto, then the company, then the OCR resolver's own snapshot
  // read.
  const snapshot = (saldoSkatteverket: number) => ({
    data: { value: { saldo: { saldoSkatteverket }, fetchedAt: 1757300000000 } },
  })

  it('returns null when Skatteverket has no upcoming charge', async () => {
    enqueue({ data: [] })
    enqueue({ data: null })
    await expect(listSkattekontoPaymentDue(supabase, COMPANY, TODAY)).resolves.toBeNull()
    expect(mockSupabase.from).toHaveBeenCalledWith('skattekonto_transactions')
    expect(findCalls('skattekonto_transactions', 'eq')).toContainEqual(['status', 'upcoming'])
    // Ignored rows are not filtered out: Skatteverket draws them regardless.
    expect(findCalls('skattekonto_transactions', 'eq')).not.toContainEqual(['is_ignored', false])
  })

  it('returns null when the synced saldo covers the next charge', async () => {
    enqueue({
      data: [
        { transaktionsdatum: '2026-09-12', forfallodatum: '2026-09-12', belopp_skatteverket: -12000 },
        { transaktionsdatum: '2026-09-12', forfallodatum: '2026-09-12', belopp_skatteverket: -3000 },
      ],
    })
    enqueue(snapshot(15000))
    await expect(listSkattekontoPaymentDue(supabase, COMPANY, TODAY)).resolves.toBeNull()
    // No company or OCR read once nothing has to be paid in.
    expect(mockSupabase.from).not.toHaveBeenCalledWith('companies')
  })

  it('reports the shortfall on the earliest due date with bankgiro and OCR', async () => {
    enqueue({
      data: [
        // A later charge: not part of the next payment.
        { transaktionsdatum: '2026-10-12', forfallodatum: '2026-10-12', belopp_skatteverket: -9000 },
        { transaktionsdatum: '2026-09-12', forfallodatum: '2026-09-12', belopp_skatteverket: '-12000.50' },
        { transaktionsdatum: '2026-09-12', forfallodatum: '2026-09-12', belopp_skatteverket: -3000 },
        // Already drawn: a due date before today belongs to book_skattekonto.
        { transaktionsdatum: '2026-09-01', forfallodatum: '2026-09-01', belopp_skatteverket: -500 },
      ],
    })
    enqueue(snapshot(4000.25))
    enqueue({ data: [] })
    enqueue({ data: company })
    // OCR resolver: no reported OCR in the snapshot, so it is derived.
    enqueue({ data: null })
    await expect(listSkattekontoPaymentDue(supabase, COMPANY, TODAY)).resolves.toEqual({
      due: '2026-09-12',
      charge: 15000.5,
      balance: 4000.25,
      amount: 11000.25,
      count: 2,
      ocr: '1655954700217',
      bankgiro: '5050-1055',
    })
  })

  it('shows the full charge when no balance snapshot exists', async () => {
    enqueue({
      data: [{ transaktionsdatum: '2026-09-12', forfallodatum: null, belopp_skatteverket: -2500 }],
    })
    enqueue({ data: null })
    enqueue({ data: [] })
    enqueue({ data: company })
    enqueue({ data: null })
    const due = await listSkattekontoPaymentDue(supabase, COMPANY, TODAY)
    expect(due).toMatchObject({ due: '2026-09-12', charge: 2500, balance: null, amount: 2500, count: 1 })
  })

  it('adds a negative saldo (a debt) to the amount to pay in', async () => {
    enqueue({
      data: [{ transaktionsdatum: '2026-09-12', forfallodatum: '2026-09-12', belopp_skatteverket: -1000 }],
    })
    enqueue(snapshot(-250))
    enqueue({ data: [] })
    enqueue({ data: company })
    enqueue({ data: null })
    const due = await listSkattekontoPaymentDue(supabase, COMPANY, TODAY)
    expect(due).toMatchObject({ charge: 1000, balance: -250, amount: 1250 })
  })

  it('keeps the row without an OCR when the company has no org number', async () => {
    enqueue({
      data: [{ transaktionsdatum: '2026-09-12', forfallodatum: '2026-09-12', belopp_skatteverket: -1000 }],
    })
    enqueue({ data: null })
    enqueue({ data: [] })
    enqueue({ data: { org_number: null, entity_type: 'aktiebolag' } })
    const due = await listSkattekontoPaymentDue(supabase, COMPANY, TODAY)
    expect(due).toMatchObject({ amount: 1000, ocr: null, bankgiro: '5050-1055' })
  })

  it('soft-fails to null on query error', async () => {
    enqueue({ error: { message: 'boom' } })
    enqueue({ data: null })
    await expect(listSkattekontoPaymentDue(supabase, COMPANY, TODAY)).resolves.toBeNull()
  })

  it('counts 1 when a payment is due and 0 otherwise', async () => {
    // Pin "today" like the list tests above: the charge below fell due on
    // 2026-09-12, and reading the real clock made this test expire on 09-13.
    enqueue({
      data: [{ transaktionsdatum: '2026-09-12', forfallodatum: '2026-09-12', belopp_skatteverket: -1000 }],
    })
    enqueue({ data: null })
    enqueue({ data: [] })
    enqueue({ data: company })
    enqueue({ data: null })
    await expect(countSkattekontoPaymentDue(supabase, COMPANY, TODAY)).resolves.toBe(1)
    enqueue({ data: [] })
    enqueue({ data: null })
    await expect(countSkattekontoPaymentDue(supabase, COMPANY, TODAY)).resolves.toBe(0)
  })

  it('subtracts bank payments to the skattekonto on their way, and executed ones the saldo cannot show yet', async () => {
    enqueue({
      data: [{ transaktionsdatum: '2026-09-12', forfallodatum: '2026-09-12', belopp_skatteverket: -15000 }],
    })
    // Fetched 2025-09-08T02:53:20Z.
    enqueue(snapshot(4000))
    enqueue({
      data: [
        { amount: '3000.25', status: 'awaiting_signature', executed_at: null },
        { amount: 1000, status: 'approved', executed_at: null },
        // Executed after the saldo was fetched: not in the saldo yet.
        { amount: 2000, status: 'executed', executed_at: '2025-09-08T09:00:00Z' },
        // Executed before it: the saldo already holds it.
        { amount: 500, status: 'executed', executed_at: '2025-09-07T09:00:00Z' },
      ],
    })
    enqueue({ data: company })
    enqueue({ data: null })
    const due = await listSkattekontoPaymentDue(supabase, COMPANY, TODAY)
    expect(due).toMatchObject({ charge: 15000, balance: 4000, amount: 4999.75 })
    expect(findCalls('payment_orders', 'eq')).toContainEqual(['purpose', 'skattekonto'])
    expect(findCall('payment_orders', 'in')).toEqual([
      'status',
      ['approved', 'submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted', 'executed'],
    ])
  })

  it('never asks again for a charge a bank payment on its way covers', async () => {
    enqueue({
      data: [{ transaktionsdatum: '2026-09-12', forfallodatum: '2026-09-12', belopp_skatteverket: -1000 }],
    })
    enqueue(snapshot(250))
    enqueue({ data: [{ amount: 750, status: 'submitted', executed_at: null }] })
    await expect(listSkattekontoPaymentDue(supabase, COMPANY, TODAY)).resolves.toBeNull()
    expect(mockSupabase.from).not.toHaveBeenCalledWith('companies')
  })

  it('without a snapshot counts the payments on their way but no executed one', async () => {
    enqueue({
      data: [{ transaktionsdatum: '2026-09-12', forfallodatum: '2026-09-12', belopp_skatteverket: -2500 }],
    })
    enqueue({ data: null })
    enqueue({
      data: [
        { amount: 1000, status: 'accepted', executed_at: null },
        { amount: 2500, status: 'executed', executed_at: '2026-09-07T09:00:00Z' },
      ],
    })
    enqueue({ data: company })
    enqueue({ data: null })
    const due = await listSkattekontoPaymentDue(supabase, COMPANY, TODAY)
    expect(due).toMatchObject({ charge: 2500, balance: null, amount: 1500 })
  })

  it('keeps the whole shortfall when the payments cannot be read', async () => {
    enqueue({
      data: [{ transaktionsdatum: '2026-09-12', forfallodatum: '2026-09-12', belopp_skatteverket: -1000 }],
    })
    enqueue(snapshot(0))
    enqueue({ error: { message: 'boom' } })
    enqueue({ data: company })
    enqueue({ data: null })
    const due = await listSkattekontoPaymentDue(supabase, COMPANY, TODAY)
    expect(due).toMatchObject({ amount: 1000 })
  })
})

describe('countUnclassifiedDocuments', () => {
  beforeEach(() => reset())

  it('asks only about documents uploaded in the last REVIEW_RECENT_DAYS days: typed history is not a to-do', async () => {
    enqueue({ count: 2 })
    expect(await countUnclassifiedDocuments(supabase, COMPANY)).toBe(2)
    const since = findCall('document_classifications', 'gte') as [string, string] | undefined
    expect(since?.[0]).toBe('document_attachments.created_at')
    const days = (Date.now() - new Date(since![1]).getTime()) / 86_400_000
    expect(Math.round(days)).toBe(REVIEW_RECENT_DAYS)
    expect(findCalls('document_classifications', 'is')).toEqual(expect.arrayContaining([['document_attachments.journal_entry_id', null]]))
  })
})


describe('countFailedPeppolDeliveries', () => {
  beforeEach(() => reset())

  it('counts the ids the membership-checked SQL function returns on the session client', async () => {
    enqueue({ data: ['inv-1', 'inv-2'] })
    await expect(countFailedPeppolDeliveries(supabase, COMPANY)).resolves.toBe(2)
    expect(mockSupabase.rpc).toHaveBeenCalledWith('peppol_failed_invoice_ids', expect.objectContaining({ p_company_id: COMPANY }))
    // No table read: peppol_deliveries is not granted to authenticated.
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })

  it('soft-fails to 0 on query error', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(countFailedPeppolDeliveries(supabase, COMPANY)).resolves.toBe(0)
  })
})
