/**
 * gnubok_link_supplier_invoice_to_voucher: the stated share (`amount`) of a
 * verifikat that pays several debts (GitHub issue 3490), and
 * gnubok_find_voucher_candidates_for_supplier_invoice offering such a
 * verifikat.
 *
 * The validator and the matcher are pinned in
 * lib/invoices/__tests__/supplier-voucher-matching-share.test.ts and the RPC in
 * tests/pg/link-supplier-invoice-voucher-share.pg.test.ts. What is pinned here
 * is the tool's own part: the share reaches the validator, the staged params
 * (what approval commits) and the preview (what the approver reads), and the
 * refusal an agent gets without a share tells it to state one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

const { mockValidate, mockFind } = vi.hoisted(() => ({ mockValidate: vi.fn(), mockFind: vi.fn() }))
vi.mock('@/lib/invoices/supplier-voucher-matching', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/supplier-voucher-matching')>()),
  validateVoucherForSupplierInvoiceLink: mockValidate,
  findMatchingVouchersForSupplierInvoice: mockFind,
}))
const AP_DEBIT = { side: 'ap_debit', accountPrefix: '244', entrySide: 'debit' }
vi.mock('@/lib/invoices/supplier-settlement-side', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/supplier-settlement-side')>()),
  resolveSupplierSettlementSide: vi.fn(async () => AP_DEBIT),
}))

import { tools } from '../server'
import { toToolError } from '../tool-result'

const link = tools.find((t) => t.name === 'gnubok_link_supplier_invoice_to_voucher')!
const find = tools.find((t) => t.name === 'gnubok_find_voucher_candidates_for_supplier_invoice')!

const SI_ID = '11111111-1111-4111-8111-111111111111'
const JE_ID = '22222222-2222-4222-8222-222222222222'

const invoiceRow = {
  id: SI_ID,
  supplier_invoice_number: 'LF-77001',
  arrival_number: 41,
  status: 'registered',
  currency: 'SEK',
  total: 1250,
  paid_amount: 0,
  remaining_amount: 1250,
  due_date: '2026-05-01',
  paid_at: null,
  exchange_rate: null,
  supplier_id: 'sup-1',
  supplier: { id: 'sup-1', name: 'Leverantör AB' },
}

/** The validator's answer for a verifikat of 5 250 kr settling `payment`. */
const validated = (payment: number, left: number) => ({
  ok: true,
  apDebitAmount: 5250,
  settlementSide: 'ap_debit',
  apLineCurrency: 'SEK',
  voucher: {
    id: JE_ID,
    voucher_series: 'A',
    voucher_number: 12,
    entry_date: '2026-04-28',
    description: 'Leverantörsbetalning',
    status: 'posted',
    source_type: 'bank_transaction',
    fiscal_period_id: 'fp-1',
  },
  remainingAfter: 1250 - payment,
  isFullyPaid: payment >= 1250,
  paymentAmount: payment,
  voucherRemainingAfter: left,
})

function mockDb() {
  return createTableMockSupabase({
    supplier_invoices: { data: invoiceRow },
    pending_operations: { data: { id: 'op-link-1' } },
  })
}

function run(supabase: unknown, extra: Record<string, unknown> = {}) {
  return link.execute(
    { supplier_invoice_id: SI_ID, journal_entry_id: JE_ID, ...extra },
    'company-1',
    'user-1',
    supabase as never,
    { type: 'api_key' } as never,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_link_supplier_invoice_to_voucher: a stated share', () => {
  it('declares amount in its input schema', () => {
    const properties = (link.inputSchema as { properties: Record<string, { type: string }> }).properties
    expect(properties.amount.type).toBe('number')
    expect((link.inputSchema as { required: string[] }).required).not.toContain('amount')
  })

  it('stages the share: validated, kept in the params approval commits, and shown to the approver', async () => {
    const { supabase, findCall } = mockDb()
    mockValidate.mockResolvedValue(validated(1250, 4000))

    const result = (await run(supabase, { amount: 1250 })) as { staged: boolean; preview: Record<string, unknown> }

    expect(mockValidate).toHaveBeenCalledWith(supabase, 'company-1', expect.objectContaining({ id: SI_ID }), JE_ID, 1250)
    expect(result.staged).toBe(true)
    const inserted = findCall('pending_operations', 'insert')![0] as {
      operation_type: string
      title: string
      params: Record<string, unknown>
      preview_data: Record<string, unknown>
    }
    expect(inserted.operation_type).toBe('link_supplier_invoice_voucher')
    expect(inserted.params).toEqual({
      supplier_invoice_id: SI_ID,
      journal_entry_id: JE_ID,
      notes: undefined,
      amount: 1250,
    })
    // payment_amount is what the unattended commit limit prices; it is the
    // share, not the whole verifikat.
    expect(inserted.preview_data).toMatchObject({
      ap_debit_amount: 5250,
      payment_amount: 1250,
      will_be_fully_paid: true,
      remaining_after: 0,
      voucher_remaining_after: 4000,
    })
    expect(inserted.title).toContain('A-12')
    expect(inserted.title).toContain('1250 SEK av verifikatet')
  })

  it('without a share the staged params carry no amount and the preview no leftover line', async () => {
    const { supabase, findCall } = mockDb()
    mockValidate.mockResolvedValue({ ...validated(1250, 0), apDebitAmount: 1250 })

    await run(supabase)

    expect(mockValidate).toHaveBeenCalledWith(supabase, 'company-1', expect.anything(), JE_ID, undefined)
    const inserted = findCall('pending_operations', 'insert')![0] as {
      title: string
      params: Record<string, unknown>
      preview_data: Record<string, unknown>
    }
    expect(inserted.params).toEqual({ supplier_invoice_id: SI_ID, journal_entry_id: JE_ID, notes: undefined })
    expect('amount' in inserted.params).toBe(false)
    expect('voucher_remaining_after' in inserted.preview_data).toBe(false)
    expect(inserted.title).not.toContain('av verifikatet')
  })

  it('refuses a share that is not a number before validating or staging anything', async () => {
    const { supabase, findCall } = mockDb()

    const error = await run(supabase, { amount: '1250' }).then(
      () => null,
      (err: unknown) => toToolError(err, { toolName: link.name }).error,
    )

    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', retryable: false })
    expect(mockValidate).not.toHaveBeenCalled()
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('the refusal without a share tells the agent to state one, and never to storno the verifikat', async () => {
    const { supabase, findCall } = mockDb()
    mockValidate.mockResolvedValue({
      ok: false,
      code: 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      details: { ap_debit: 5250, remaining: 1250 },
    })

    const error = await run(supabase).then(
      () => null,
      (err: unknown) => toToolError(err, { toolName: link.name }).error,
    )

    expect(error).toMatchObject({ code: 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING', retryable: false })
    expect(error!.message_en).toContain('call again with amount')
    expect(error!.message_en).toContain('Details: {"ap_debit":5250,"remaining":1250}')
    expect(error!.message_en).not.toContain('gnubok_correct_entry')
    expect(error!.remediation).toMatchObject({ tool: 'gnubok_link_supplier_invoice_to_voucher' })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })
})

describe('gnubok_find_voucher_candidates_for_supplier_invoice: verifikat that pay several debts', () => {
  it('asks the matcher for them and returns the share to state', async () => {
    const { supabase } = mockDb()
    mockFind.mockResolvedValue([
      { journal_entry_id: JE_ID, ap_debit_amount: 5250, confidence: 0.4, link_amount: 1250 },
    ])

    const result = (await find.execute(
      { supplier_invoice_id: SI_ID },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' } as never,
    )) as { candidates: Array<{ link_amount?: number }> }

    expect(mockFind.mock.calls[0][3]).toEqual({ limit: 10, settlementSide: AP_DEBIT, includeShared: true })
    expect(result.candidates[0].link_amount).toBe(1250)
  })
})
