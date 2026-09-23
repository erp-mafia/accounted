/**
 * Pure tests for normalizeSalesOrderLines: öre-exact line math shared with
 * invoices, text rows, and the per-customer VAT gate.
 */
import { describe, it, expect } from 'vitest'
import { normalizeSalesOrderLines } from '../lines'

const swedish = { customer_type: 'swedish_business' as const, vat_number_validated: false }
const euValidated = { customer_type: 'eu_business' as const, vat_number_validated: true }

describe('normalizeSalesOrderLines', () => {
  it('computes öre-exact totals with a percentage discount and mixed VAT rates', () => {
    const result = normalizeSalesOrderLines(
      [
        // gross 299.97, discount 30.00 (29.997 rounded), net 269.97, VAT 67.49 (67.4925 rounded)
        { description: 'Konsulttimme', quantity: 3, unit: 'h', unit_price: 99.99, discount_percent: 10, vat_rate: 25 },
        // net 100, VAT 12
        { description: 'Bok', quantity: 1, unit: 'st', unit_price: 100, vat_rate: 12 },
        // net 66.66, VAT 4.00 (3.9996 rounded)
        { description: 'Tidning', quantity: 2, unit: 'st', unit_price: 33.33, vat_rate: 6 },
      ],
      swedish,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows.map((r) => r.line_total)).toEqual([269.97, 100, 66.66])
    expect(result.rows[0].discount_percent).toBe(10)
    expect(result.rows.map((r) => r.vat_rate)).toEqual([25, 12, 6])
    expect(result.totals).toEqual({ subtotal: 436.63, vat_amount: 83.49, total: 520.12 })
  })

  it('accumulates many small lines without floating-point drift', () => {
    // 0.1 + 0.2 style drift: ten lines of 0.10 must sum to exactly 1.00.
    const items = Array.from({ length: 10 }, (_, i) => ({
      description: `Rad ${i + 1}`,
      quantity: 1,
      unit: 'st',
      unit_price: 0.1,
      vat_rate: 25,
    }))
    const result = normalizeSalesOrderLines(items, swedish)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.totals.subtotal).toBe(1)
    // Per-line VAT is 0.025 -> 0.03 (rounded per line, like the invoice builder).
    expect(result.totals.vat_amount).toBe(0.3)
    expect(result.totals.total).toBe(1.3)
  })

  it('normalises text rows to zero and excludes them from the totals', () => {
    const result = normalizeSalesOrderLines(
      [
        // Whatever numbers a text row carries in, they are discarded.
        { line_type: 'text', description: 'Leverans vecka 36', quantity: 5, unit: 'st', unit_price: 1000, vat_rate: 25 },
        { description: 'Vara', quantity: 1, unit: 'st', unit_price: 100, vat_rate: 25 },
      ],
      swedish,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows[0]).toMatchObject({
      sort_order: 0,
      line_type: 'text',
      description: 'Leverans vecka 36',
      quantity: 0,
      unit: '',
      unit_price: 0,
      discount_percent: 0,
      vat_rate: 0,
      line_total: 0,
      article_id: null,
      revenue_account: null,
      dimensions: {},
    })
    expect(result.rows[1].sort_order).toBe(1)
    expect(result.totals).toEqual({ subtotal: 100, vat_amount: 25, total: 125 })
  })

  it('keeps line ids, article, revenue account and dimensions on product rows', () => {
    const result = normalizeSalesOrderLines(
      [
        {
          id: 'd1000000-0000-4000-8000-000000000001',
          description: 'Licens',
          quantity: 2,
          unit: 'st',
          unit_price: 500,
          vat_rate: 25,
          article_id: 'b1000000-0000-4000-8000-000000000001',
          revenue_account: '3011',
          dimensions: { project: 'P1' },
        },
      ],
      swedish,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows[0]).toMatchObject({
      id: 'd1000000-0000-4000-8000-000000000001',
      article_id: 'b1000000-0000-4000-8000-000000000001',
      revenue_account: '3011',
      dimensions: { project: 'P1' },
      line_total: 1000,
    })
  })

  it('refuses a VAT rate the customer type does not permit (validated EU business)', () => {
    const result = normalizeSalesOrderLines(
      [
        { description: 'Konsult', quantity: 1, unit: 'h', unit_price: 1000, vat_rate: 0 },
        { description: 'Udda sats', quantity: 1, unit: 'h', unit_price: 1000, vat_rate: 20 },
      ],
      euValidated,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('INVOICE_CREATE_VAT_RULE_VIOLATION')
    expect(result.details).toMatchObject({
      attemptedRate: 20,
      customerType: 'eu_business',
      line: 1,
    })
    // 0 % reverse charge plus the taxed-where-performed Swedish rates.
    expect(result.details?.allowedRates).toEqual(expect.arrayContaining([0, 25, 12, 6]))
    expect(result.details?.allowedRates).not.toContain(20)
  })

  it('refuses a non-Swedish VAT rate for a domestic customer', () => {
    const result = normalizeSalesOrderLines(
      [{ description: 'Konsult', quantity: 1, unit: 'h', unit_price: 1000, vat_rate: 20 }],
      swedish,
    )
    expect(result).toMatchObject({ ok: false, code: 'INVOICE_CREATE_VAT_RULE_VIOLATION' })
  })

  it('defaults a line without vat_rate to the customer rule (0 % reverse charge for validated EU)', () => {
    const result = normalizeSalesOrderLines(
      [{ description: 'Konsult', quantity: 4, unit: 'h', unit_price: 250 }],
      euValidated,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows[0].vat_rate).toBe(0)
    expect(result.totals).toEqual({ subtotal: 1000, vat_amount: 0, total: 1000 })
  })

  it('defaults a line without vat_rate to 25 % for a domestic customer', () => {
    const result = normalizeSalesOrderLines(
      [{ description: 'Konsult', quantity: 1, unit: 'h', unit_price: 100 }],
      swedish,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows[0].vat_rate).toBe(25)
    expect(result.totals.vat_amount).toBe(25)
  })

  it('returns empty rows and zero totals for no items', () => {
    const result = normalizeSalesOrderLines([], swedish)
    expect(result).toEqual({ ok: true, rows: [], totals: { subtotal: 0, vat_amount: 0, total: 0 } })
  })
})
