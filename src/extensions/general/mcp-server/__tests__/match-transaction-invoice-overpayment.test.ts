/**
 * gnubok_match_transaction_to_invoice and gnubok_auto_match_period: the
 * overpayment guard at stage time (crm#253).
 *
 * A bank transaction that overshoots the invoice's remaining amount by 1 kr
 * or more used to stage cleanly and fail only at approval with
 * MATCH_AMOUNT_EXCEEDS_REMAINING. Staging now runs the same payment plan the
 * commit executor runs (planTransactionInvoiceMatch) and refuses the doomed
 * op, naming the amounts and the routes that do book an overpayment. A
 * sub-krona overshoot (öresavrundning, 3740), an exact payment and a partial
 * payment still stage.
 *
 * With overpayment_account (pure SEK) the match stages instead: the invoice
 * settles for its remaining amount and the excess is booked on 2420 (any
 * amount) or 3740 (under 10 kr), named on the approval card.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { getStructuredError } from '@/lib/errors/get-structured-error'

const { mockDetectCandidate, mockFindMatchingInvoices } = vi.hoisted(() => ({
  mockDetectCandidate: vi.fn(),
  mockFindMatchingInvoices: vi.fn(),
}))
vi.mock('@/lib/invoices/duplicate-payment-detection', () => ({
  detectDuplicatePaymentVoucher: mockDetectCandidate,
  detectExplainingVoucherSetForTransaction: vi.fn(async () => null),
}))
vi.mock('@/lib/invoices/invoice-matching', () => ({
  findMatchingInvoices: mockFindMatchingInvoices,
}))

import { tools } from '../server'

const match = tools.find((t) => t.name === 'gnubok_match_transaction_to_invoice')!
const autoMatch = tools.find((t) => t.name === 'gnubok_auto_match_period')!

const TX_ID = '11111111-1111-4111-8111-111111111111'
const INV_ID = '22222222-2222-4222-8222-222222222222'

function txRow(amount: number, currency = 'SEK') {
  return {
    id: TX_ID,
    description: 'BG INBET',
    merchant_name: null,
    amount,
    currency,
    amount_sek: null,
    exchange_rate: currency === 'SEK' ? null : 11.5,
    date: '2026-09-30',
    invoice_id: null,
  }
}

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INV_ID,
    invoice_number: 'F-2026042',
    status: 'sent',
    document_type: 'invoice',
    total: 812.40,
    paid_amount: 0,
    remaining_amount: 812.40,
    currency: 'SEK',
    invoice_date: '2026-09-01',
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

function enqueueReads(
  enqueue: (r: { data?: unknown; error?: unknown }) => void,
  amount: number,
  invoice: Record<string, unknown> = {},
) {
  enqueue({ data: txRow(amount), error: null })
  enqueue({ data: invoiceRow(invoice), error: null })
}

function enqueueStage(enqueue: (r: { data?: unknown; error?: unknown }) => void) {
  enqueue({ data: { bookkeeping_locked_through: null }, error: null }) // company_settings
  enqueue({ data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null }) // fiscal_periods
  enqueue({ data: { id: 'op-match-1' }, error: null }) // pending_operations insert
}

function tablesTouched(supabase: { from: unknown }) {
  return (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDetectCandidate.mockResolvedValue(null)
})

describe('gnubok_match_transaction_to_invoice: overpayment guard at stage time', () => {
  it('refuses to stage an overshoot of 1 kr or more, coded like the approval, naming the amounts and the routes', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueReads(enqueue, 814)

    const err = await run(supabase).then(
      () => null,
      (e: Error & { code?: string; remediation?: { description: string } }) => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect(err!.code).toBe('MATCH_AMOUNT_EXCEEDS_REMAINING')
    // The three amounts, in the invoice's currency.
    expect(err!.message).toContain('the transaction (814.00 SEK)')
    expect(err!.message).toContain("remaining amount (812.40 SEK)")
    expect(err!.message).toContain('by 1.60 SEK')
    // Why approval would reject it: the öre band the commit absorbs.
    expect(err!.message).toContain('under 1.00 SEK')
    expect(err!.message).toContain('rounding difference on 3740')
    // The routes that exist today, with the amounts filled in.
    expect(err!.message).toContain('gnubok_match_batch_allocate (allocations summing to 814.00 SEK)')
    expect(err!.message).toContain('overpayment_account: "2420" books the excess as an advance from the customer')
    expect(err!.message).toContain('"3740" as a rounding difference (only under 10.00 SEK')
    expect(err!.message).toContain('the invoice then settles for exactly 812.40 SEK in the same verifikat')
    expect(err!.message).not.toContain('gnubok_mark_invoice_as_paid')
    expect(err!.message).toContain('Ask the user where the excess belongs')
    expect(err!.remediation?.description).toContain('Do not retry this match unchanged')
    // Nothing was staged.
    expect(tablesTouched(supabase)).not.toContain('pending_operations')
  })

  it('reaches the agent as the standard error envelope: permanent, English with the amounts, Swedish from the registry', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueReads(enqueue, 814)

    const err = await run(supabase).then(() => null, (e: unknown) => e)
    const envelope = getStructuredError(err)
    expect(envelope.code).toBe('MATCH_AMOUNT_EXCEEDS_REMAINING')
    expect(envelope.retryable).toBe(false)
    expect(envelope.message_en).toContain('1.60 SEK')
    expect(envelope.message_sv).toContain('Transaktionsbeloppet är större än fakturans återstående belopp')
    expect(envelope.remediation?.description).toContain('gnubok_match_batch_allocate')
  })

  it('on a partially paid SEK invoice offers overpayment_account against the remaining after earlier payments', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueReads(enqueue, 405, { status: 'partially_paid', total: 1000, paid_amount: 600, remaining_amount: 400 })

    const err = await run(supabase).then(() => null, (e: Error & { code?: string }) => e)
    expect(err!.code).toBe('MATCH_AMOUNT_EXCEEDS_REMAINING')
    expect(err!.message).toContain('remaining amount (400.00 SEK) by 5.00 SEK')
    expect(err!.message).toContain('settles for exactly 400.00 SEK in the same verifikat')
    expect(err!.message).not.toContain('gnubok_link_invoice_to_voucher')
    expect(tablesTouched(supabase)).not.toContain('pending_operations')
  })

  it('leaves 3740 out of the routes when the excess is 10 kr or more', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueReads(enqueue, 822.40)

    const err = await run(supabase).then(() => null, (e: Error & { code?: string }) => e)
    expect(err!.code).toBe('MATCH_AMOUNT_EXCEEDS_REMAINING')
    expect(err!.message).toContain('by 10.00 SEK')
    expect(err!.message).toContain('overpayment_account: "2420"')
    expect(err!.message).not.toContain('"3740"')
  })

  it('on a same-currency foreign invoice points at the separate-verifikat routes (no overpayment_account)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow(105, 'EUR'), error: null })
    enqueue({ data: invoiceRow({ currency: 'EUR', total: 100, remaining_amount: 100 }), error: null })

    const err = await run(supabase).then(() => null, (e: Error & { code?: string }) => e)
    expect(err!.code).toBe('MATCH_AMOUNT_EXCEEDS_REMAINING')
    expect(err!.message).toContain('a cross-currency match cannot settle more than the remaining amount')
    expect(err!.message).toContain('gnubok_mark_invoice_as_paid (payment_date 2026-09-30; it books exactly 100.00 EUR)')
    expect(err!.message).toContain('gnubok_reconcile_match pair (allocations 100.00 EUR and 5.00 EUR)')
    expect(err!.message).not.toContain('overpayment_account')
  })

  it('on a partially paid foreign invoice points at the one-verifikat route instead of mark-paid', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow(405, 'EUR'), error: null })
    enqueue({
      data: invoiceRow({ currency: 'EUR', status: 'partially_paid', total: 1000, paid_amount: 600, remaining_amount: 400 }),
      error: null,
    })

    const err = await run(supabase).then(() => null, (e: Error & { code?: string }) => e)
    expect(err!.code).toBe('MATCH_AMOUNT_EXCEEDS_REMAINING')
    expect(err!.message).toContain('credit 1510 400.00 EUR')
    expect(err!.message).toContain('gnubok_link_invoice_to_voucher')
    expect(err!.message).not.toContain('gnubok_mark_invoice_as_paid')
  })

  it('still stages a sub-krona overshoot: öresavrundning settles it in full at approval', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueueReads(enqueue, 813)
    enqueueStage(enqueue)

    const result = (await run(supabase)) as { staged: boolean }
    expect(result.staged).toBe(true)
    const inserted = findCall('pending_operations', 'insert')?.[0] as { params: Record<string, unknown> }
    expect(inserted.params).toEqual({ transaction_id: TX_ID, invoice_id: INV_ID })
  })

  it('still stages an exact payment', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueReads(enqueue, 812.40)
    enqueueStage(enqueue)

    await expect(run(supabase)).resolves.toMatchObject({ staged: true })
  })

  it('still stages a partial payment, measured against the remaining after earlier payments', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueReads(enqueue, 300, { status: 'partially_paid', total: 1000, paid_amount: 600, remaining_amount: 400 })
    enqueueStage(enqueue)

    await expect(run(supabase)).resolves.toMatchObject({ staged: true })
  })
})

describe('gnubok_match_transaction_to_invoice: overpayment_account', () => {
  function staged(findCall: (table: string, method: string) => unknown[] | undefined) {
    return findCall('pending_operations', 'insert')?.[0] as {
      params: Record<string, unknown>
      preview_data: Record<string, unknown>
    }
  }

  it('stages a rounded-up payment with the excess on 3740 and names it on the approval card', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueueReads(enqueue, 340, { total: 337.5, remaining_amount: 337.5 })
    enqueueStage(enqueue)

    const result = (await run(supabase, { overpayment_account: '3740' })) as { staged: boolean; message: string }
    expect(result.staged).toBe(true)
    const op = staged(findCall)
    expect(op.params).toEqual({
      transaction_id: TX_ID,
      invoice_id: INV_ID,
      overpayment_account: '3740',
      overpayment_amount: 2.5,
    })
    expect(op.preview_data).toMatchObject({ overpayment_amount: 2.5, overpayment_account: '3740' })
    expect(op.preview_data.compliance_warning).toBe('Överskottet 2,50 kr bokförs som kronutjämning på 3740.')
    expect(result.message).toContain('kronutjämning på 3740')
  })

  it('stages any excess on 2420 as a liability to the customer', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueueReads(enqueue, 1312.40)
    enqueueStage(enqueue)

    await expect(run(supabase, { overpayment_account: '2420' })).resolves.toMatchObject({ staged: true })
    const op = staged(findCall)
    expect(op.params).toMatchObject({ overpayment_account: '2420', overpayment_amount: 500 })
    expect(op.preview_data.compliance_warning).toContain('bokförs på 2420 Förskott från kunder')
  })

  it('refuses 3740 for an excess of 10 kr or more and points at 2420', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueReads(enqueue, 822.40)

    const err = await run(supabase, { overpayment_account: '3740' }).then(
      () => null,
      (e: Error & { code?: string }) => e,
    )
    expect(err!.code).toBe('MATCH_OVERPAYMENT_ROUNDING_CAP')
    expect(err!.message).toContain('the excess (10.00 SEK) is 10.00 SEK or more')
    expect(err!.message).toContain('overpayment_account: "2420"')
    expect(getStructuredError(err).message_sv).toContain('2420')
    expect(tablesTouched(supabase)).not.toContain('pending_operations')
  })

  it('rejects an account outside 2420 and 3740 before reading anything', async () => {
    const { supabase } = createQueuedMockSupabase()

    const err = await run(supabase, { overpayment_account: '3990' }).then(
      () => null,
      (e: Error & { code?: string }) => e,
    )
    expect(err!.code).toBe('VALIDATION_ERROR')
    expect(tablesTouched(supabase)).toEqual([])
  })

  it('stages an exact payment without any overpayment params even when the account is passed', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueueReads(enqueue, 812.40)
    enqueueStage(enqueue)

    await run(supabase, { overpayment_account: '2420' })
    expect(staged(findCall).params).toEqual({ transaction_id: TX_ID, invoice_id: INV_ID })
    expect(staged(findCall).preview_data.compliance_warning).toBeUndefined()
  })

  it('keeps refusing a foreign overshoot: the excess has no SEK amount the user agreed to', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow(105, 'EUR'), error: null })
    enqueue({ data: invoiceRow({ currency: 'EUR', total: 100, remaining_amount: 100 }), error: null })

    const err = await run(supabase, { overpayment_account: '2420' }).then(
      () => null,
      (e: Error & { code?: string }) => e,
    )
    expect(err!.code).toBe('MATCH_AMOUNT_EXCEEDS_REMAINING')
  })
})

describe('gnubok_auto_match_period: the same guard when staging proposals', () => {
  it('reports an overshooting proposal in stage_failures and stages the rest', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        { ...txRow(814), id: 't-over', reference: null, journal_entry_id: null },
        { ...txRow(812.40), id: 't-exact', reference: null, journal_entry_id: null },
      ],
      error: null,
    })
    enqueue({ data: { id: 'op-auto-1' }, error: null }) // pending_operations insert for t-exact
    mockFindMatchingInvoices
      .mockResolvedValueOnce([{ invoice: { ...invoiceRow(), id: 'i-over' }, confidence: 0.95, matchReason: 'OCR' }])
      .mockResolvedValueOnce([{ invoice: { ...invoiceRow(), id: 'i-exact' }, confidence: 0.95, matchReason: 'OCR' }])

    const result = (await autoMatch.execute(
      { date_from: '2026-09-01', date_to: '2026-09-30', dry_run: false },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' } as never,
    )) as {
      staged_count: number
      stage_failures: { transaction_id: string; invoice_id: string; error: string }[]
    }

    expect(result.staged_count).toBe(1)
    expect(result.stage_failures).toHaveLength(1)
    expect(result.stage_failures[0]).toMatchObject({ transaction_id: 't-over', invoice_id: 'i-over' })
    expect(result.stage_failures[0].error).toContain('exceeds the invoice\'s remaining amount (812.40 SEK) by 1.60 SEK')
    // auto_match_period takes no overpayment_account: the route names the match tool.
    expect(result.stage_failures[0].error).toContain('call gnubok_match_transaction_to_invoice with overpayment_account')
    const inserts = findCalls('pending_operations', 'insert')
    expect(inserts).toHaveLength(1)
    expect((inserts[0][0] as { params: Record<string, unknown> }).params).toEqual({
      transaction_id: 't-exact',
      invoice_id: 'i-exact',
    })
  })
})
