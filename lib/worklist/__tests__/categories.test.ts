import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  countDeadlinesNeedingAction,
  countInboxDocuments,
  countOverdueInvoices,
  countPendingOperations,
  countReconciliationDue,
  countSuggestedMatches,
  countSupplierInvoicesAwaitingApproval,
  countUnbookedSkattekontoRows,
  countUnbookedTransactions,
  countVerifikatMissingDocument,
  listExpensePayoutsDue,
  listExpensePayoutSuggestions,
  listRotRutPayoutSetSuggestions,
  listSuggestedMatches,
} from '../categories'
import {
  MATCHABLE_INVOICE_STATUSES,
  MATCHABLE_SUPPLIER_INVOICE_STATUSES,
} from '@/lib/invoices/matchable-statuses'

const { supabase: mockSupabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()
const supabase = mockSupabase as unknown as SupabaseClient
const COMPANY = 'company-1'

beforeEach(() => {
  vi.clearAllMocks()
  reset()
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

describe('simple head counts', () => {
  it.each([
    ['countSupplierInvoicesAwaitingApproval', countSupplierInvoicesAwaitingApproval, 'supplier_invoices'],
    ['countOverdueInvoices', countOverdueInvoices, 'invoices'],
    ['countDeadlinesNeedingAction', countDeadlinesNeedingAction, 'deadlines'],
    ['countPendingOperations', countPendingOperations, 'pending_operations'],
  ] as const)('%s returns the count and targets the right table', async (_name, fn, table) => {
    enqueue({ count: 3 })
    await expect(fn(supabase, COMPANY)).resolves.toBe(3)
    expect(mockSupabase.from).toHaveBeenCalledWith(table)
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
    // filter needs findCalls to be covered at all.
    expect(findCalls('invoices', 'in')).toEqual([
      ['id', ['inv-1']],
      ['status', [...MATCHABLE_INVOICE_STATUSES]],
    ])
    expect(findCall('invoices', 'gt')).toEqual(['remaining_amount', 0])
    expect(findCalls('supplier_invoices', 'in')).toEqual([
      ['id', ['sinv-1']],
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
        key: 'owner:Jakob',
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
