import { describe, it, expect } from 'vitest'
import {
  buildVatBreakdown,
  fromMinor,
  mapLineItems,
  mapPurchaseToWebshopRows,
  purchaseQualifiesAsPaidSale,
  purchaseQualifiesAsRefund,
  unsupportedReason,
  zettlePurchaseExternalId,
  zettleStoreScope,
} from '../lib/order-sync'
import type { ZettlePurchase } from '../types'

function sale(overrides: Partial<ZettlePurchase> = {}): ZettlePurchase {
  return {
    purchaseUUID1: '11111111-1111-1111-1111-111111111111',
    purchaseNumber: 42,
    globalPurchaseNumber: 42,
    amount: 12500,
    vatAmount: 2500,
    currency: 'SEK',
    country: 'SE',
    created: '2026-09-01T12:00:00.000+0000',
    refund: false,
    products: [
      {
        quantity: '1',
        type: 'PRODUCT',
        name: 'Kaffe',
        vatPercentage: 25,
        rowTaxableAmount: 10000,
      },
    ],
    payments: [{ type: 'IZETTLE_CARD', uuid: 'pay-1', amount: 12500 }],
    groupedVatAmounts: { '25.0': 2500 },
    ...overrides,
  }
}

describe('zettle order-sync mapping', () => {
  it('freezes the external_id template', () => {
    expect(zettleStoreScope('org-abc')).toBe('org-abc')
    expect(zettlePurchaseExternalId('org-abc', 'p-1')).toBe('zettle_org-abc_purchase_p-1')
  })

  it('qualifies card sales and rejects invoice-only purchases', () => {
    expect(purchaseQualifiesAsPaidSale(sale())).toBe(true)
    expect(
      purchaseQualifiesAsPaidSale(
        sale({ payments: [{ type: 'IZETTLE_INVOICE', amount: 12500 }] }),
      ),
    ).toBe(false)
    expect(purchaseQualifiesAsPaidSale(sale({ amount: 0 }))).toBe(false)
  })

  it('qualifies refunds by the refund flag', () => {
    expect(
      purchaseQualifiesAsRefund(
        sale({
          refund: true,
          amount: -12500,
          vatAmount: -2500,
          refundsPurchaseUUID1: '11111111-1111-1111-1111-111111111111',
          purchaseUUID1: '22222222-2222-2222-2222-222222222222',
        }),
      ),
    ).toBe(true)
  })

  it('builds VAT breakdown from groupedVatAmounts', () => {
    expect(buildVatBreakdown(sale())).toEqual([{ rate: 25, net: 100, tax: 25 }])
  })

  it('maps line items that reconstruct the charged total', () => {
    const lines = mapLineItems(sale())
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ name: 'Kaffe', quantity: 1, total: 100, total_tax: 25 })
  })

  it('maps a paid sale into a webshop order row with underlag', () => {
    const rows = mapPurchaseToWebshopRows(
      { id: 'conn-1', organization_name: 'Caféet' },
      'org-1',
      sale(),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      platform: 'zettle',
      row_type: 'order',
      store_label: 'Caféet',
      is_paid: true,
      total: 125,
      total_tax: 25,
      order_number: '42',
      payment_method: 'IZETTLE_CARD',
      external_id: 'zettle_org-1_purchase_11111111-1111-1111-1111-111111111111',
    })
    expect(rows[0].line_items).toHaveLength(1)
    expect(rows[0].vat_breakdown).toEqual([{ rate: 25, net: 100, tax: 25 }])
  })

  it('defaults store_label when organization_name is still null', () => {
    const rows = mapPurchaseToWebshopRows(
      { id: 'conn-1', organization_name: null },
      'org-1',
      sale(),
    )
    expect(rows[0]?.store_label).toBe('Zettle')
  })

  it('maps a refund with parent external_id', () => {
    const rows = mapPurchaseToWebshopRows(
      { id: 'conn-1', organization_name: 'Caféet' },
      'org-1',
      sale({
        purchaseUUID1: '22222222-2222-2222-2222-222222222222',
        refund: true,
        amount: -12500,
        vatAmount: -2500,
        refundsPurchaseUUID1: '11111111-1111-1111-1111-111111111111',
        products: [
          {
            quantity: '-1',
            type: 'PRODUCT',
            name: 'Kaffe',
            vatPercentage: 25,
            rowTaxableAmount: -10000,
          },
        ],
        groupedVatAmounts: { '25.0': -2500 },
      }),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].row_type).toBe('refund')
    expect(rows[0].total).toBe(-125)
    expect(rows[0].parent_external_id).toBe(
      'zettle_org-1_purchase_11111111-1111-1111-1111-111111111111',
    )
  })

  it('keeps line items and row-derived net when Zettle rounding drifts one öre per row', () => {
    // 33.37 kr at 25%: Zettle net 26.70, re-derived tax 6.68, row sum 33.38.
    const drifted = sale({
      amount: 3337,
      vatAmount: 667,
      products: [
        { quantity: '1', type: 'PRODUCT', name: 'Bulle', vatPercentage: 25, rowTaxableAmount: 2670 },
      ],
      payments: [{ type: 'IZETTLE_CARD', uuid: 'pay-2', amount: 3337 }],
      groupedVatAmounts: { '25.0': 667 },
    })
    expect(mapLineItems(drifted)).toHaveLength(1)
    // Net comes from the row (26.70), not tax / rate (26.68).
    expect(buildVatBreakdown(drifted)).toEqual([{ rate: 25, net: 26.7, tax: 6.67 }])
    // Two öre off on a single row is not rounding: drop the snapshot.
    expect(mapLineItems(sale({ amount: 3340, products: drifted.products }))).toEqual([])
  })

  it('falls back to tax / rate when rows carry no net', () => {
    expect(buildVatBreakdown(sale({ products: [] }))).toEqual([{ rate: 25, net: 100, tax: 25 }])
  })

  it('imports sales the row model cannot book as unpaid needs_review rows', () => {
    const conn = { id: 'conn-1', organization_name: 'Caféet' }
    const split = mapPurchaseToWebshopRows(conn, 'org-1', sale({
      payments: [
        { type: 'IZETTLE_CARD', uuid: 'p1', amount: 7500 },
        { type: 'IZETTLE_CASH', uuid: 'p2', amount: 5000 },
      ],
    }))
    expect(split[0]).toMatchObject({
      is_paid: false,
      status: 'needs_review',
      payment_method_title: 'Delad betalning: bokför manuellt',
    })
    // Card + unpaid invoice split must not count as paid either.
    expect(unsupportedReason(sale({
      payments: [{ type: 'IZETTLE_CARD', amount: 5000 }, { type: 'IZETTLE_INVOICE', amount: 7500 }],
    }))).toBe('split_tender')
    expect(unsupportedReason(sale({ payments: [{ type: 'GIFTCARD', amount: 12500 }] }))).toBe(
      'voucher_tender',
    )
    expect(unsupportedReason(sale({
      products: [{ quantity: '1', type: 'GIFTCARD', name: 'Presentkort', vatPercentage: 0, rowTaxableAmount: 12500 }],
    }))).toBe('giftcard_sale')
    expect(unsupportedReason(sale({
      payments: [{ type: 'IZETTLE_CARD', amount: 12500, gratuityAmount: 1000 }],
    }))).toBe('gratuity')
    // Two card payments go to the same account: still one tender.
    expect(unsupportedReason(sale({
      payments: [{ type: 'IZETTLE_CARD', amount: 6000 }, { type: 'IZETTLE_CARD', amount: 6500 }],
    }))).toBeNull()
    expect(unsupportedReason(sale())).toBeNull()
  })

  it('does not import a refund of an unsupported sale', () => {
    const rows = mapPurchaseToWebshopRows(
      { id: 'conn-1', organization_name: 'Caféet' },
      'org-1',
      sale({
        purchaseUUID1: '33333333-3333-3333-3333-333333333333',
        refund: true,
        amount: -12500,
        refundsPurchaseUUID1: '11111111-1111-1111-1111-111111111111',
        payments: [{ type: 'GIFTCARD', amount: -12500 }],
      }),
    )
    expect(rows).toEqual([])
  })

  it('converts minor units via fromMinor', () => {
    expect(fromMinor(12500)).toBe(125)
    expect(fromMinor(-50)).toBe(-0.5)
  })
})
