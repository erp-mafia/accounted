import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const { mockHasActiveCreditNote } = vi.hoisted(() => ({ mockHasActiveCreditNote: vi.fn(async (..._args: unknown[]) => false) }))
vi.mock('@/lib/invoices/active-credit-note', () => ({ invoiceHasActiveCreditNote: mockHasActiveCreditNote }))

import { invoicePayableRefusal } from '../invoice-payable'

const supabase = {} as SupabaseClient
const open = { id: 'inv-1', status: 'sent', document_type: 'invoice', credited_invoice_id: null }
const ask = (invoice: Partial<typeof open> | Record<string, unknown>, date = '2026-03-30') =>
  invoicePayableRefusal(supabase, 'company-1', { ...open, ...invoice }, date)

describe('invoicePayableRefusal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHasActiveCreditNote.mockResolvedValue(false)
  })

  it.each(['sent', 'overdue', 'partially_paid'])('takes a %s invoice', async (status) => {
    expect(await ask({ status })).toBeNull()
  })

  it('keeps a proforma payable: a prepayment record with no verifikat', async () => {
    expect(await ask({ document_type: 'proforma' })).toBeNull()
  })

  it('refuses a kreditfaktura: it is paid back, not paid', async () => {
    expect(await ask({ credited_invoice_id: 'inv-0' })).toEqual({
      code: 'INVOICE_PAID_NOT_PAYABLE',
      details: { reason: 'credit_note' },
    })
  })

  it('refuses a quote with its own code', async () => {
    expect(await ask({ document_type: 'quote' })).toEqual({ code: 'INVOICE_QUOTE_NOT_PAYABLE' })
  })

  it('refuses a följesedel: it has no payment lifecycle', async () => {
    expect(await ask({ document_type: 'delivery_note' })).toEqual({
      code: 'INVOICE_PAID_NOT_PAYABLE',
      details: { reason: 'delivery_note' },
    })
  })

  it.each(['draft', 'paid', 'credited', 'cancelled'])('refuses a %s invoice', async (status) => {
    expect(await ask({ status })).toEqual({ code: 'INVOICE_PAID_NOT_PAYABLE', details: { currentStatus: status } })
  })

  it('refuses a date ahead of today', async () => {
    expect(await ask({}, '2099-01-01')).toMatchObject({ code: 'PAYMENT_DATE_IN_FUTURE' })
  })

  it('refuses an invoice with an active credit note, and reads for it only when the rest holds', async () => {
    mockHasActiveCreditNote.mockResolvedValue(true)
    expect(await ask({})).toEqual({ code: 'INVOICE_PAID_NOT_PAYABLE', details: { reason: 'active_credit_note' } })
    expect(mockHasActiveCreditNote).toHaveBeenCalledWith(supabase, 'company-1', 'inv-1')

    mockHasActiveCreditNote.mockClear()
    await ask({ status: 'paid' })
    expect(mockHasActiveCreditNote).not.toHaveBeenCalled()
  })
})
