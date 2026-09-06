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
import { JournalEntryNotBalancedError } from '@/lib/bookkeeping/errors'
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

const mockReverseEntry = vi.fn()
const mockFindFiscalPeriod = vi.fn()
const mockCreateJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>(
    '@/lib/bookkeeping/engine',
  )
  return {
    ...actual,
    reverseEntry: (...args: unknown[]) => mockReverseEntry(...args),
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
  mockReverseEntry.mockResolvedValue({ id: 'je-storno' })
  // The accrual match path builds its clearing entry via findFiscalPeriod +
  // createJournalEntry (shared-builder parity with the dashboard/v1 routes).
  mockFindFiscalPeriod.mockResolvedValue('fp-1')
  mockCreateJournalEntry.mockResolvedValue({ id: 'je-pay' })
})

describe('match_transaction_invoice: partial commit after the storno', () => {
  it('lands failed_partial with the reversal voucher id when the payment JE throws after the storno', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const updates = recordUpdates(supabase)
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { ...baseTransaction, journal_entry_id: 'je-old' }, error: null }) // transaction fetch
    enqueue({ data: baseInvoice, error: null }) // invoice fetch
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
    enqueue({ data: null, error: null }) // transactions unlink after storno
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    mockCreateJournalEntry.mockRejectedValue(new JournalEntryNotBalancedError(500, 400))

    const op = makePendingOp({ params: { transaction_id: 'tx-1', invoice_id: 'inv-1' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(mockReverseEntry).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', 'je-old')
    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(500)
    expect(result.code).toBe('partial_commit')
    expect(result.data).toEqual({ posted_ids: { reversal_journal_entry_id: 'je-storno' } })

    const opUpdates = pendingOpUpdates(updates)
    // First write is the atomic claim, second is the terminal status.
    expect(opUpdates[0]?.payload).toEqual({ status: 'committing' })
    expect(opUpdates[1]?.payload).toMatchObject({
      status: 'failed_partial',
      result_data: {
        threw: true,
        posted_ids: { reversal_journal_entry_id: 'je-storno' },
      },
    })
    expect(opUpdates[1]?.payload.resolved_at).toBeTruthy()
  })

  it('lands failed_partial with the payment JE id when the invoice CAS update matches zero rows', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const updates = recordUpdates(supabase)
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: baseTransaction, error: null }) // transaction fetch (no prior JE: no storno)
    enqueue({ data: baseInvoice, error: null }) // invoice fetch
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
    enqueue({ data: [], error: null }) // invoice CAS update: zero rows (raced fully-paid)
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const op = makePendingOp({ params: { transaction_id: 'tx-1', invoice_id: 'inv-1' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    // A 409 AFTER the payment voucher posted must NOT auto-reject: it is a
    // partial commit and the posted JE id must be surfaced.
    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(409)
    expect(result.auto_rejected).toBeUndefined()
    expect(result.code).toBe('partial_commit')
    expect(result.data).toEqual({ posted_ids: { payment_journal_entry_id: 'je-pay' } })

    const opUpdates = pendingOpUpdates(updates)
    expect(opUpdates[1]?.payload).toMatchObject({
      status: 'failed_partial',
      result_data: {
        http_status: 409,
        posted_ids: { payment_journal_entry_id: 'je-pay' },
      },
    })
  })

  it('keeps the clean rejected path when the failure happens BEFORE anything is posted', async () => {
    // The settlement-account lookup now runs before the storno: an infra
    // failure there must reject the op with nothing posted and must NOT be
    // labeled a partial commit.
    const { supabase, enqueue } = createQueuedMockSupabase()
    const updates = recordUpdates(supabase)
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: { ...baseTransaction, journal_entry_id: 'je-old', cash_account_id: 'ca-broken' },
      error: null,
    }) // transaction fetch
    enqueue({ data: baseInvoice, error: null }) // invoice fetch
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
    enqueue({ data: null, error: { message: 'connection reset' } }) // cash_accounts lookup errors
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const op = makePendingOp({ params: { transaction_id: 'tx-1', invoice_id: 'inv-1' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(mockReverseEntry).not.toHaveBeenCalled()
    expect(result.status).toBe('failed')
    expect(result.code).toBeUndefined()

    const opUpdates = pendingOpUpdates(updates)
    expect(opUpdates[1]?.payload).toMatchObject({
      status: 'rejected',
      result_data: { threw: true },
    })
  })

  it('keeps the 409 auto-reject when the CAS update races and no voucher was posted', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const updates = recordUpdates(supabase)
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: baseTransaction, error: null }) // transaction fetch
    enqueue({ data: baseInvoice, error: null }) // invoice fetch
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
    enqueue({ data: [], error: null }) // invoice CAS update: zero rows
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    // JE creation "succeeded" with null (e.g. no open fiscal period):
    // nothing was posted, so today's auto-reject semantics must survive.
    mockCreateJournalEntry.mockResolvedValue(null)

    const op = makePendingOp({ params: { transaction_id: 'tx-1', invoice_id: 'inv-1' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.auto_rejected).toBe(true)
    expect(result.http_status).toBe(409)

    const opUpdates = pendingOpUpdates(updates)
    expect(opUpdates[1]?.payload).toMatchObject({
      status: 'rejected',
      result_data: { auto_rejected: true },
    })
  })
})

describe('credit_invoice: partial commit after the credit note persisted', () => {
  const originalInvoice = {
    id: 'inv-1',
    invoice_number: 'F-2026001',
    status: 'sent',
    document_type: 'invoice',
    customer_id: 'cust-1',
    delivery_date: null,
    currency: 'SEK',
    exchange_rate: null,
    exchange_rate_date: null,
    subtotal: 400,
    subtotal_sek: 400,
    vat_amount: 100,
    vat_amount_sek: 100,
    total: 500,
    total_sek: 500,
    vat_treatment: 'standard_25',
    vat_rate: 25,
    moms_ruta: null,
    reverse_charge_text: null,
    your_reference: null,
    our_reference: null,
    journal_entry_id: null,
    default_dimensions: {},
    items: [],
  }

  it('lands failed_partial with the credit note id when the credit-note JE throws', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const updates = recordUpdates(supabase)
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: originalInvoice, error: null }) // original invoice fetch
    enqueue({ data: { id: 'cn-1', invoice_date: '2026-07-22' }, error: null }) // credit note insert
    enqueue({ data: null, error: null }) // invoice_items insert
    enqueue({ data: null, error: null }) // original invoice -> credited
    enqueue({
      data: { id: 'cn-1', invoice_date: '2026-07-22', items: [], customer: { name: 'Kund AB' } },
      error: null,
    }) // complete credit note fetch
    enqueue({ data: { entity_type: 'aktiebolag', accounting_method: 'accrual' }, error: null }) // settings
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    mockCreateCreditNoteEntry.mockRejectedValue(new JournalEntryNotBalancedError(500, 400))

    const op = makePendingOp({
      operation_type: 'credit_invoice',
      params: { invoice_id: 'inv-1' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.code).toBe('partial_commit')
    expect(result.data).toEqual({
      posted_ids: { credit_note_id: 'cn-1', original_invoice_id: 'inv-1' },
    })

    const opUpdates = pendingOpUpdates(updates)
    expect(opUpdates[1]?.payload).toMatchObject({
      status: 'failed_partial',
      result_data: {
        threw: true,
        posted_ids: { credit_note_id: 'cn-1', original_invoice_id: 'inv-1' },
      },
    })
  })

  it('keeps the clean rejected path when the credit note itself fails to persist', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const updates = recordUpdates(supabase)
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: originalInvoice, error: null }) // original invoice fetch
    enqueue({ data: null, error: { message: 'insert failed' } }) // credit note insert fails
    enqueue({ data: null, error: null }) // dispatcher pending_operations update

    const op = makePendingOp({
      operation_type: 'credit_invoice',
      params: { invoice_id: 'inv-1' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.code).toBeUndefined()
    expect(mockCreateCreditNoteEntry).not.toHaveBeenCalled()

    const opUpdates = pendingOpUpdates(updates)
    expect(opUpdates[1]?.payload).toMatchObject({ status: 'rejected' })
  })
})
