import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const tool = tools.find((t) => t.name === 'gnubok_list_uncategorized_transactions')!

type Enqueue = (r: { data?: unknown; error?: unknown; count?: number | null }) => void

// Query order per call: (1) the page with an exact count, from the work queue
// (public.open_bank_rows: not ignored, not private, anchored to no verifikat),
// (2) cash_accounts when a page row carries a cash_account_id, (3) the
// Bankgirot parts of the page. (2) and (3) are skipped on an empty page.
function enqueuePage(enqueue: Enqueue, rows: unknown[], count = rows.length) {
  enqueue({ data: rows, error: null, count })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_list_uncategorized_transactions', () => {
  it('is registered as a read-only paginated tool', () => {
    expect(tool).toBeDefined()
    expect(tool.annotations?.readOnlyHint).toBe(true)
    const schema = tool.outputSchema as Record<string, unknown>
    expect((schema.properties as Record<string, unknown>).transactions).toBeDefined()
    expect((schema.properties as Record<string, unknown>).total_count).toBeDefined()
  })

  it('returns rows when DB has null merchant_name, reference, is_business (MCP structured output)', async () => {
    const rows = [
      {
        id: 't-uncat-1',
        date: '2026-03-09',
        description: 'Transfer',
        amount: -6000,
        currency: 'SEK',
        merchant_name: null,
        reference: null,
        is_business: null,
        category: null,
      },
    ]
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueuePage(enqueue, rows)

    const result = (await tool.execute(
      { limit: 20 },
      'company-1',
      'user-1',
      supabase as never
    )) as {
      transactions: typeof rows
      count: number
      total_count: number
      has_more: boolean
    }

    expect(result.count).toBe(1)
    expect(result.total_count).toBe(1)
    expect(result.has_more).toBe(false)
    expect(result.transactions[0].merchant_name).toBeNull()
    expect(result.transactions[0].reference).toBeNull()
    expect(result.transactions[0].is_business).toBeNull()
  })

  it('exposes cash_account_id and resolves the bank account ledger per row', async () => {
    // Customer report (A4): nothing on the API said which bank account a
    // transaction belongs to, so per-account reconciliation was impossible.
    const rows = [
      { id: 't-1', date: '2026-03-09', description: 'A', amount: -10, currency: 'SEK', merchant_name: null, reference: null, is_business: null, category: null, cash_account_id: 'ca-1930' },
      { id: 't-2', date: '2026-03-08', description: 'B', amount: -20, currency: 'SEK', merchant_name: null, reference: null, is_business: null, category: null, cash_account_id: null },
    ]
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueuePage(enqueue, rows)
    enqueue({ data: [{ id: 'ca-1930', ledger_account: '1930' }], error: null })

    const result = (await tool.execute({ limit: 20 }, 'company-1', 'user-1', supabase as never)) as {
      transactions: Array<{ transaction_id: string; cash_account_id: string | null; cash_account_ledger: string | null }>
    }

    expect(result.transactions[0]).toMatchObject({ transaction_id: 't-1', cash_account_id: 'ca-1930', cash_account_ledger: '1930' })
    expect(result.transactions[1]).toMatchObject({ transaction_id: 't-2', cash_account_id: null, cash_account_ledger: null })
    // The ledger lookup is scoped to the company and the ids on this page.
    const inCalls = findCalls('cash_accounts', 'in')
    expect(inCalls).toEqual([['id', ['ca-1930']]])
  })

  it('carries each row\'s source id, so a Stripe row and its fee row trace back to the balance transaction (crm#1347)', async () => {
    const rows = [
      { id: 't-1', date: '2026-03-09', description: 'Stripe-betalning', amount: 100, currency: 'SEK', merchant_name: null, reference: null, is_business: null, category: null, cash_account_id: null, external_id: 'stripe_acct_1_txn_1' },
      { id: 't-2', date: '2026-03-09', description: 'Stripe-avgift (Stripe-betalning)', amount: -3, currency: 'SEK', merchant_name: null, reference: null, is_business: null, category: null, cash_account_id: null, external_id: 'stripe_acct_1_txn_1_fee' },
    ]
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueuePage(enqueue, rows)

    const result = (await tool.execute({ limit: 20 }, 'company-1', 'user-1', supabase as never)) as {
      transactions: Array<{ transaction_id: string; external_id: string | null }>
    }

    const select = String(findCalls('open_bank_rows', 'select')[0][0]).split(',').map((c) => c.trim())
    expect(select).toContain('external_id')
    expect(result.transactions.map((t) => [t.transaction_id, t.external_id])).toEqual([
      ['t-1', 'stripe_acct_1_txn_1'],
      ['t-2', 'stripe_acct_1_txn_1_fee'],
    ])
  })

  it("carries the bank's own id: a feed row's external_id is built from its content, so a resent row needs this one", async () => {
    const rows = [
      { id: 't-1', date: '2026-03-09', description: 'Hyra', amount: -900, currency: 'SEK', merchant_name: null, reference: null, is_business: null, category: null, cash_account_id: null, external_id: 'eb_scope_2026-03-09_-90000_0', provider_transaction_id: 'bank-tx-1' },
      { id: 't-2', date: '2026-03-09', description: 'Hyra', amount: -900, currency: 'SEK', merchant_name: null, reference: null, is_business: null, category: null, cash_account_id: null, external_id: 'eb_scope_2026-03-09_-90000_1', provider_transaction_id: null },
    ]
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueuePage(enqueue, rows)

    const result = (await tool.execute({ limit: 20 }, 'company-1', 'user-1', supabase as never)) as {
      transactions: Array<{ transaction_id: string; provider_transaction_id: string | null }>
    }

    const select = String(findCalls('open_bank_rows', 'select')[0][0]).split(',').map((c) => c.trim())
    expect(select).toContain('provider_transaction_id')
    expect(result.transactions.map((t) => [t.transaction_id, t.provider_transaction_id])).toEqual([
      ['t-1', 'bank-tx-1'],
      ['t-2', null],
    ])
  })

  it('narrows the page and its count to one bank account when cash_account_id is given', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueuePage(enqueue, [{ id: 't-1', date: '2026-03-09', description: 'A', amount: -10, currency: 'SEK', merchant_name: null, reference: null, is_business: null, category: null, cash_account_id: null }])

    const CA = '550e8400-e29b-41d4-a716-446655441940'
    await tool.execute({ limit: 20, cash_account_id: CA }, 'company-1', 'user-1', supabase as never)

    const eqCalls = findCalls('open_bank_rows', 'eq').filter((args) => args[0] === 'cash_account_id')
    expect(eqCalls).toEqual([['cash_account_id', CA]])
    // No ledger lookup when no page row carries a cash_account_id.
    expect(findCalls('cash_accounts', 'in')).toHaveLength(0)
  })

  it('skips the ledger and parts reads when nothing is unbooked', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueuePage(enqueue, [])

    const result = (await tool.execute({ limit: 20 }, 'company-1', 'user-1', supabase as never)) as {
      transactions: unknown[]
      total_count: number
      has_more: boolean
    }

    expect(result).toMatchObject({ transactions: [], total_count: 0, has_more: false })
    expect(findCalls('cash_accounts', 'in')).toHaveLength(0)
    expect(findCalls('bank_transaction_parts', 'in')).toHaveLength(0)
  })

  it('rejects a ledger number passed as cash_account_id with a clear message', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      tool.execute({ limit: 20, cash_account_id: '1930' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/cash_account_id must be a cash account UUID/)
  })

  it('returns the counterparty IBAN the bank sent, the only payee a foreign payment may name (PH 196)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueuePage(enqueue, [
      { id: 't-foreign', date: '2026-10-16', description: 'UTLANDSBETALNING', amount: -5000, currency: 'SEK', merchant_name: 'UTLANDSBETALNING', reference: 'UTLANDSBETALNING', is_business: null, category: null, cash_account_id: null, counterparty_account: null, counterparty_iban: 'NO9386011117947' },
    ])

    const result = (await tool.execute({ limit: 20 }, 'company-1', 'user-1', supabase as never)) as { transactions: Array<Record<string, unknown>> }

    expect(String(findCalls('open_bank_rows', 'select')[0][0])).toContain('counterparty_iban')
    expect(result.transactions[0]).toMatchObject({ transaction_id: 't-foreign', counterparty_account: null, counterparty_iban: 'NO9386011117947' })
  })

  it('reads the work queue server-side: not ignored, not private, anchored to no verifikat', async () => {
    // journal_entry_id IS NULL is only the first anchor: a row split over
    // several verifikat (#1553), bulk-booked into a samlingsverifikat or
    // settled through an invoice allocation keeps it NULL. An ignored row has
    // journal_entry_id NULL by CHECK (feedback seq 330091). The view holds the
    // rule, so a filter on the table beside it is a copy.
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueuePage(enqueue, [{ id: 't-1', date: '2026-03-09', description: 'A', amount: -10, currency: 'SEK', merchant_name: null, reference: null, is_business: null, category: null, cash_account_id: null }])

    await tool.execute({ limit: 20 }, 'company-1', 'user-1', supabase as never)

    expect(findCalls('open_bank_rows', 'select')[0][1]).toEqual({ count: 'exact' })
    expect(findCalls('open_bank_rows', 'eq')).toEqual([['company_id', 'company-1']])
    expect(findCalls('open_bank_rows', 'not')).toEqual([])
    expect(findCalls('open_bank_rows', 'is')).toEqual([])
    expect(findCalls('transactions', 'select')).toEqual([])
  })

  it('pages with range and takes total_count from the same query (split row, crm#48)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueuePage(
      enqueue,
      [{ id: 't-open', date: '2026-08-19', description: 'Open', amount: -10, currency: 'SEK', merchant_name: null, reference: null, is_business: null, category: null, cash_account_id: null }],
      2,
    )

    const result = (await tool.execute({ limit: 1, offset: 0 }, 'company-1', 'user-1', supabase as never)) as {
      transactions: Array<{ transaction_id: string }>
      total_count: number
      has_more: boolean
      next_offset?: number
    }

    expect(findCalls('open_bank_rows', 'range')).toEqual([[0, 0]])
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['t-open'])
    expect(result.total_count).toBe(2)
    expect(result.has_more).toBe(true)
    expect(result.next_offset).toBe(1)
  })

  it('carries parts_count per row and, for a row ingest marked a complete Bankgirot split, the allocations ready for gnubok_match_batch_allocate', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      count: 3,
      data: [
        { id: 't-split', date: '2026-10-12', description: 'Bg-inbetalning', amount: 1500, currency: 'SEK', merchant_name: null, reference: null, is_business: null, category: null, cash_account_id: null, potential_match_method: 'bankgiro_split' },
        { id: 't-partial', date: '2026-10-12', description: 'Bg-inbetalning', amount: 900, currency: 'SEK', merchant_name: null, reference: null, is_business: null, category: null, cash_account_id: null, potential_match_method: null },
        { id: 't-plain', date: '2026-10-11', description: 'Kortköp', amount: -120, currency: 'SEK', merchant_name: null, reference: null, is_business: null, category: null, cash_account_id: null, potential_match_method: null },
      ],
      error: null,
    })
    // No cash_account_id on the page: the ledger lookup is skipped; the parts read follows.
    enqueue({
      data: [
        { transaction_id: 't-split', seq: 1, amount: '500.00', suggested_invoice_id: 'inv-1001', suggested_supplier_invoice_id: null },
        { transaction_id: 't-split', seq: 2, amount: '1000.00', suggested_invoice_id: 'inv-1002', suggested_supplier_invoice_id: null },
        { transaction_id: 't-partial', seq: 1, amount: '400.00', suggested_invoice_id: 'inv-1003', suggested_supplier_invoice_id: null },
        { transaction_id: 't-partial', seq: 2, amount: '500.00', suggested_invoice_id: null, suggested_supplier_invoice_id: null },
      ],
      error: null,
    })

    const result = (await tool.execute({ limit: 20 }, 'company-1', 'user-1', supabase as never)) as {
      transactions: Array<{ transaction_id: string; parts_count: number; batch_suggestion?: { allocations: unknown[] } }>
    }

    expect(result.transactions.map((t) => [t.transaction_id, t.parts_count])).toEqual([['t-split', 2], ['t-partial', 2], ['t-plain', 0]])
    expect(result.transactions[0].batch_suggestion).toEqual({
      allocations: [
        { kind: 'customer_invoice', invoice_id: 'inv-1001', amount: 500 },
        { kind: 'customer_invoice', invoice_id: 'inv-1002', amount: 1000 },
      ],
    })
    // An incomplete split and a row without parts offer no batch.
    expect(result.transactions[1].batch_suggestion).toBeUndefined()
    expect(result.transactions[2].batch_suggestion).toBeUndefined()
    expect(findCalls('bank_transaction_parts', 'in')).toEqual([['transaction_id', ['t-split', 't-partial', 't-plain']]])
    expect(findCalls('bank_transaction_parts', 'eq')).toEqual([['company_id', 'company-1']])
  })

  it("carries Accounted's own open match as suggested_match and leaves out a stale pointer (crm#1510)", async () => {
    // The agent listed a bankgiro payment of a supplier invoice without the
    // suggestion Att göra showed the person, reported the invoice overdue and
    // staged its own booking beside it.
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    const base = { currency: 'SEK', reference: null, is_business: null, category: null, cash_account_id: null, potential_match_method: null, potential_invoice_id: null, potential_supplier_invoice_id: null, potential_journal_entry_id: null, potential_match_confidence: null }
    enqueuePage(enqueue, [
      { ...base, id: 't-si', date: '2026-10-27', description: 'Bg betalning', merchant_name: 'Leverantör AB', amount: -2494, potential_supplier_invoice_id: 'si-open' },
      { ...base, id: 't-stale', date: '2026-10-27', description: 'Bg betalning', merchant_name: 'Leverantör AB', amount: -100, potential_supplier_invoice_id: 'si-paid' },
      { ...base, id: 't-je', date: '2026-10-26', description: 'Inbetalning', merchant_name: 'Kund AB', amount: 500, potential_match_method: 'amount_date', potential_journal_entry_id: 'je-1', potential_match_confidence: '0.9' },
      { ...base, id: 't-plain', date: '2026-10-26', description: 'Avgift', merchant_name: 'Banken', amount: -39 },
    ])
    enqueue({ data: [], error: null }) // bank_transaction_parts
    enqueue({
      data: [
        { id: 'si-open', supplier_invoice_number: '74079', remaining_amount: '2494.00', status: 'overdue' },
        { id: 'si-paid', supplier_invoice_number: '1', remaining_amount: '0', status: 'paid' },
      ],
      error: null,
    }) // supplier_invoices
    enqueue({ data: [{ id: 'je-1', voucher_series: 'a', voucher_number: 12, status: 'posted' }], error: null }) // journal_entries

    const result = (await tool.execute({ limit: 20 }, 'company-1', 'user-1', supabase as never)) as {
      transactions: Array<Record<string, unknown>>
    }

    const byId = new Map(result.transactions.map((t) => [t.transaction_id, t]))
    expect(byId.get('t-si')?.suggested_match).toEqual({
      kind: 'supplier_invoice',
      supplier_invoice_id: 'si-open',
      invoice_number: '74079',
      remaining_amount: 2494,
    })
    expect(byId.get('t-stale')).not.toHaveProperty('suggested_match')
    expect(byId.get('t-je')?.suggested_match).toEqual({ kind: 'journal_entry', journal_entry_id: 'je-1', voucher: 'A12', confidence: 0.9 })
    expect(byId.get('t-plain')).not.toHaveProperty('suggested_match')
    // The raw pointers are read for the suggestion, not returned.
    for (const row of result.transactions) {
      expect(row).not.toHaveProperty('potential_supplier_invoice_id')
      expect(row).not.toHaveProperty('potential_journal_entry_id')
    }
    expect(findCalls('supplier_invoices', 'in')).toEqual([['id', ['si-open', 'si-paid']]])
    expect(findCalls('supplier_invoices', 'eq')).toEqual([['company_id', 'company-1']])
    // No row points at a customer invoice: that read is skipped.
    expect(findCalls('invoices', 'in')).toHaveLength(0)
  })

  it('says whose giro a nameless row shows: the own bankgiro, or the one supplier card (crm#1204)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    const base = { currency: 'SEK', merchant_name: null, reference: null, is_business: null, category: null, cash_account_id: null, potential_match_method: null }
    enqueuePage(enqueue, [
      { ...base, id: 't-deposit', date: '2026-10-12', description: 'BG 123-4566  00012', original_description: 'BG 123-4566  00012', amount: 1500, counterparty_account: null },
      { ...base, id: 't-unknown', date: '2026-10-12', description: 'BG 555-0009', original_description: 'BG 555-0009', amount: 700, counterparty_account: null },
      { ...base, id: 't-supplier', date: '2026-10-11', description: '40012345678', original_description: '40012345678', amount: -900, counterparty_account: '999-0003' },
      { ...base, id: 't-named', date: '2026-10-11', description: 'Spotify AB', original_description: 'Spotify AB', amount: -120, counterparty_account: null },
    ])
    enqueue({ data: [], error: null }) // bank_transaction_parts
    enqueue({ data: { bankgiro: '123-4566', plusgiro: null }, error: null }) // company_settings
    enqueue({ data: [], error: null }) // cash_accounts
    enqueue({ data: [{ id: 's-1', name: 'Leverantör AB', bankgiro: '999-0003', plusgiro: null }], error: null }) // suppliers

    const result = (await tool.execute({ limit: 20 }, 'company-1', 'user-1', supabase as never)) as {
      transactions: Array<Record<string, unknown>>
    }

    const byId = new Map(result.transactions.map((t) => [t.transaction_id, t]))
    expect(byId.get('t-deposit')?.giro_counterparty).toEqual({ kind: 'own_deposit', scheme: 'bankgiro', giro: '123-4566', on_file: true })
    expect(byId.get('t-unknown')?.giro_counterparty).toEqual({ kind: 'own_deposit', scheme: 'bankgiro', giro: '555-0009', on_file: false })
    expect(byId.get('t-supplier')?.giro_counterparty).toEqual({ kind: 'supplier', scheme: 'bankgiro', giro: '999-0003', name: 'Leverantör AB' })
    expect(byId.get('t-named')).not.toHaveProperty('giro_counterparty')
    // The bank text is read, not returned; the register is the company's own.
    expect(byId.get('t-deposit')).not.toHaveProperty('original_description')
    expect(findCalls('suppliers', 'eq')).toEqual([['company_id', 'company-1']])
    expect(findCalls('company_settings', 'eq')).toEqual([['company_id', 'company-1']])
  })

  it('reads no register when no row on the page can carry a giro reading', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueuePage(enqueue, [
      { id: 't-1', date: '2026-10-11', description: 'Spotify AB', original_description: 'Spotify AB', amount: -120, currency: 'SEK', merchant_name: null, reference: null, is_business: null, category: null, cash_account_id: null, counterparty_account: null },
    ])

    const result = (await tool.execute({ limit: 20 }, 'company-1', 'user-1', supabase as never)) as {
      transactions: Array<Record<string, unknown>>
    }

    expect(result.transactions[0]).not.toHaveProperty('giro_counterparty')
    expect(findCalls('suppliers', 'select')).toHaveLength(0)
    expect(findCalls('company_settings', 'select')).toHaveLength(0)
  })

  it('carries pending_operation_id on a row an open proposal already holds, from one read for the page (crm#1264)', async () => {
    // An agent listed a row it had already staged, saw nothing on it, and
    // staged it again: the second card for the same bank row.
    const base = { date: '2026-10-16', description: 'Avgift', amount: -39, currency: 'SEK', merchant_name: 'Banken', reference: null, is_business: null, category: null, cash_account_id: null }
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueuePage(enqueue, [{ ...base, id: 't-staged' }, { ...base, id: 't-bulk' }, { ...base, id: 't-free' }])
    enqueue({ data: [], error: null }) // bank_transaction_parts
    enqueue({
      data: [
        { id: 'op-cat', operation_type: 'categorize_transaction', params: { transaction_id: 't-staged' } },
        { id: 'op-bulk', operation_type: 'bulk_book_transactions', params: { tx_ids: ['t-bulk', 't-other-page'] } },
      ],
      error: null,
    }) // pending_operations

    const result = (await tool.execute({ limit: 20 }, 'company-1', 'user-1', supabase as never)) as {
      transactions: Array<Record<string, unknown>>
    }

    const byId = new Map(result.transactions.map((t) => [t.transaction_id, t]))
    expect(byId.get('t-staged')?.pending_operation_id).toBe('op-cat')
    expect(byId.get('t-bulk')?.pending_operation_id).toBe('op-bulk')
    expect(byId.get('t-free')).not.toHaveProperty('pending_operation_id')
    // One read for the page, scoped to the company: never one per row.
    expect(findCalls('pending_operations', 'select')).toHaveLength(1)
    expect(findCalls('pending_operations', 'eq')).toEqual([['company_id', 'company-1']])
  })

  it('reads no proposals for an empty page', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueuePage(enqueue, [])

    await tool.execute({ limit: 20 }, 'company-1', 'user-1', supabase as never)

    expect(findCalls('pending_operations', 'select')).toHaveLength(0)
  })

  it('fails instead of listing a booked row when the page read fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'statement timeout' } })

    await expect(tool.execute({ limit: 20 }, 'company-1', 'user-1', supabase as never)).rejects.toThrow()
  })
})
