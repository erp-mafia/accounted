import { describe, it, expect, beforeEach, vi } from 'vitest'
import { autoReconcileTransactionForLinkedVoucher } from '@/lib/reconciliation/bank-reconciliation'
import { eventBus } from '@/lib/events/bus'
import { makeTransaction } from '@/tests/helpers'

// Queue-based Supabase mock: every awaited chain consumes the next enqueued
// result regardless of the builder methods called, so we enqueue results in the
// exact order the function under test awaits them. Mirrors the manualLink suite
// in bank-reconciliation.test.ts.
function createQueueMockSupabase() {
  const resultQueue: { data: unknown; error: unknown }[] = []

  const enqueue = (...results: { data?: unknown; error?: unknown }[]) => {
    for (const r of results) {
      resultQueue.push({ data: r.data ?? null, error: r.error ?? null })
    }
  }

  const buildChain = (): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          const next = resultQueue.shift() ?? { data: null, error: null }
          return (resolve: (v: unknown) => void) => resolve(next)
        }
        return (..._args: unknown[]) => buildChain()
      },
    }
    return new Proxy({}, handler)
  }

  const supabase = {
    from: vi.fn().mockImplementation(() => buildChain()),
    rpc: vi.fn().mockImplementation(() => buildChain()),
  }

  return { supabase, enqueue }
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
  enqueue({ data: [{ id: 'tx-1' }] }) // update: .select('id') returns the updated row
}

describe('autoReconcileTransactionForLinkedVoucher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('links the single matching unbooked transaction for a customer payment (income)', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: [] }) // 1. no tx already reconciled to the voucher
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

  it('links the single matching unbooked transaction for a supplier payment (expense)', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: [] })
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

  it('never attaches a second bank line to a voucher that already has one', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    // Already reconciled AND already tagged: nothing is owed, and the existing
    // tag is not overwritten (a voucher settling two payables can only name one).
    enqueue({ data: [{ id: 'tx-existing', invoice_id: 'inv-other', supplier_invoice_id: null }] })

    const result = await autoReconcileTransactionForLinkedVoucher(
      supabase as never, 'company-1', 'user-1', 'je-1', { invoiceId: 'inv-1' },
    )

    expect(result).toBeNull()
    // One read, no write: the queue still holds nothing but the function never
    // reached the voucher load either.
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('reports no tag when a concurrent link already claimed the pointer', async () => {
    // The link RPCs lock the invoice row, not this transaction, so two calls can
    // read the same null pointer. The compare-and-set makes the loser write
    // nothing; without the returned-row check it would still claim the tag and
    // both callers would believe they owned the bank line.
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: [{ id: 'tx-existing', invoice_id: null, supplier_invoice_id: null }] })
    enqueue({ data: [] }) // CAS matched nothing: the other writer got there first

    const result = await autoReconcileTransactionForLinkedVoucher(
      supabase as never, 'company-1', 'user-1', 'je-1', { invoiceId: 'inv-1' },
    )

    expect(result).toBeNull()
  })

  it('tags the bank line already on the voucher when it carries no invoice yet', async () => {
    // The state an undone link leaves behind: unlink clears
    // supplier_invoice_id and deliberately keeps journal_entry_id, because the
    // bank line genuinely paid the voucher. Re-linking to the right payable
    // must restore the tag, or the correction leaves the row untied to any
    // payable (worse traceability after the fix than before it, #2673).
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: [{ id: 'tx-existing', invoice_id: null, supplier_invoice_id: null }] })
    // The tag update is a compare-and-set that re-asserts the null pointer and
    // selects the row back, so a concurrent link cannot win silently: it has to
    // return the row for the tag to count as taken.
    enqueue({ data: [{ id: 'tx-existing' }] })

    const result = await autoReconcileTransactionForLinkedVoucher(
      supabase as never, 'company-1', 'user-1', 'je-1', { supplierInvoiceId: 'si-9' },
    )

    // Reconciled it is not: it already was. Tagged it now is.
    expect(result).toEqual({ linkedTransactionId: 'tx-existing' })
    // Read + update only: manualLink is never reached, so no second bank line
    // is attached and no journal entry is touched.
    expect(supabase.from).toHaveBeenCalledTimes(2)
  })

  it('leaves the ambiguous N:1 case alone even when neither row is tagged', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: [
      { id: 'tx-a', invoice_id: null, supplier_invoice_id: null },
      { id: 'tx-b', invoice_id: null, supplier_invoice_id: null },
    ] })

    const result = await autoReconcileTransactionForLinkedVoucher(
      supabase as never, 'company-1', 'user-1', 'je-1', { supplierInvoiceId: 'si-9' },
    )

    expect(result).toBeNull()
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('reports nothing tagged when the tag update fails', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: [{ id: 'tx-existing', invoice_id: null, supplier_invoice_id: null }] })
    enqueue({ error: { message: 'permission denied' } })

    const result = await autoReconcileTransactionForLinkedVoucher(
      supabase as never, 'company-1', 'user-1', 'je-1', { supplierInvoiceId: 'si-9' },
    )

    expect(result).toBeNull()
  })

  it('does nothing when the voucher has no cash-account line (AR/AP reclass)', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: [] })
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
    enqueue({ data: [] })
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
    enqueue({ data: [] })
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
    enqueue({ data: [] })
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
    enqueue({ data: [] })
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
    enqueue({ data: [] })
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
    enqueue({ data: [] })
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
    enqueue({ data: [] })
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
    enqueue({ data: [] })
    enqueue({ data: { id: 'je-1', entry_date: '2026-05-10', status: 'draft' } })

    const result = await autoReconcileTransactionForLinkedVoucher(
      supabase as never, 'company-1', 'user-1', 'je-1', { invoiceId: 'inv-1' },
    )

    expect(result).toBeNull()
  })
})
