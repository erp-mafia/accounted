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

  it('does nothing when a transaction is already reconciled to the voucher', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    enqueue({ data: [{ id: 'tx-existing' }] }) // voucher already has a bank line

    const result = await autoReconcileTransactionForLinkedVoucher(
      supabase as never, 'company-1', 'user-1', 'je-1', { invoiceId: 'inv-1' },
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
    enqueue({ data: [SEK_PRIMARY, { id: CA_1932, ledger_account: '1932', currency: 'EUR', is_primary: false }] })

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
