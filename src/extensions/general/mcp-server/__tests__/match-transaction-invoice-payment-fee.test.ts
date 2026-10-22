/**
 * gnubok_match_transaction_to_invoice: a payment provider's fee (crm#1364).
 *
 * A customer paid an invoice in full by card through a payment link; the
 * provider paid out the amount net of its fee. With fee_account "6570" the
 * match settles the invoice in full and books the fee on 6570 in the same
 * verifikat. Without it a kontantmetod invoice that was never booked is
 * refused at stage time (the approval refused it anyway), and the refusal
 * names fee_account when the gap could be a fee.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSaleBeforeSettlement: vi.fn(async () => ({ ok: true, required: false })),
}))
import { createQueuedMockSupabase } from '@/tests/helpers'
import { getStructuredError } from '@/lib/errors/get-structured-error'

const { mockDetectCandidate } = vi.hoisted(() => ({ mockDetectCandidate: vi.fn() }))
vi.mock('@/lib/invoices/duplicate-payment-detection', () => ({
  detectDuplicatePaymentVoucher: mockDetectCandidate,
  detectExplainingVoucherSetForTransaction: vi.fn(async () => null),
}))

import { tools } from '../server'

const match = tools.find((t) => t.name === 'gnubok_match_transaction_to_invoice')!

const TX_ID = '11111111-1111-4111-8111-111111111111'
const INV_ID = '22222222-2222-4222-8222-222222222222'

function txRow(amount: number) {
  return {
    id: TX_ID,
    description: 'STRIPE PAYOUT',
    merchant_name: null,
    amount,
    currency: 'SEK',
    amount_sek: null,
    exchange_rate: null,
    date: '2026-10-21',
    invoice_id: null,
  }
}

// 10 000,00 incl. moms, never booked (kontantmetoden books it at payment).
function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INV_ID,
    invoice_number: '001',
    status: 'sent',
    document_type: 'invoice',
    total: 10000,
    paid_amount: 0,
    remaining_amount: 10000,
    currency: 'SEK',
    invoice_date: '2026-09-25',
    journal_entry_id: null,
    customer: { name: 'Kund AB' },
    ...overrides,
  }
}

function run(supabase: unknown, extra: Record<string, unknown> = {}) {
  return match.execute(
    { transaction_id: TX_ID, invoice_id: INV_ID, ...extra },
    'company-1',
    'user-1',
    supabase as never,
    { type: 'api_key' } as never,
  )
}

type Enqueue = (r: { data?: unknown; error?: unknown }) => void

function enqueueReads(enqueue: Enqueue, amount: number, invoice: Record<string, unknown> = {}) {
  enqueue({ data: txRow(amount), error: null })
  enqueue({ data: invoiceRow(invoice), error: null })
}

function enqueueStage(enqueue: Enqueue) {
  enqueue({ data: { bookkeeping_locked_through: null }, error: null }) // company_settings
  enqueue({ data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null }) // fiscal_periods
  enqueue({ data: { id: 'op-match-1' }, error: null }) // pending_operations insert
}

function tablesTouched(supabase: { from: unknown }) {
  return (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
}

function refusal(promise: Promise<unknown>) {
  return promise.then(
    () => null,
    (e: Error & { code?: string; remediation?: { description: string } }) => e,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDetectCandidate.mockResolvedValue(null)
})

describe('gnubok_match_transaction_to_invoice: fee_account (crm#1364)', () => {
  it('stages a payout net of the fee as a full settlement, the fee on 6570 named on the approval card', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueueReads(enqueue, 9809.5)
    enqueueStage(enqueue)

    const result = (await run(supabase, { fee_account: '6570' })) as { staged: boolean; message: string }
    expect(result.staged).toBe(true)
    const op = findCall('pending_operations', 'insert')?.[0] as {
      params: Record<string, unknown>
      preview_data: Record<string, unknown>
    }
    expect(op.params).toEqual({ transaction_id: TX_ID, invoice_id: INV_ID, fee_account: '6570', fee_amount: 190.5 })
    expect(op.preview_data).toMatchObject({ fee_amount: 190.5, fee_account: '6570' })
    expect(op.preview_data.compliance_warning).toContain('Mellanskillnaden 190,50 kr är betaltjänstens avgift')
    expect(op.preview_data.compliance_warning).toContain('6570 Bankkostnader, utan moms')
    // A full settlement: the kontantmetoden guard has nothing to read.
    expect(tablesTouched(supabase).filter((t) => t === 'company_settings')).toHaveLength(1)
  })

  it('refuses a kontantmetod partial at stage time and names fee_account when the gap could be a fee', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueReads(enqueue, 9809.5)
    enqueue({ data: { accounting_method: 'cash' }, error: null })

    const err = await refusal(run(supabase))
    expect(err!.code).toBe('INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED')
    expect(err!.message).toContain('the transaction (9809.50 SEK) does not settle the remaining 10000.00 SEK')
    expect(err!.message).toContain('If the 190.50 SEK gap is a fee a payment provider')
    expect(err!.message).toContain('fee_account: "6570"')
    expect(err!.remediation?.description).toContain('fee_account "6570"')
    const envelope = getStructuredError(err)
    expect(envelope.retryable).toBe(false)
    expect(envelope.message_sv).toContain('Kontantmetoden kan inte bokföra delbetalningar')
    expect(tablesTouched(supabase)).not.toContain('pending_operations')
  })

  it('refuses a kontantmetod partial too large to be a fee without suggesting fee_account', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueReads(enqueue, 4000)
    enqueue({ data: { accounting_method: 'cash' }, error: null })

    const err = await refusal(run(supabase))
    expect(err!.code).toBe('INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED')
    expect(err!.message).not.toContain('fee_account')
    expect(err!.message).toContain('gnubok_create_voucher')
    expect(tablesTouched(supabase)).not.toContain('pending_operations')
  })

  it('refuses a partial when the accounting method cannot be read, never passing it as faktureringsmetoden (#58)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueReads(enqueue, 9809.5)
    enqueue({ data: null, error: { message: 'connection reset' } })

    const err = await refusal(run(supabase))
    expect(err!.code).toBe('SETTINGS_ACCOUNTING_METHOD_UNREADABLE')
    expect(tablesTouched(supabase)).not.toContain('pending_operations')
  })

  it('refuses the last payment of a kontantmetod invoice already part-paid', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueReads(enqueue, 190.5, { status: 'partially_paid', paid_amount: 9809.5, remaining_amount: 190.5 })
    enqueue({ data: { accounting_method: 'cash' }, error: null })

    const err = await refusal(run(supabase))
    expect(err!.code).toBe('INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED')
    expect(err!.message).toContain('the invoice is already part-paid')
    expect(err!.message).not.toContain('fee_account')
  })

  it('leaves a faktureringsmetoden partial, and a booked invoice, to stage as before', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueReads(enqueue, 9809.5)
    enqueue({ data: { accounting_method: 'accrual' }, error: null })
    enqueueStage(enqueue)
    await expect(run(supabase)).resolves.toMatchObject({ staged: true })

    // Booked at issue: the clearing entry handles a partial; no method read.
    const booked = createQueuedMockSupabase()
    enqueueReads(booked.enqueue, 9809.5, { journal_entry_id: 'je-sale' })
    enqueueStage(booked.enqueue)
    await expect(run(booked.supabase)).resolves.toMatchObject({ staged: true })
    expect(tablesTouched(booked.supabase).filter((t) => t === 'company_settings')).toHaveLength(1)
  })

  it('refuses fee_account for a gap of a tenth or more of the remaining amount', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueReads(enqueue, 9000)

    const err = await refusal(run(supabase, { fee_account: '6570' }))
    expect(err!.code).toBe('MATCH_PAYMENT_FEE_NOT_ALLOWED')
    expect(err!.message).toContain('is 1000.00 SEK short of')
    expect(err!.message).toContain('under 10% of the remaining amount')
    expect(getStructuredError(err).message_sv).toContain('betaltjänstens avgift')
    expect(tablesTouched(supabase)).not.toContain('pending_operations')
  })

  it('rejects any other fee account before reading anything', async () => {
    const { supabase } = createQueuedMockSupabase()

    const err = await refusal(run(supabase, { fee_account: '6064' }))
    expect(err!.code).toBe('VALIDATION_ERROR')
    expect(tablesTouched(supabase)).toEqual([])
  })

  it('stages an exact payment without fee params even when fee_account is passed', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueueReads(enqueue, 10000)
    enqueueStage(enqueue)

    await run(supabase, { fee_account: '6570' })
    const op = findCall('pending_operations', 'insert')?.[0] as {
      params: Record<string, unknown>
      preview_data: Record<string, unknown>
    }
    expect(op.params).toEqual({ transaction_id: TX_ID, invoice_id: INV_ID })
    expect(op.preview_data.compliance_warning).toBeUndefined()
  })
})
