import { describe, it, expect } from 'vitest'
import {
  buildEditorPreviewRequest,
  readPdfPreviewMeta,
  withQuoteValidity,
} from '@/lib/invoices/editor/preview-request'
import { InvoicePreviewSchema } from '@/lib/api/schemas'

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111'

function form(overrides: Record<string, unknown> = {}) {
  return {
    customer_id: CUSTOMER_ID,
    invoice_date: '2026-10-02',
    due_date: '2026-11-01',
    valid_until: '2026-11-01',
    delivery_date: '',
    currency: 'SEK',
    payment_cash_account_id: '',
    document_type: 'invoice',
    your_reference: 'Kontaktperson',
    our_reference: 'Säljare',
    invoice_marking: '',
    notes: 'Tack för samarbetet',
    payment_link_url: '',
    payment_link_auto: true,
    external_invoice_number: '',
    self_billing_agreement_ref: '',
    received_date: '2026-10-02',
    deduction_personnummer: '19850101-1234',
    deduction_housing_designation: 'Exempel 1:2',
    items: [
      {
        line_type: 'product' as const,
        description: 'Konsulttid',
        quantity: 2,
        unit: 'tim',
        unit_price: 1000,
        discount_percent: null,
        vat_rate: 25,
        article_id: 'a1',
        revenue_account: '3041',
        deduction_type: null,
        labor_hours: null,
        work_type: null,
        housing_designation: null,
        apartment_number: null,
        brf_org_number: null,
        dimensions: { '1': 'KS01' },
      },
    ],
    ...overrides,
  }
}

describe('withQuoteValidity', () => {
  it('drops valid_until for anything but a quote', () => {
    expect(withQuoteValidity(form()).valid_until).toBeUndefined()
  })

  it('mirrors a quote validity into due_date', () => {
    const quote = withQuoteValidity(form({ document_type: 'quote', valid_until: '2026-12-01' }))
    expect(quote.due_date).toBe('2026-12-01')
    expect(quote.valid_until).toBe('2026-12-01')
  })
})

describe('buildEditorPreviewRequest', () => {
  const options = { oreRounding: false, defaultDims: {}, invoiceNumber: '1043' }

  it('carries the fields the write path uses and the printed number', () => {
    const body = buildEditorPreviewRequest(form({ delivery_date: '2026-09-30' }), options)
    expect(body).toMatchObject({
      customer_id: CUSTOMER_ID,
      delivery_date: '2026-09-30',
      ore_rounding: false,
      invoice_number: '1043',
      payment_cash_account_id: null,
      notes: 'Tack för samarbetet',
    })
  })

  it('leaves the personnummer out unless a row claims a deduction', () => {
    const body = buildEditorPreviewRequest(form(), options) as Record<string, unknown>
    expect(body.deduction_personnummer).toBeUndefined()
    expect(body.deduction_housing_designation).toBeUndefined()
    const rot = form()
    rot.items[0] = { ...rot.items[0], deduction_type: 'rot' as never, work_type: 'bygg' as never }
    const withRot = buildEditorPreviewRequest(rot, options) as Record<string, unknown>
    expect(withRot.deduction_personnummer).toBe('19850101-1234')
  })

  it('never sends the self-billing carriers', () => {
    const body = buildEditorPreviewRequest(form(), options) as Record<string, unknown>
    expect(body.received_date).toBeUndefined()
    expect(body.external_invoice_number).toBeUndefined()
  })

  it('passes the preview schema, also for a half-filled form', () => {
    const empty = form({ customer_id: '', due_date: '', items: [] })
    expect(InvoicePreviewSchema.safeParse(buildEditorPreviewRequest(form(), options)).success).toBe(true)
    const parsed = InvoicePreviewSchema.safeParse(
      JSON.parse(JSON.stringify(buildEditorPreviewRequest(empty, { ...options, invoiceNumber: null }))),
    )
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.customer_id).toBeNull()
      expect(parsed.data.items).toEqual([])
    }
  })

  it('survives a cleared number field (NaN serializes as null)', () => {
    const typing = form()
    typing.items[0] = { ...typing.items[0], quantity: Number.NaN, unit_price: Number.NaN }
    const parsed = InvoicePreviewSchema.safeParse(
      JSON.parse(JSON.stringify(buildEditorPreviewRequest(typing, options))),
    )
    expect(parsed.success).toBe(true)
  })
})

describe('readPdfPreviewMeta', () => {
  it('reads the preview headers', () => {
    const headers = new Headers({
      'X-Invoice-Page-Count': '2',
      'X-Invoice-Qr': 'none:no_printed_giro',
      'X-Invoice-Missing': 'customer,payee',
      'X-Invoice-Exchange-Rate': '11.42',
      'X-Invoice-Exchange-Rate-Date': '2026-10-01',
    })
    expect(readPdfPreviewMeta(headers)).toEqual({
      pageCount: 2,
      qr: 'none:no_printed_giro',
      missing: ['customer', 'payee'],
      exchangeRate: 11.42,
      exchangeRateDate: '2026-10-01',
    })
  })

  it('treats absent headers as unknown', () => {
    expect(readPdfPreviewMeta(new Headers())).toEqual({
      pageCount: null,
      qr: null,
      missing: [],
      exchangeRate: null,
      exchangeRateDate: null,
    })
  })
})
