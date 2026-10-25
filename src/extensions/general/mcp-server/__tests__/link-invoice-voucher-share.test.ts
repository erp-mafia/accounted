/**
 * gnubok_link_invoice_to_voucher: the stated share (`amount`) of a verifikat
 * that settles several customer invoices (crm#1434), the mirror of
 * link-supplier-invoice-voucher-share.test.ts.
 *
 * The validator is pinned in lib/invoices/__tests__/voucher-matching-share
 * .test.ts and the RPC in tests/pg/link-invoice-voucher-share.pg.test.ts. What
 * is pinned here is the tool's own part: the share reaches the validator, the
 * staged params (what approval commits) and the preview (what the approver
 * reads), and the refusal an agent gets without a share tells it to state
 * one instead of correcting the verifikat.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

const { mockValidate } = vi.hoisted(() => ({ mockValidate: vi.fn() }))
vi.mock('@/lib/invoices/voucher-matching', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/voucher-matching')>()),
  validateVoucherForInvoiceLink: mockValidate,
}))

// The sale-first planner (defer_invoice_booking) has its own suite; here no
// invoice needs its sale booked first.
vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSaleBeforeSettlement: vi.fn(async () => ({ ok: true, required: false })),
}))

import { tools } from '../server'
import { toToolError } from '../tool-result'

const link = tools.find((t) => t.name === 'gnubok_link_invoice_to_voucher')!

const INV_ID = '11111111-1111-4111-8111-111111111111'
const JE_ID = '22222222-2222-4222-8222-222222222222'

const invoiceRow = {
  id: INV_ID,
  invoice_number: '1042',
  status: 'overdue',
  document_type: 'invoice',
  credited_invoice_id: null,
  currency: 'SEK',
  total: 1500,
  paid_amount: 0,
  remaining_amount: 1500,
  due_date: '2024-04-17',
  paid_at: null,
  exchange_rate: null,
  journal_entry_id: null,
  customer_id: 'cust-1',
  customer: { id: 'cust-1', name: 'Kund AB' },
}

/** The validator's answer for a verifikat crediting 6 000 kr on 1510. */
const validated = (payment: number, left: number) => ({
  ok: true,
  arCreditAmount: 6000,
  arLineCurrency: 'SEK',
  voucher: {
    id: JE_ID,
    voucher_series: 'A',
    voucher_number: 285,
    entry_date: '2025-12-31',
    description: 'Konstaterade kundförluster',
    status: 'posted',
    source_type: 'import',
    fiscal_period_id: 'fp-1',
  },
  remainingAfter: 1500 - payment,
  isFullyPaid: payment >= 1500,
  paymentAmount: payment,
  voucherRemainingAfter: left,
})

function mockDb() {
  return createTableMockSupabase({
    invoices: { data: invoiceRow },
    pending_operations: { data: { id: 'op-link-1' } },
  })
}

function run(supabase: unknown, extra: Record<string, unknown> = {}) {
  return link.execute(
    { invoice_id: INV_ID, journal_entry_id: JE_ID, ...extra },
    'company-1',
    'user-1',
    supabase as never,
    { type: 'api_key' } as never,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_link_invoice_to_voucher: a stated share', () => {
  it('declares amount in its input schema, optional', () => {
    const properties = (link.inputSchema as { properties: Record<string, { type: string }> }).properties
    expect(properties.amount.type).toBe('number')
    expect((link.inputSchema as { required: string[] }).required).not.toContain('amount')
  })

  it('stages the share: validated, kept in the params approval commits, and shown to the approver', async () => {
    const { supabase, findCall } = mockDb()
    mockValidate.mockResolvedValue(validated(1500, 4500))

    const result = (await run(supabase, { amount: 1500 })) as { staged: boolean }

    expect(mockValidate).toHaveBeenCalledWith(supabase, 'company-1', expect.objectContaining({ id: INV_ID }), JE_ID, 1500)
    expect(result.staged).toBe(true)
    const inserted = findCall('pending_operations', 'insert')![0] as {
      operation_type: string
      title: string
      params: Record<string, unknown>
      preview_data: Record<string, unknown>
    }
    expect(inserted.operation_type).toBe('link_invoice_voucher')
    expect(inserted.params).toEqual({ invoice_id: INV_ID, journal_entry_id: JE_ID, notes: undefined, amount: 1500 })
    // payment_amount is the share, not the whole verifikat.
    expect(inserted.preview_data).toMatchObject({
      ar_credit_amount: 6000,
      payment_amount: 1500,
      will_be_fully_paid: true,
      remaining_after: 0,
      voucher_remaining_after: 4500,
    })
    expect(inserted.title).toContain('A-285')
    expect(inserted.title).toContain('1500 SEK av verifikatet')
  })

  it('without a share the staged params carry no amount and the preview no leftover line', async () => {
    const { supabase, findCall } = mockDb()
    mockValidate.mockResolvedValue({ ...validated(1500, 0), arCreditAmount: 1500 })

    await run(supabase)

    expect(mockValidate).toHaveBeenCalledWith(supabase, 'company-1', expect.anything(), JE_ID, undefined)
    const inserted = findCall('pending_operations', 'insert')![0] as {
      title: string
      params: Record<string, unknown>
      preview_data: Record<string, unknown>
    }
    expect(inserted.params).toEqual({ invoice_id: INV_ID, journal_entry_id: JE_ID, notes: undefined })
    expect('amount' in inserted.params).toBe(false)
    expect('voucher_remaining_after' in inserted.preview_data).toBe(false)
    expect(inserted.title).not.toContain('av verifikatet')
  })

  it('refuses a share that is not a number before validating or staging anything', async () => {
    const { supabase, findCall } = mockDb()

    const error = await run(supabase, { amount: '1500' }).then(
      () => null,
      (err: unknown) => toToolError(err, { toolName: link.name }).error,
    )

    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', retryable: false })
    expect(mockValidate).not.toHaveBeenCalled()
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('the refusal without a share tells the agent to state one, and never to correct the verifikat', async () => {
    const { supabase, findCall } = mockDb()
    mockValidate.mockResolvedValue({
      ok: false,
      code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      details: { ar_credit: 6000, remaining: 1500 },
    })

    const error = await run(supabase).then(
      () => null,
      (err: unknown) => toToolError(err, { toolName: link.name }).error,
    )

    expect(error).toMatchObject({ code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING', retryable: false })
    expect(error!.message_en).toContain('call again with amount')
    expect(error!.message_en).toContain('Details: {"ar_credit":6000,"remaining":1500}')
    expect(error!.message_en).not.toContain('gnubok_correct_entry')
    expect(error!.remediation).toMatchObject({ tool: 'gnubok_link_invoice_to_voucher' })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })
})
