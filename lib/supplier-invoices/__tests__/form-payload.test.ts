import { describe, it, expect } from 'vitest'
import {
  buildSupplierInvoicePayload,
  inferVatTreatment,
  vatRateFromAi,
  rateToPctString,
  type SupplierInvoiceFormData,
  type SupplierInvoiceLineItem,
  type BuildSupplierInvoicePayloadOptions,
} from '../form-payload'

function makeItem(overrides: Partial<SupplierInvoiceLineItem> = {}): SupplierInvoiceLineItem {
  return {
    description: 'Lokalhyra augusti',
    amount: 1000,
    account_number: '5010',
    vat_rate: 0.25,
    reverse_charge_rate: 0.25,
    ...overrides,
  }
}

function makeFormData(overrides: Partial<SupplierInvoiceFormData> = {}): SupplierInvoiceFormData {
  return {
    supplier_id: 'supplier-1',
    supplier_invoice_number: 'F-2026-881',
    invoice_date: '2026-08-01',
    due_date: '2026-08-31',
    delivery_date: '',
    currency: 'SEK',
    exchange_rate: '',
    reverse_charge: false,
    payment_reference: '',
    notes: '',
    paid_with_private_funds: false,
    items: [makeItem()],
    ...overrides,
  }
}

function makeOpts(
  overrides: Partial<BuildSupplierInvoicePayloadOptions> = {},
): BuildSupplierInvoicePayloadOptions {
  return {
    inboxItemId: null,
    uploadedDocumentId: undefined,
    oreRounding: true,
    defaultDims: {},
    canUseAccrual: true,
    ...overrides,
  }
}

describe('inferVatTreatment', () => {
  it('maps a uniform rate to the matching treatment', () => {
    expect(inferVatTreatment([makeItem({ vat_rate: 0.25 })], false)).toBe('standard_25')
    expect(inferVatTreatment([makeItem({ vat_rate: 0.12 })], false)).toBe('reduced_12')
    expect(inferVatTreatment([makeItem({ vat_rate: 0.06 })], false)).toBe('reduced_6')
    expect(inferVatTreatment([makeItem({ vat_rate: 0 })], false)).toBe('exempt')
  })

  it('falls back to standard_25 on mixed rates', () => {
    expect(
      inferVatTreatment([makeItem({ vat_rate: 0.25 }), makeItem({ vat_rate: 0.12 })], false),
    ).toBe('standard_25')
  })

  it('reverse charge wins over everything', () => {
    expect(inferVatTreatment([makeItem({ vat_rate: 0.12 })], true)).toBe('reverse_charge')
  })
})

describe('vatRateFromAi', () => {
  it('maps integer percent to decimals, null to the 25 % default', () => {
    expect(vatRateFromAi(25)).toBe(0.25)
    expect(vatRateFromAi(12)).toBe(0.12)
    expect(vatRateFromAi(6)).toBe(0.06)
    expect(vatRateFromAi(0)).toBe(0)
    expect(vatRateFromAi(null)).toBe(0.25)
    expect(vatRateFromAi(undefined)).toBe(0.25)
    // Anything unrecognized collapses to 0, never an illegal rate.
    expect(vatRateFromAi(19)).toBe(0)
  })
})

describe('rateToPctString', () => {
  it('renders decimals as percent strings', () => {
    expect(rateToPctString(0.25)).toBe('25')
    expect(rateToPctString(0.12)).toBe('12')
    expect(rateToPctString(0.06)).toBe('6')
    expect(rateToPctString(0)).toBe('0')
    expect(rateToPctString(0.1234)).toBe('12.34')
  })
})

describe('buildSupplierInvoicePayload', () => {
  it('builds the plain create payload (SEK, no extras)', () => {
    const payload = buildSupplierInvoicePayload(makeFormData(), makeOpts())
    expect(payload).toEqual({
      supplier_id: 'supplier-1',
      supplier_invoice_number: 'F-2026-881',
      invoice_date: '2026-08-01',
      due_date: '2026-08-31',
      delivery_date: undefined,
      currency: 'SEK',
      exchange_rate: undefined,
      vat_treatment: 'standard_25',
      reverse_charge: false,
      payment_reference: undefined,
      notes: undefined,
      paid_with_private_funds: false,
      ore_rounding: true,
      items: [
        {
          description: 'Lokalhyra augusti',
          amount: 1000,
          account_number: '5010',
          vat_rate: 0.25,
          reverse_charge_rate: undefined,
        },
      ],
    })
    // Conditional keys must be absent, not undefined-valued.
    expect(payload).not.toHaveProperty('document_id')
    expect(payload).not.toHaveProperty('default_dimensions')
    expect(payload.items[0]).not.toHaveProperty('accrual_period_start')
    expect(payload.items[0]).not.toHaveProperty('dimensions')
    expect(payload.items[0]).not.toHaveProperty('apply_slp')
  })

  it('attaches document_id only on non-inbox submits', () => {
    const withDoc = buildSupplierInvoicePayload(
      makeFormData(),
      makeOpts({ uploadedDocumentId: 'doc-1' }),
    )
    expect(withDoc).toHaveProperty('document_id', 'doc-1')

    const inbox = buildSupplierInvoicePayload(
      makeFormData(),
      makeOpts({ inboxItemId: 'item-1', uploadedDocumentId: 'doc-1' }),
    )
    expect(inbox).not.toHaveProperty('document_id')
  })

  it('privately paid: empty due_date defaults to invoice_date', () => {
    const payload = buildSupplierInvoicePayload(
      makeFormData({ paid_with_private_funds: true, due_date: '' }),
      makeOpts({ canUseAccrual: false }),
    )
    expect(payload.due_date).toBe('2026-08-01')
    expect(payload.paid_with_private_funds).toBe(true)
  })

  it('privately paid: an explicit due_date is kept', () => {
    const payload = buildSupplierInvoicePayload(
      makeFormData({ paid_with_private_funds: true, due_date: '2026-09-15' }),
      makeOpts({ canUseAccrual: false }),
    )
    expect(payload.due_date).toBe('2026-09-15')
  })

  it('reverse charge: vat_rate forced to 0, reverse_charge_rate travels with 0.25 default', () => {
    const payload = buildSupplierInvoicePayload(
      makeFormData({
        reverse_charge: true,
        items: [
          makeItem({ vat_rate: 0.25, reverse_charge_rate: 0.12 }),
          makeItem({ vat_rate: 0.25, reverse_charge_rate: undefined }),
        ],
      }),
      makeOpts({ canUseAccrual: false }),
    )
    expect(payload.vat_treatment).toBe('reverse_charge')
    expect(payload.items[0].vat_rate).toBe(0)
    expect(payload.items[0].reverse_charge_rate).toBe(0.12)
    expect(payload.items[1].vat_rate).toBe(0)
    expect(payload.items[1].reverse_charge_rate).toBe(0.25)
  })

  it('non-RC: reverse_charge_rate is stripped to undefined', () => {
    const payload = buildSupplierInvoicePayload(makeFormData(), makeOpts())
    expect(payload.items[0].reverse_charge_rate).toBeUndefined()
  })

  it('accrual fields travel only when canUseAccrual and the period is complete', () => {
    const item = makeItem({
      accrual_period_start: '2026-08-01',
      accrual_period_end: '2026-12-31',
      accrual_balance_account: '1790',
    })

    const withAccrual = buildSupplierInvoicePayload(
      makeFormData({ items: [item] }),
      makeOpts({ canUseAccrual: true }),
    )
    expect(withAccrual.items[0]).toMatchObject({
      accrual_period_start: '2026-08-01',
      accrual_period_end: '2026-12-31',
      accrual_balance_account: '1790',
    })

    // Kontantmetod / eget utlägg / RC: canUseAccrual false drops the fields.
    const withoutAccrual = buildSupplierInvoicePayload(
      makeFormData({ items: [item] }),
      makeOpts({ canUseAccrual: false }),
    )
    expect(withoutAccrual.items[0]).not.toHaveProperty('accrual_period_start')

    // Incomplete period (end missing) also drops the fields.
    const incomplete = buildSupplierInvoicePayload(
      makeFormData({ items: [makeItem({ accrual_period_start: '2026-08-01' })] }),
      makeOpts({ canUseAccrual: true }),
    )
    expect(incomplete.items[0]).not.toHaveProperty('accrual_period_start')
  })

  it('empty accrual balance account is sent as undefined, not empty string', () => {
    const payload = buildSupplierInvoicePayload(
      makeFormData({
        items: [
          makeItem({
            accrual_period_start: '2026-08-01',
            accrual_period_end: '2026-12-31',
            accrual_balance_account: '',
          }),
        ],
      }),
      makeOpts({ canUseAccrual: true }),
    )
    expect(payload.items[0]).toHaveProperty('accrual_period_start')
    expect(payload.items[0].accrual_balance_account).toBeUndefined()
  })

  it('default_dimensions only when non-empty; item bags only when carrying values', () => {
    const bare = buildSupplierInvoicePayload(
      makeFormData({ items: [makeItem({ dimensions: {} })] }),
      makeOpts(),
    )
    expect(bare).not.toHaveProperty('default_dimensions')
    // Open-but-empty per-row panel means inherit: the bag is dropped.
    expect(bare.items[0]).not.toHaveProperty('dimensions')

    const dims = buildSupplierInvoicePayload(
      makeFormData({ items: [makeItem({ dimensions: { '1': 'KS01' } })] }),
      makeOpts({ defaultDims: { '6': 'P001' } }),
    )
    expect(dims).toHaveProperty('default_dimensions', { '6': 'P001' })
    expect(dims.items[0]).toHaveProperty('dimensions', { '1': 'KS01' })
  })

  it('apply_slp travels only on 741x rows without an accrual period', () => {
    const valid = buildSupplierInvoicePayload(
      makeFormData({ items: [makeItem({ account_number: '7412', apply_slp: true })] }),
      makeOpts(),
    )
    expect(valid.items[0]).toHaveProperty('apply_slp', true)

    // Stale flag on a non-pension account is stripped.
    const wrongAccount = buildSupplierInvoicePayload(
      makeFormData({ items: [makeItem({ account_number: '5010', apply_slp: true })] }),
      makeOpts(),
    )
    expect(wrongAccount.items[0]).not.toHaveProperty('apply_slp')

    // SLP + periodisering on the same row: accrual wins, flag stripped.
    const withAccrual = buildSupplierInvoicePayload(
      makeFormData({
        items: [
          makeItem({
            account_number: '7412',
            apply_slp: true,
            accrual_period_start: '2026-08-01',
            accrual_period_end: '2026-12-31',
            accrual_balance_account: '1790',
          }),
        ],
      }),
      makeOpts({ canUseAccrual: true }),
    )
    expect(withAccrual.items[0]).not.toHaveProperty('apply_slp')

    // But when the flow cannot accrue, the period is dropped and SLP survives.
    const accrualBlocked = buildSupplierInvoicePayload(
      makeFormData({
        items: [
          makeItem({
            account_number: '7412',
            apply_slp: true,
            accrual_period_start: '2026-08-01',
            accrual_period_end: '2026-12-31',
            accrual_balance_account: '1790',
          }),
        ],
      }),
      makeOpts({ canUseAccrual: false }),
    )
    expect(accrualBlocked.items[0]).not.toHaveProperty('accrual_period_start')
    expect(accrualBlocked.items[0]).toHaveProperty('apply_slp', true)
  })

  it('FX: exchange_rate string parses to a number, empty stays undefined', () => {
    const fx = buildSupplierInvoicePayload(
      makeFormData({ currency: 'EUR', exchange_rate: '11.2345' }),
      makeOpts(),
    )
    expect(fx.currency).toBe('EUR')
    expect(fx.exchange_rate).toBe(11.2345)

    const noFx = buildSupplierInvoicePayload(makeFormData(), makeOpts())
    expect(noFx.exchange_rate).toBeUndefined()
  })

  it('empty-string optionals collapse to undefined', () => {
    const payload = buildSupplierInvoicePayload(
      makeFormData({ delivery_date: '', payment_reference: '', notes: '' }),
      makeOpts(),
    )
    expect(payload.delivery_date).toBeUndefined()
    expect(payload.payment_reference).toBeUndefined()
    expect(payload.notes).toBeUndefined()

    const filled = buildSupplierInvoicePayload(
      makeFormData({
        delivery_date: '2026-08-05',
        payment_reference: '78912345678',
        notes: 'intern anteckning',
      }),
      makeOpts(),
    )
    expect(filled.delivery_date).toBe('2026-08-05')
    expect(filled.payment_reference).toBe('78912345678')
    expect(filled.notes).toBe('intern anteckning')
  })

  it('ore_rounding passes through both ways', () => {
    expect(buildSupplierInvoicePayload(makeFormData(), makeOpts({ oreRounding: true })).ore_rounding).toBe(true)
    expect(buildSupplierInvoicePayload(makeFormData(), makeOpts({ oreRounding: false })).ore_rounding).toBe(false)
  })
})
