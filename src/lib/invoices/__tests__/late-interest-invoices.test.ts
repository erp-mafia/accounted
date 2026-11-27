import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { LatePaidInvoice, LatePaymentInterestReport } from '../late-payment-interest-report'

const mockReport = vi.fn()
vi.mock('@/lib/invoices/late-payment-interest-report', () => ({
  getLatePaymentInterestReport: (...args: unknown[]) => mockReport(...args),
}))

const mockBuild = vi.fn()
vi.mock('@/lib/invoices/build-invoice-write', () => ({
  buildInvoiceWriteData: (...args: unknown[]) => mockBuild(...args),
}))

vi.mock('@/lib/invoices/due-date', () => ({
  loadInvoiceTerms: vi.fn().mockResolvedValue(30),
}))

const mockBackfill = vi.fn()
vi.mock('@/lib/bookkeeping/account-backfill', () => ({
  backfillStandardBASAccounts: (...args: unknown[]) => mockBackfill(...args),
}))

import { createLateInterestInvoices, lateInterestLineText, lateInterestNotes, LATE_INTEREST_ACCOUNT } from '../late-interest-invoices'

const { supabase, enqueueMany, reset, findCall, findCalls } = createQueuedMockSupabase()
const client = supabase as unknown as SupabaseClient

function row(overrides: Partial<LatePaidInvoice> = {}): LatePaidInvoice {
  return {
    invoice_id: 'inv-1',
    invoice_number: '1042',
    customer_id: 'cust-1',
    customer_name: 'Kund AB',
    currency: 'SEK',
    due_date: '2026-09-01',
    paid_late_amount: 12_500,
    last_payment_date: '2026-09-21',
    days_late: 20,
    interest: 68.49,
    fully_paid: true,
    interest_invoice: null,
    ...overrides,
  }
}

function report(rows: LatePaidInvoice[]): LatePaymentInterestReport {
  return {
    as_of: '2026-11-27',
    rate: 0.1,
    rate_is_override: false,
    consumer_rate_ceiling: null,
    paid_late: rows,
    overdue_open: [],
    totals: [],
  }
}

const customer = { id: 'cust-1', name: 'Kund AB', customer_type: 'swedish_business', language: 'sv', default_payment_terms: null }
const BUILT = {
  ok: true,
  invoiceFields: { customer_id: 'cust-1', currency: 'SEK', exchange_rate: null, total: 68.49 },
  items: [{ description: 'line', vat_rate: 0, revenue_account: '8313' }],
  warnings: [],
}

describe('createLateInterestInvoices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockBuild.mockResolvedValue(BUILT)
    mockBackfill.mockResolvedValue(['8313'])
  })

  it('makes one unnumbered draft per customer: 0 % lines on 8313, outside the scope of Swedish VAT, and claims the invoices', async () => {
    mockReport.mockResolvedValue(report([row(), row({ invoice_id: 'inv-2', invoice_number: '1043', interest: 10 })]))
    enqueueMany([
      { data: { vat_registered: true } },
      { data: customer },
      {
        data: [
          { id: 'inv-1', late_interest_invoice_id: null, invoice_marking: 'PO 77', your_reference: 'Anna' },
          { id: 'inv-2', late_interest_invoice_id: null, invoice_marking: 'PO 77 ', your_reference: 'Bo' },
        ],
      },
      { data: { id: 'draft-1', total: 78.49 } },
      { data: null },
      { data: [{ id: 'inv-1' }, { id: 'inv-2' }] },
    ])

    const result = await createLateInterestInvoices(client, { companyId: 'company-1', userId: 'user-1', invoiceIds: ['inv-1', 'inv-2'] })

    expect(result).toEqual({
      ok: true,
      created: [{ invoice_id: 'draft-1', customer_id: 'cust-1', customer_name: 'Kund AB', currency: 'SEK', total: 78.49, invoice_ids: ['inv-1', 'inv-2'] }],
      failed: [],
    })
    const input = mockBuild.mock.calls[0][0].input
    // The charged invoices share their Märkning, so it carries over; their Er referens differ, so the card's.
    expect(input.invoice_marking).toBe('PO 77')
    expect(input.your_reference).toBeUndefined()
    expect(input.vat_treatment).toBe('outside_scope')
    expect(input.delivery_country).toBeNull()
    expect(input.items).toEqual([
      expect.objectContaining({ quantity: 1, unit_price: 68.49, vat_rate: 0, revenue_account: LATE_INTEREST_ACCOUNT }),
      expect.objectContaining({ quantity: 1, unit_price: 10, vat_rate: 0, revenue_account: LATE_INTEREST_ACCOUNT }),
    ])
    expect(LATE_INTEREST_ACCOUNT).toBe('8313')
    // Most charts start without 8313: the BAS account is seeded first.
    expect(mockBackfill).toHaveBeenCalledWith(client, 'company-1', 'user-1', ['8313'])
    expect(findCall('invoices', 'insert')?.[0]).toMatchObject({
      invoice_number: null,
      status: 'draft',
      is_late_interest_invoice: true,
      company_id: 'company-1',
      user_id: 'user-1',
    })
    expect(findCalls('invoices', 'update')).toEqual([[{ late_interest_invoice_id: 'draft-1' }]])
    expect(findCalls('invoices', 'is')).toContainEqual(['late_interest_invoice_id', null])
  })

  it('keeps currencies apart: one draft per customer and currency', async () => {
    mockReport.mockResolvedValue(report([row(), row({ invoice_id: 'inv-eur', currency: 'EUR' })]))
    mockBuild.mockResolvedValueOnce(BUILT).mockResolvedValueOnce({ ...BUILT, invoiceFields: { ...BUILT.invoiceFields, currency: 'EUR', exchange_rate: 11.2 } })
    enqueueMany([
      { data: { vat_registered: true } },
      { data: customer },
      { data: [{ id: 'inv-1', late_interest_invoice_id: null }] },
      { data: { id: 'draft-sek', total: 68.49 } },
      { data: null },
      { data: [{ id: 'inv-1' }] },
      { data: customer },
      { data: [{ id: 'inv-eur', late_interest_invoice_id: null }] },
      { data: { id: 'draft-eur', total: 68.49 } },
      { data: null },
      { data: [{ id: 'inv-eur' }] },
    ])
    const result = await createLateInterestInvoices(client, { companyId: 'company-1', userId: 'user-1', invoiceIds: ['inv-1', 'inv-eur'] })
    expect(result.ok && result.created.map((c) => [c.invoice_id, c.currency])).toEqual([['draft-sek', 'SEK'], ['draft-eur', 'EUR']])
  })

  it.each([
    ['not paid in full', row({ fully_paid: false })],
    ['already on a räntefaktura', row({ interest_invoice: { id: 'rf-1', invoice_number: '1060', status: 'sent' } })],
    ['without interest', row({ interest: 0 })],
  ])('refuses an invoice %s and writes nothing', async (_label, refused) => {
    mockReport.mockResolvedValue(report([refused]))
    const result = await createLateInterestInvoices(client, { companyId: 'company-1', userId: 'user-1', invoiceIds: ['inv-1'] })
    expect(result).toEqual({ ok: false, code: 'LATE_INTEREST_NOT_CHARGEABLE', details: { invoice_ids: ['inv-1'] } })
    expect(findCall('invoices', 'insert')).toBeUndefined()
    expect(mockBackfill).not.toHaveBeenCalled()
  })

  it('refuses an invoice the report does not list', async () => {
    mockReport.mockResolvedValue(report([row()]))
    const result = await createLateInterestInvoices(client, { companyId: 'company-1', userId: 'user-1', invoiceIds: ['inv-1', 'inv-x'] })
    expect(result).toEqual({ ok: false, code: 'LATE_INTEREST_NOT_CHARGEABLE', details: { invoice_ids: ['inv-x'] } })
  })

  it('states no treatment for a seller outside the VAT register: its lines are momsfri like all it writes', async () => {
    mockReport.mockResolvedValue(report([row()]))
    enqueueMany([
      { data: { vat_registered: false } },
      { data: customer },
      { data: [{ id: 'inv-1', late_interest_invoice_id: null }] },
      { data: { id: 'draft-1', total: 68.49 } },
      { data: null },
      { data: [{ id: 'inv-1' }] },
    ])
    await createLateInterestInvoices(client, { companyId: 'company-1', userId: 'user-1', invoiceIds: ['inv-1'] })
    expect(mockBuild.mock.calls[0][0].input).not.toHaveProperty('vat_treatment')
  })

  it('deletes its draft when another click charged the invoice first', async () => {
    mockReport.mockResolvedValue(report([row()]))
    enqueueMany([
      { data: { vat_registered: true } },
      { data: customer },
      { data: [{ id: 'inv-1', late_interest_invoice_id: 'draft-1' }] },
      { data: [{ id: 'draft-1', status: 'draft' }] },
      { data: { id: 'draft-2', total: 68.49 } },
      { data: null },
      { data: [] },
      { data: null },
      { data: null },
    ])
    const result = await createLateInterestInvoices(client, { companyId: 'company-1', userId: 'user-1', invoiceIds: ['inv-1'] })
    expect(result).toEqual({
      ok: true,
      created: [],
      failed: [expect.objectContaining({ code: 'LATE_INTEREST_ALREADY_CHARGED', invoice_ids: ['inv-1'] })],
    })
    // The other click's draft is not a release: only a cancelled one is.
    expect(findCalls('invoices', 'or')).toEqual([])
    expect(findCalls('invoice_items', 'delete')).toHaveLength(1)
    expect(findCalls('invoices', 'delete')).toHaveLength(1)
  })

  it('takes over an invoice whose räntefaktura was cancelled', async () => {
    mockReport.mockResolvedValue(report([row()]))
    enqueueMany([
      { data: { vat_registered: true } },
      { data: customer },
      { data: [{ id: 'inv-1', late_interest_invoice_id: 'rf-old' }] },
      { data: [{ id: 'rf-old', status: 'cancelled' }] },
      { data: { id: 'draft-2', total: 68.49 } },
      { data: null },
      { data: [{ id: 'inv-1' }] },
    ])
    const result = await createLateInterestInvoices(client, { companyId: 'company-1', userId: 'user-1', invoiceIds: ['inv-1'] })
    expect(result.ok && result.created).toHaveLength(1)
    expect(findCalls('invoices', 'or')).toEqual([['late_interest_invoice_id.is.null,late_interest_invoice_id.in.(rf-old)']])
  })

  it('creates nothing for a foreign currency without a Riksbank rate', async () => {
    mockReport.mockResolvedValue(report([row({ currency: 'EUR' })]))
    enqueueMany([{ data: { vat_registered: true } }, { data: customer }, { data: [{ id: 'inv-1', late_interest_invoice_id: null }] }])
    const result = await createLateInterestInvoices(client, { companyId: 'company-1', userId: 'user-1', invoiceIds: ['inv-1'] })
    expect(result).toEqual({
      ok: true,
      created: [],
      failed: [expect.objectContaining({ code: 'LATE_INTEREST_FX_RATE_UNAVAILABLE', currency: 'EUR' })],
    })
    expect(findCall('invoices', 'insert')).toBeUndefined()
  })
})

describe('the räntefaktura text', () => {
  it('names the invoice, its due date, what was paid late and the last payment, in the customer language', () => {
    // sv-SE groups thousands with a no-break space.
    expect(lateInterestLineText(row(), 'sv').replace(/[\u00a0\u202f]/g, ' ')).toBe(
      'Dröjsmålsränta faktura 1042 (förfallodag 2026-09-01): 12 500,00 SEK betalt för sent, sista betalning 2026-09-21',
    )
    expect(lateInterestLineText(row(), 'en')).toBe(
      'Late payment interest, invoice 1042 (due 2026-09-01): 12,500.00 SEK paid late, last payment 2026-09-21',
    )
  })

  it('says how the interest was computed: the statutory rate or the agreed one', () => {
    expect(lateInterestNotes({ rate_is_override: false }, 'sv')).toMatch(/räntelagen: Riksbankens referensränta plus åtta procentenheter/)
    expect(lateInterestNotes({ rate_is_override: true }, 'sv')).toMatch(/avtalad räntesats/)
    expect(lateInterestNotes({ rate_is_override: false }, 'en')).toMatch(/reference rate plus eight percentage points/)
  })
})
