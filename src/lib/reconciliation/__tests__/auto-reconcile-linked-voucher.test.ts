import { describe, it, expect, beforeEach, vi } from 'vitest'
import { autoReconcileTransactionForLinkedVoucher } from '@/lib/reconciliation/bank-reconciliation'
import { eventBus } from '@/lib/events/bus'
import { makeTransaction } from '@/tests/helpers'

// Whether the link anchors the row's underlag to the verifikat (crm#1101):
// the propagation itself is tested in lib/transactions/__tests__.
const { propagateUnderlag } = vi.hoisted(() => ({ propagateUnderlag: vi.fn() }))
vi.mock('@/lib/transactions/inbox-underlag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions/inbox-underlag')>()),
  propagateUnderlagForBookedTransaction: (...args: unknown[]) => propagateUnderlag(...args),
}))

// Queue-based Supabase mock: every awaited chain consumes the next enqueued
// result regardless of the builder methods called, so we enqueue results in the
// exact order the function under test awaits them. Mirrors the manualLink suite
// in bank-reconciliation.test.ts.
function createQueueMockSupabase() {
  const resultQueue: { data: unknown; error: unknown }[] = []
  // Every chain, with the builder calls made on it, for asserting on a write.
  const chains: Array<{ table: string; calls: Array<{ method: string; args: unknown[] }> }> = []

  const enqueue = (...results: { data?: unknown; error?: unknown }[]) => {
    for (const r of results) {
      resultQueue.push({ data: r.data ?? null, error: r.error ?? null })
    }
  }

  const buildChain = (record: (typeof chains)[number]): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          const next = resultQueue.shift() ?? { data: null, error: null }
          return (resolve: (v: unknown) => void) => resolve(next)
        }
        return (...args: unknown[]) => {
          record.calls.push({ method: String(prop), args })
          return buildChain(record)
        }
      },
    }
    return new Proxy({}, handler)
  }

  const open = (table: string) => {
    const record: (typeof chains)[number] = { table, calls: [] }
    chains.push(record)
    return buildChain(record)
  }

  const supabase = {
    from: vi.fn().mockImplementation((table: string) => open(table)),
    rpc: vi.fn().mockImplementation((fn: string) => open(`rpc:${fn}`)),
  }

  return { supabase, enqueue, chains }
}

/** The transactions updates the call made, with their values and filters. */
function transactionUpdates(chains: ReturnType<typeof createQueueMockSupabase>['chains']) {
  return chains
    .filter((c) => c.table === 'transactions' && c.calls.some((call) => call.method === 'update'))
    .map((c) => ({
      values: c.calls.find((call) => call.method === 'update')!.args[0] as Record<string, unknown>,
      filters: c.calls.filter((call) => call.method === 'eq' || call.method === 'is').map((call) => [call.method, ...call.args]),
    }))
}

const POSTED_VOUCHER = { id: 'je-1', entry_date: '2026-05-10', status: 'posted' }
// cash_accounts.id is a UUID: scopeTransactionsToAccount asserts that shape.
const CA_1930 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const CA_1932 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const SEK_PRIMARY = { id: CA_1930, ledger_account: '1930', currency: 'SEK', is_primary: true }
const EUR_1932 = { id: CA_1932, ledger_account: '1932', currency: 'EUR', is_primary: false }

/**
 * Enqueue the manualLink sub-call results (tx fetch → entry fetch → 1930 line
 * → update). cash_account_id is null on the fetched tx so manualLink skips the
 * cross-account check (one fewer query).
 */
function enqueueManualLinkSuccess(
  enqueue: ReturnType<typeof createQueueMockSupabase>['enqueue'],
  txAmount: number,
) {
  enqueue({ data: makeTransaction({ id: 'tx-1', journal_entry_id: null, cash_account_id: null, amount: txAmount, currency: 'SEK' }) })
  enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } })
  enqueue({ data: [{ debit_amount: Math.max(txAmount, 0), credit_amount: Math.max(-txAmount, 0), account_number: '1930' }] })
  enqueue({ data: [] }, { data: [] }) // the room check: no bank_line slice, no pointer (GitHub #3507)
  enqueue({ data: [{ id: 'tx-1' }] }) // update: .select('id') returns the updated row
}

describe('autoReconcileTransactionForLinkedVoucher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('links the single matching unbooked transaction for a customer payment (income)', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: [] }, { data: [] }) // 1. nobody holds the voucher: no bank_line slice, no pointer
    enqueue({ data: POSTED_VOUCHER }) // 2. voucher
    enqueue({ data: [ // 3. lines: one 1930 debit + the 1510 credit
      { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: 1000 },
    ] })
    enqueue({ data: [SEK_PRIMARY] }) // 4. cash accounts
    enqueue({ data: [{ id: 'tx-1', amount: 1000 }] }) // 5. exactly one candidate
    enqueueManualLinkSuccess(enqueue, 1000)

    const result = await autoReconcileTransactionForLinkedVoucher(
      supabase as never, 'company-1', 'user-1', 'je-1', { invoiceId: 'inv-1' },
    )

    expect(result).toEqual({ linkedTransactionId: 'tx-1' })
  })

  it('skips a row booked through a bank_line link: it has no pointer, and one written here would anchor it to a second verifikat', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: [] }, { data: [] }) // nobody holds the voucher
    enqueue({ data: POSTED_VOUCHER })
    enqueue({ data: [
      { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: 1000 },
    ] })
    enqueue({ data: [SEK_PRIMARY] })
    enqueue({ data: [{ id: 'tx-1', amount: 1000, transaction_voucher_links: [{ role: 'bank_line' }] }] })

    const result = await autoReconcileTransactionForLinkedVoucher(
      supabase as never, 'company-1', 'user-1', 'je-1', { invoiceId: 'inv-1' },
    )

    expect(result).toBeNull()
  })

  it('still links a row whose only link is a supplementary one: a residual is not the booking of the bank line', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: [] }, { data: [] })
    enqueue({ data: POSTED_VOUCHER })
    enqueue({ data: [
      { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: 1000 },
    ] })
    enqueue({ data: [SEK_PRIMARY] })
    enqueue({ data: [{ id: 'tx-1', amount: 1000, transaction_voucher_links: [{ role: 'other' }] }] })
    enqueueManualLinkSuccess(enqueue, 1000)

    const result = await autoReconcileTransactionForLinkedVoucher(
      supabase as never, 'company-1', 'user-1', 'je-1', { invoiceId: 'inv-1' },
    )

    expect(result).toEqual({ linkedTransactionId: 'tx-1' })
  })

  it("leaves the row's underlag on the row: a guessed link never makes its receipt that verifikat's for good (crm#1101)", async () => {
    // An anchored document stays the verifikat's underlag, and Koppla bort
    // only clears the row's pointer, so a wrong guess could not free it.
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: [] }, { data: [] }) // 1. nobody holds the voucher: no bank_line slice, no pointer
    enqueue({ data: POSTED_VOUCHER })
    enqueue({ data: [
      { account_number: '2440', debit_amount: 1000, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
    ] })
    enqueue({ data: [SEK_PRIMARY] })
    enqueue({ data: [{ id: 'tx-1', amount: -1000 }] })
    enqueueManualLinkSuccess(enqueue, -1000)

    const result = await autoReconcileTransactionForLinkedVoucher(
      supabase as never, 'company-1', 'user-1', 'je-1', { supplierInvoiceId: 'si-1' },
    )

    expect(result).toEqual({ linkedTransactionId: 'tx-1' })
    expect(propagateUnderlag).not.toHaveBeenCalled()
  })

  it('links the single matching unbooked transaction for a supplier payment (expense)', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: [] }, { data: [] }) // 1. nobody holds the voucher: no bank_line slice, no pointer
    enqueue({ data: POSTED_VOUCHER })
    enqueue({ data: [ // 2440 debit + 1930 credit (money out)
      { account_number: '2440', debit_amount: 1000, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
    ] })
    enqueue({ data: [SEK_PRIMARY] })
    enqueue({ data: [{ id: 'tx-1', amount: -1000 }] }) // expense tx
    enqueueManualLinkSuccess(enqueue, -1000)

    const result = await autoReconcileTransactionForLinkedVoucher(
      supabase as never, 'company-1', 'user-1', 'je-1', { supplierInvoiceId: 'si-1' },
    )

    expect(result).toEqual({ linkedTransactionId: 'tx-1' })
  })

  // ------------------------------------------------------------------
  // A row already holds the voucher (a sweep, a typed verifikat linked at
  // posting): never a second link, but the holder gets the invoice tag the
  // link writes, when that is unambiguous (#204).
  // ------------------------------------------------------------------

  const INCOME_LINES = [
    { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
    { account_number: '1510', debit_amount: 0, credit_amount: 1000 },
  ]
  const EXPENSE_LINES = [
    { account_number: '2440', debit_amount: 1000, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
  ]

  /** Holders read (one pointer holder), voucher, lines, cash accounts. */
  function enqueueHeldVoucher(
    enqueue: ReturnType<typeof createQueueMockSupabase>['enqueue'],
    amount: number,
    lines: Array<Record<string, unknown>>,
  ) {
    enqueue({ data: [] }) // no bank_line slice
    enqueue({ data: [{ id: 'tx-existing', journal_entry_id: 'je-1', amount, currency: 'SEK', cash_account_id: CA_1930 }] }) // a pointer
    enqueue({ data: POSTED_VOUCHER })
    enqueue({ data: lines })
    enqueue({ data: [SEK_PRIMARY] })
  }

  it.each([
    {
      kind: 'customer invoice',
      amount: 1000,
      lines: INCOME_LINES,
      options: { invoiceId: 'inv-1' },
      tag: { invoice_id: 'inv-1', potential_invoice_id: null, potential_rot_rut_payout_request_id: null },
    },
    {
      kind: 'supplier invoice',
      amount: -1000,
      lines: EXPENSE_LINES,
      options: { supplierInvoiceId: 'si-1' },
      tag: {
        supplier_invoice_id: 'si-1',
        potential_invoice_id: null,
        potential_supplier_invoice_id: null,
        potential_rot_rut_payout_request_id: null,
      },
    },
  ])('tags the untagged row that already holds the voucher with the $kind, without linking anything', async ({ amount, lines, options, tag }) => {
    const { supabase, enqueue, chains } = createQueueMockSupabase()
    enqueueHeldVoucher(enqueue, amount, lines)
    enqueue({ data: { journal_entry_id: 'je-1', invoice_id: null, supplier_invoice_id: null, transaction_voucher_links: [] } })
    enqueue({ data: [{ id: 'tx-existing' }] }) // the tag update
    enqueue({ data: null }) // payment_match_log insert

    const result = await autoReconcileTransactionForLinkedVoucher(
      supabase as never, 'company-1', 'user-1', 'je-1', options,
    )

    // Nothing was linked by this call: the caller does not report a reconciled row.
    expect(result).toBeNull()
    const updates = transactionUpdates(chains)
    expect(updates).toHaveLength(1)
    expect(updates[0].values).toEqual(tag)
    // The write repeats the conditions it was decided on.
    expect(updates[0].filters).toEqual(expect.arrayContaining([
      ['eq', 'id', 'tx-existing'],
      ['eq', 'company_id', 'company-1'],
      ['eq', 'journal_entry_id', 'je-1'],
      ['is', 'invoice_id', null],
      ['is', 'supplier_invoice_id', null],
    ]))
    // No candidate search, no second link.
    expect(chains.some((c) => c.table === 'open_bank_rows')).toBe(false)
    const audit = chains.find((c) => c.table === 'payment_match_log')
    expect(audit?.calls.find((call) => call.method === 'insert')?.args[0]).toEqual(expect.objectContaining({
      transaction_id: 'tx-existing',
      action: 'linked_to_existing_voucher',
    }))
  })

  it.each([
    { kind: 'another customer invoice', state: { invoice_id: 'inv-other', supplier_invoice_id: null } },
    { kind: 'a supplier invoice', state: { invoice_id: null, supplier_invoice_id: 'si-other' } },
  ])('leaves a row that already carries $kind as its tag untouched', async ({ state }) => {
    const { supabase, enqueue, chains } = createQueueMockSupabase()
    enqueueHeldVoucher(enqueue, 1000, INCOME_LINES)
    enqueue({ data: { journal_entry_id: 'je-1', ...state, transaction_voucher_links: [] } })

    const result = await autoReconcileTransactionForLinkedVoucher(
      supabase as never, 'company-1', 'user-1', 'je-1', { invoiceId: 'inv-1' },
    )

    expect(result).toBeNull()
    expect(transactionUpdates(chains)).toHaveLength(0)
  })

  it.each([
    {
      kind: 'its pointer now names another verifikat',
      state: { journal_entry_id: 'je-2', transaction_voucher_links: [] },
    },
    {
      kind: 'a bank_line slice books it on another verifikat',
      state: { journal_entry_id: 'je-1', transaction_voucher_links: [{ journal_entry_id: 'je-2', role: 'bank_line' }] },
    },
  ])('leaves a row that holds another verifikat untouched: $kind', async ({ state }) => {
    const { supabase, enqueue, chains } = createQueueMockSupabase()
    enqueueHeldVoucher(enqueue, 1000, INCOME_LINES)
    enqueue({ data: { invoice_id: null, supplier_invoice_id: null, ...state } })

    const result = await autoReconcileTransactionForLinkedVoucher(
      supabase as never, 'company-1', 'user-1', 'je-1', { invoiceId: 'inv-1' },
    )

    expect(result).toBeNull()
    expect(transactionUpdates(chains)).toHaveLength(0)
  })

  it('tags nothing when several rows hold the voucher (N:1): which one paid is not known', async () => {
    const { supabase, enqueue, chains } = createQueueMockSupabase()
    enqueue({ data: [] }) // no bank_line slice
    enqueue({ data: [
      { id: 'tx-a', journal_entry_id: 'je-1', amount: 500, currency: 'SEK', cash_account_id: CA_1930 },
      { id: 'tx-b', journal_entry_id: 'je-1', amount: 500, currency: 'SEK', cash_account_id: CA_1930 },
    ] })
    enqueue({ data: POSTED_VOUCHER })
    enqueue({ data: INCOME_LINES })
    enqueue({ data: [SEK_PRIMARY] })

    const result = await autoReconcileTransactionForLinkedVoucher(
      supabase as never, 'company-1', 'user-1', 'je-1', { invoiceId: 'inv-1' },
    )

    expect(result).toBeNull()
    expect(transactionUpdates(chains)).toHaveLength(0)
    // Decided on the holders alone: the row is not even read.
    expect(supabase.from).toHaveBeenCalledTimes(5)
  })

  it('does not link a second row when a bulk-booked row already holds the voucher through a bank_line slice (GitHub #3507), and tags nothing on it', async () => {
    // The pointer stays NULL for a samlingsverifikat's rows: the pointer-only
    // check used to read the voucher as free and attach a second row. A row
    // holding it only through a slice has no pointer to tag beside.
    const { supabase, enqueue, chains } = createQueueMockSupabase()
    enqueue({
      data: [{
        transaction_id: 'tx-bulk', journal_entry_id: 'je-1', allocated_amount: 1000,
        transactions: { amount: 1000, currency: 'SEK', cash_account_id: null },
      }],
    })
    enqueue({ data: [] }) // no pointer
    enqueue({ data: POSTED_VOUCHER })
    enqueue({ data: INCOME_LINES })
    enqueue({ data: [SEK_PRIMARY] })
    enqueue({ data: { journal_entry_id: null, invoice_id: null, supplier_invoice_id: null, transaction_voucher_links: [{ journal_entry_id: 'je-1', role: 'bank_line' }] } })

    const result = await autoReconcileTransactionForLinkedVoucher(
      supabase as never, 'company-1', 'user-1', 'je-1', { invoiceId: 'inv-1' },
    )

    expect(result).toBeNull()
    expect(transactionUpdates(chains)).toHaveLength(0)
    expect(chains.some((c) => c.table === 'open_bank_rows')).toBe(false)
  })

  it('does nothing when the voucher has no cash-account line (AR/AP reclass)', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: [] }, { data: [] }) // 1. nobody holds the voucher: no bank_line slice, no pointer
    enqueue({ data: POSTED_VOUCHER })
    enqueue({ data: [ // no 19xx line at all
      { account_number: '1510', debit_amount: 1000, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
    ] })
    enqueue({ data: [SEK_PRIMARY] })

    const result = await autoReconcileTransactionForLinkedVoucher(
      supabase as never, 'company-1', 'user-1', 'je-1', { invoiceId: 'inv-1' },
    )

    expect(result).toBeNull()
  })

  it('does nothing when the voucher touches two cash accounts (a transfer)', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: [] }, { data: [] }) // 1. nobody holds the voucher: no bank_line slice, no pointer
    enqueue({ data: POSTED_VOUCHER })
    enqueue({ data: [
      { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
      { account_number: '1932', debit_amount: 1000, credit_amount: 0 },
    ] })
    enqueue({ data: [SEK_PRIMARY, EUR_1932] })

    const result = await autoReconcileTransactionForLinkedVoucher(
      supabase as never, 'company-1', 'user-1', 'je-1', { invoiceId: 'inv-1' },
    )

    expect(result).toBeNull()
  })

  it('does nothing when two unbooked transactions match the amount (ambiguous)', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: [] }, { data: [] }) // 1. nobody holds the voucher: no bank_line slice, no pointer
    enqueue({ data: POSTED_VOUCHER })
    enqueue({ data: [
      { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: 1000 },
    ] })
    enqueue({ data: [SEK_PRIMARY] })
    enqueue({ data: [{ id: 'tx-1', amount: 1000 }, { id: 'tx-2', amount: 1000 }] }) // two hits

    const result = await autoReconcileTransactionForLinkedVoucher(
      supabase as never, 'company-1', 'user-1', 'je-1', { invoiceId: 'inv-1' },
    )

    expect(result).toBeNull()
  })

  it('does nothing when no candidate matches the bank movement amount', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: [] }, { data: [] }) // 1. nobody holds the voucher: no bank_line slice, no pointer
    enqueue({ data: POSTED_VOUCHER })
    enqueue({ data: [
      { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: 1000 },
    ] })
    enqueue({ data: [SEK_PRIMARY] })
    enqueue({ data: [{ id: 'tx-9', amount: 5000 }] }) // wrong amount

    const result = await autoReconcileTransactionForLinkedVoucher(
      supabase as never, 'company-1', 'user-1', 'je-1', { invoiceId: 'inv-1' },
    )

    expect(result).toBeNull()
  })

  // ------------------------------------------------------------------
  // Foreign-currency accounts. This path PERSISTS a reconciliation link, so a
  // wrong-unit comparison here writes the wrong conclusion into the ledger.
  // The voucher's bank leg holds the SEK conversion in debit/credit and the
  // EUR amount in amount_in_currency; the candidate transactions are in EUR.
  // ------------------------------------------------------------------

  it('does NOT link a same-magnitude SEK-figure transaction on a EUR account', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: [] }, { data: [] }) // 1. nobody holds the voucher: no bank_line slice, no pointer
    enqueue({ data: POSTED_VOUCHER })
    enqueue({ data: [ // 100 EUR at 11.50 = 1150 SEK in the ledger columns
      { account_number: '1932', debit_amount: 1150, credit_amount: 0, currency: 'EUR', amount_in_currency: 100 },
      { account_number: '1510', debit_amount: 0, credit_amount: 1150 },
    ] })
    enqueue({ data: [SEK_PRIMARY, EUR_1932] })
    // A 1150 EUR row on the account: the same number as the SEK figure, a
    // completely different amount of money.
    enqueue({ data: [{ id: 'tx-lookalike', amount: 1150 }] })
    // A full manualLink success sequence follows, so this test fails loudly if
    // the movement is ever compared as 1150 again: it would link.
    enqueue({ data: makeTransaction({ id: 'tx-lookalike', journal_entry_id: null, cash_account_id: null, amount: 1150, currency: 'EUR' }) })
    enqueue({ data: { id: 'je-1', status: 'posted' } })
    enqueue({ data: [{ debit_amount: 1150, credit_amount: 0, account_number: '1932' }] })
    enqueue({ data: [{ id: 'tx-lookalike' }] })

    const result = await autoReconcileTransactionForLinkedVoucher(
      supabase as never, 'company-1', 'user-1', 'je-1', { invoiceId: 'inv-1' },
    )

    expect(result).toBeNull()
  })

  it('links the transaction whose EUR amount matches the voucher bank leg', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: [] }, { data: [] }) // 1. nobody holds the voucher: no bank_line slice, no pointer
    enqueue({ data: POSTED_VOUCHER })
    enqueue({ data: [
      { account_number: '1932', debit_amount: 1150, credit_amount: 0, currency: 'EUR', amount_in_currency: 100 },
      { account_number: '1510', debit_amount: 0, credit_amount: 1150 },
    ] })
    enqueue({ data: [SEK_PRIMARY, EUR_1932] })
    enqueue({ data: [{ id: 'tx-eur', amount: 100 }] }) // the real 100 EUR settlement
    enqueue({ data: makeTransaction({ id: 'tx-eur', journal_entry_id: null, cash_account_id: null, amount: 100, currency: 'EUR' }) })
    enqueue({ data: { id: 'je-1', status: 'posted' } })
    enqueue({ data: [{ debit_amount: 1150, credit_amount: 0, account_number: '1932' }] })
    enqueue({ data: [] }, { data: [] }) // the room check: no bank_line slice, no pointer
    enqueue({ data: [{ id: 'tx-eur' }] })

    const result = await autoReconcileTransactionForLinkedVoucher(
      supabase as never, 'company-1', 'user-1', 'je-1', { invoiceId: 'inv-1' },
    )

    expect(result).toEqual({ linkedTransactionId: 'tx-eur' })
  })

  it('does nothing when a EUR account voucher line carries no EUR amount', async () => {
    // No per-row rate on the bank leg (SIE import, pre-FX booking): there is
    // nothing safe to compare, so leave it for the user rather than persist a
    // guess that reads the SEK figure as EUR.
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: [] }, { data: [] }) // 1. nobody holds the voucher: no bank_line slice, no pointer
    enqueue({ data: POSTED_VOUCHER })
    enqueue({ data: [
      { account_number: '1932', debit_amount: 1150, credit_amount: 0, currency: 'SEK' },
      { account_number: '1510', debit_amount: 0, credit_amount: 1150 },
    ] })
    enqueue({ data: [SEK_PRIMARY, EUR_1932] })
    enqueue({ data: [{ id: 'tx-1150', amount: 1150 }] })
    enqueue({ data: makeTransaction({ id: 'tx-1150', journal_entry_id: null, cash_account_id: null, amount: 1150, currency: 'EUR' }) })
    enqueue({ data: { id: 'je-1', status: 'posted' } })
    enqueue({ data: [{ debit_amount: 1150, credit_amount: 0, account_number: '1932' }] })
    enqueue({ data: [{ id: 'tx-1150' }] })

    const result = await autoReconcileTransactionForLinkedVoucher(
      supabase as never, 'company-1', 'user-1', 'je-1', { invoiceId: 'inv-1' },
    )

    expect(result).toBeNull()
  })

  it('still links on a SEK account when the voucher line carries a foreign LABEL', async () => {
    // 95%-path regression guard: a SEK payment of a EUR invoice labels the line
    // 'EUR' while debit/credit are SEK. The SEK account must reconcile on the
    // SEK columns exactly as before.
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: [] }, { data: [] }) // 1. nobody holds the voucher: no bank_line slice, no pointer
    enqueue({ data: POSTED_VOUCHER })
    enqueue({ data: [
      { account_number: '2440', debit_amount: 1150, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 1150, currency: 'EUR', amount_in_currency: 100 },
    ] })
    enqueue({ data: [SEK_PRIMARY] })
    enqueue({ data: [{ id: 'tx-1', amount: -1150 }] })
    enqueueManualLinkSuccess(enqueue, -1150)

    const result = await autoReconcileTransactionForLinkedVoucher(
      supabase as never, 'company-1', 'user-1', 'je-1', { supplierInvoiceId: 'si-1' },
    )

    expect(result).toEqual({ linkedTransactionId: 'tx-1' })
  })

  it('does nothing when the voucher is not posted', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: [] }, { data: [] }) // 1. nobody holds the voucher: no bank_line slice, no pointer
    enqueue({ data: { id: 'je-1', entry_date: '2026-05-10', status: 'draft' } })

    const result = await autoReconcileTransactionForLinkedVoucher(
      supabase as never, 'company-1', 'user-1', 'je-1', { invoiceId: 'inv-1' },
    )

    expect(result).toBeNull()
  })
})
