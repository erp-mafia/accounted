/**
 * failed_partial dispatcher coverage (issue #842).
 *
 * Multi-step executors post an irreversible voucher (or persist a credit
 * note) and then run later fallible steps. When such a later step fails, the
 * dispatcher must land the op in the terminal 'failed_partial' status with
 * the posted ids in result_data.posted_ids, instead of a clean-looking
 * 'rejected' that hides the orphaned voucher. Clean failures (nothing posted
 * yet) must keep today's 'rejected' behavior byte-for-byte.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { PendingOperation } from '@/types'

const mockCreatePaymentEntry = vi.fn()
const mockCreateCashEntry = vi.fn()
const mockCreateCreditNoteEntry = vi.fn()
vi.mock('@/lib/bookkeeping/invoice-entries', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/invoice-entries')>(
    '@/lib/bookkeeping/invoice-entries',
  )
  return {
    ...actual,
    createInvoicePaymentJournalEntry: (...args: unknown[]) => mockCreatePaymentEntry(...args),
    createInvoiceCashEntry: (...args: unknown[]) => mockCreateCashEntry(...args),
    createCreditNoteJournalEntry: (...args: unknown[]) => mockCreateCreditNoteEntry(...args),
  }
})

const mockCancelOrphanedEntry = vi.fn()
const mockFindFiscalPeriod = vi.fn()
const mockCreateJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>(
    '@/lib/bookkeeping/engine',
  )
  return {
    ...actual,
    cancelOrphanedEntry: (...args: unknown[]) => mockCancelOrphanedEntry(...args),
    findFiscalPeriod: (...args: unknown[]) => mockFindFiscalPeriod(...args),
    createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
  }
})

// The soft-duplicate guard runs before the storno (issue #2294). Mocked clean
// so it consumes no slot in the queued Supabase mock; its behaviour is pinned
// by match-transaction-invoice-duplicate-guard.test.ts.
vi.mock('@/lib/invoices/duplicate-payment-detection', () => ({
  detectDuplicatePaymentVoucher: vi.fn(async () => null),
  detectExplainingVoucherSetForTransaction: vi.fn(async () => null),
}))

// Open: the gate has its own suites (is-booked.test.ts, and every shape on real
// Postgres in tests/pg/customer-bank-match-doors.pg.test.ts). Mocked with the
// chart check so neither consumes a slot in the queued Supabase mock.
vi.mock('@/lib/transactions/is-booked', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions/is-booked')>()),
  decideBankRowRebooking: vi.fn(async () => ({ outcome: 'open' })),
}))
vi.mock('@/lib/bookkeeping/account-validation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/account-validation')>()),
  findUnresolvableAccounts: vi.fn(async () => []),
}))
// No invoice here needs its sale booked first; that rule has its own suites.
vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSaleBeforeSettlement: vi.fn(async () => ({ ok: true, required: false })),
}))

import { commitPendingOperation } from '../commit'

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'match_transaction_invoice',
    status: 'pending',
    title: 'test',
    params: {},
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'medium',
    created_at: '2026-07-22T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-07-22T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

/**
 * Wraps the queued mock so every .update(payload) is recorded per table:
 * the queued helper drops call arguments, but these tests must assert WHAT
 * the dispatcher wrote to pending_operations, not only the returned status.
 */
function recordUpdates(supabase: { from: ReturnType<typeof vi.fn> }) {
  const updates: Array<{ table: string; payload: Record<string, unknown> }> = []
  const original = supabase.from.getMockImplementation() as (table: string) => unknown
  supabase.from.mockImplementation((table: string) => {
    const chain = original(table) as object
    return new Proxy(chain, {
      get(target, prop, receiver) {
        if (prop === 'update') {
          return (payload: Record<string, unknown>) => {
            updates.push({ table, payload })
            return (Reflect.get(target, 'update', receiver) as (p: unknown) => unknown)(payload)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
  })
  return updates
}

function pendingOpUpdates(updates: Array<{ table: string; payload: Record<string, unknown> }>) {
  return updates.filter((u) => u.table === 'pending_operations')
}

const baseTransaction = {
  id: 'tx-1',
  company_id: 'company-1',
  amount: 500,
  currency: 'SEK',
  date: '2026-05-12',
  invoice_id: null,
  journal_entry_id: null,
  cash_account_id: null,
}

const baseInvoice = {
  id: 'inv-1',
  invoice_number: 'F-2026001',
  status: 'sent',
  total: 500,
  remaining_amount: 500,
  paid_amount: 0,
  currency: 'SEK',
  exchange_rate: null,
  journal_entry_id: null,
  credited_invoice_id: null,
  customer: { name: 'Kund AB' },
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockCreatePaymentEntry.mockResolvedValue({ id: 'je-pay' })
  mockCreateCashEntry.mockResolvedValue({ id: 'je-pay' })
  mockCreateCreditNoteEntry.mockResolvedValue({ id: 'je-credit' })
  // The accrual match path builds its clearing entry via findFiscalPeriod +
  // createJournalEntry (shared-builder parity with the dashboard/v1 routes).
  mockFindFiscalPeriod.mockResolvedValue('fp-1')
  mockCreateJournalEntry.mockResolvedValue({ id: 'je-pay' })
})

describe('match_transaction_invoice: a failure after the payment verifikat posted', () => {
  it('cancels the verifikat and rejects cleanly when the invoice CAS update matches zero rows', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const updates = recordUpdates(supabase)
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: baseTransaction, error: null }) // transaction fetch
    enqueue({ data: baseInvoice, error: null }) // invoice fetch
    enqueue({ data: [], error: null }) // hard-duplicate check
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
    enqueue({ data: [], error: null }) // cash_accounts fallback listing -> 1930
    enqueue({ data: [{ id: 'tx-1' }], error: null }) // row claim
    enqueue({ data: [], error: null }) // invoice CAS update: zero rows (raced fully-paid)
    enqueue({ data: null, error: null }) // bank row released
    enqueue({ data: null, error: null }) // dispatcher pending_operations update
    mockCancelOrphanedEntry.mockResolvedValue({ error: null })

    const op = makePendingOp({ params: { transaction_id: 'tx-1', invoice_id: 'inv-1' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(mockCancelOrphanedEntry).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', 'je-pay', expect.anything())
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.code).toBe('MATCH_INVOICE_ALREADY_PAID')
    expect(result.operation_status).toBe('rejected')
    expect(pendingOpUpdates(updates)[1]?.payload).toMatchObject({ status: 'rejected' })
  })

  it('lands failed_partial naming the verifikat when it could not be cancelled', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const updates = recordUpdates(supabase)
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: baseTransaction, error: null }) // transaction fetch
    enqueue({ data: baseInvoice, error: null }) // invoice fetch
    enqueue({ data: [], error: null }) // hard-duplicate check
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
    enqueue({ data: [], error: null }) // cash_accounts fallback listing -> 1930
    enqueue({ data: [{ id: 'tx-1' }], error: null }) // row claim
    enqueue({ data: [], error: null }) // invoice CAS update: zero rows (raced fully-paid)
    enqueue({ data: null, error: null }) // bank row released
    enqueue({ data: null, error: null }) // dispatcher pending_operations update
    mockCancelOrphanedEntry.mockResolvedValue({ error: { message: 'refused' } })

    const op = makePendingOp({ params: { transaction_id: 'tx-1', invoice_id: 'inv-1' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    // A 409 with a verifikat standing must NOT auto-reject: it is a partial
    // commit and the posted id must be surfaced.
    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(409)
    expect(result.auto_rejected).toBeUndefined()
    expect(result.code).toBe('partial_commit')
    expect(result.data).toEqual({ posted_ids: { payment_journal_entry_id: 'je-pay' } })
    expect(pendingOpUpdates(updates)[1]?.payload).toMatchObject({
      status: 'failed_partial',
      result_data: { http_status: 409, posted_ids: { payment_journal_entry_id: 'je-pay' } },
    })
  })

  it('keeps the clean rejected path when the failure happens BEFORE anything is posted', async () => {
    // The settlement-account lookup runs before anything is posted: an infra
    // failure there must reject the op and must NOT be labeled a partial commit.
    const { supabase, enqueue } = createQueuedMockSupabase()
    const updates = recordUpdates(supabase)
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: { ...baseTransaction, cash_account_id: 'ca-broken' },
      error: null,
    }) // transaction fetch
    enqueue({ data: baseInvoice, error: null }) // invoice fetch
    enqueue({ data: [], error: null }) // hard-duplicate check
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
    enqueue({ data: null, error: { message: 'connection reset' } }) // cash_accounts lookup errors
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const op = makePendingOp({ params: { transaction_id: 'tx-1', invoice_id: 'inv-1' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.code).toBeUndefined()

    const opUpdates = pendingOpUpdates(updates)
    expect(opUpdates[1]?.payload).toMatchObject({
      status: 'rejected',
      // A person approved and the executor failed: no verdict on the proposal.
      rejection_category: 'failed',
      result_data: { threw: true },
    })
  })

  it('keeps the clean rejected path when the booking posted nothing, without touching the invoice', async () => {
    // A null JE used to carry on to the invoice update (the soft-fail this
    // case pinned as a 409 auto-reject on a race): on a normal run it marked
    // the invoice paid with no verifikat. It now fails closed before the
    // update, and with nothing posted the op is a clean rejection, not a
    // partial commit.
    const { supabase, enqueue } = createQueuedMockSupabase()
    const updates = recordUpdates(supabase)
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: baseTransaction, error: null }) // transaction fetch
    enqueue({ data: baseInvoice, error: null }) // invoice fetch
    enqueue({ data: [], error: null }) // hard-duplicate check
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
    enqueue({ data: [], error: null }) // cash_accounts fallback listing -> 1930
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    mockCreateJournalEntry.mockResolvedValue(null)

    const op = makePendingOp({ params: { transaction_id: 'tx-1', invoice_id: 'inv-1' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.code).toBe('INVOICE_PAID_BOOK_FAILED')
    expect(result.http_status).toBe(500)
    expect(updates.some((u) => u.table === 'invoices')).toBe(false)

    const opUpdates = pendingOpUpdates(updates)
    expect(opUpdates[1]?.payload).toMatchObject({
      status: 'rejected',
      result_data: { http_status: 500 },
    })
  })
})

// credit_invoice no longer persists anything before its verifikat can be
// posted (creditInvoice, fail closed); a verifikat that posted before a later
// step failed lands in failed_partial, pinned in credit-invoice-executor.test.ts.
