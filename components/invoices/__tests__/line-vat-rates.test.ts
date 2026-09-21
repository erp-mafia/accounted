/**
 * The invoice editor's per-line Moms picker: rendered options vs the default.
 *
 * The bug this pins: the picker rendered getAvailableVatRates(), whose set for a
 * VAT-validated EU business or a non-EU business is a single locked 0%. A
 * Stockholm hotel could therefore not pick 12% for a hotel night sold to a
 * German company, even though that supply is taxed where it is performed
 * (ML 6 kap.) and carries Swedish VAT. Widening the DEFAULT instead would leave
 * a stale 25% line at 25% after switching to an EU customer: the opposite error.
 * So the two sets stay separate and are tested separately here.
 */
import { describe, it, expect } from 'vitest'
import {
  FALLBACK_VAT_RATE,
  planCustomerSwitchVatSnap,
  resolveLineVatRates,
} from '@/components/invoices/line-vat-rates'

const swedish = { customer_type: 'swedish_business' as const, vat_number_validated: false }
const euValidated = { customer_type: 'eu_business' as const, vat_number_validated: true }
const euUnvalidated = { customer_type: 'eu_business' as const, vat_number_validated: false }
const nonEu = { customer_type: 'non_eu_business' as const, vat_number_validated: false }

describe('resolveLineVatRates: rendered options', () => {
  it('offers four rates for a validated EU business, 0% first', () => {
    const plan = resolveLineVatRates(euValidated)
    expect(plan.options.map((o) => o.rate)).toEqual([0, 25, 12, 6])
    expect(plan.options[0].treatment).toBe('reverse_charge')
    // The picker must be usable: that was the whole failure.
    expect(plan.isPickerLocked).toBe(false)
  })

  it('offers four rates for a non-EU business, 0% (export) first', () => {
    const plan = resolveLineVatRates(nonEu)
    expect(plan.options.map((o) => o.rate)).toEqual([0, 25, 12, 6])
    expect(plan.options[0].treatment).toBe('export')
    expect(plan.isPickerLocked).toBe(false)
  })

  it('offers the unchanged domestic set for a Swedish customer', () => {
    const plan = resolveLineVatRates(swedish)
    expect(plan.options.map((o) => o.rate)).toEqual([25, 12, 6, 0])
    expect(plan.isPickerLocked).toBe(false)
  })

  it('renders nothing before a customer is picked', () => {
    expect(resolveLineVatRates(null).options).toEqual([])
    expect(resolveLineVatRates(null).isPickerLocked).toBe(false)
  })
})

describe('resolveLineVatRates: the default', () => {
  it('keeps 0% as the default for a foreign business customer', () => {
    expect(resolveLineVatRates(euValidated).defaultRate).toBe(0)
    expect(resolveLineVatRates(nonEu).defaultRate).toBe(0)
    expect(resolveLineVatRates(euValidated).hasSingleDefault).toBe(true)
    expect(resolveLineVatRates(nonEu).hasSingleDefault).toBe(true)
  })

  it('keeps 25% as the default domestically and for an unvalidated EU business', () => {
    expect(resolveLineVatRates(swedish).defaultRate).toBe(25)
    expect(resolveLineVatRates(euUnvalidated).defaultRate).toBe(25)
    expect(resolveLineVatRates(swedish).hasSingleDefault).toBe(false)
    expect(resolveLineVatRates(euUnvalidated).hasSingleDefault).toBe(false)
  })

  it('falls back to 25% before a customer is picked (matches the empty form)', () => {
    expect(resolveLineVatRates(null).defaultRate).toBe(FALLBACK_VAT_RATE)
    expect(FALLBACK_VAT_RATE).toBe(25)
  })

  it('never lets the default follow the widened option list', () => {
    // Regression guard: if the default were ever read off `options`, a foreign
    // business customer would start booking 25% by itself.
    for (const customer of [euValidated, nonEu]) {
      const plan = resolveLineVatRates(customer)
      expect(plan.defaultRates).toHaveLength(1)
      expect(plan.defaultRate).toBe(0)
      expect(plan.options.length).toBeGreaterThan(plan.defaultRates.length)
    }
  })

  it('only adopts an article rate that is in the DEFAULT set', () => {
    // The editor gates article-rate adoption on hasSingleDefault + defaultRates:
    // an article's stored rate is its domestic rate, so adopting 25% from the
    // article would silently put Swedish VAT on a reverse-charge invoice.
    const domestic = resolveLineVatRates(swedish)
    expect(domestic.hasSingleDefault).toBe(false)
    expect(domestic.defaultRates.some((r) => r.rate === 12)).toBe(true)

    const foreign = resolveLineVatRates(euValidated)
    expect(foreign.hasSingleDefault).toBe(true)
    expect(foreign.defaultRates.some((r) => r.rate === 12)).toBe(false)
  })
})

describe('planCustomerSwitchVatSnap', () => {
  it('moves lines still on the old default onto the new one', () => {
    // Swedish → validated EU business: inherited 25% must not survive as
    // Swedish VAT on what is now a reverse-charge invoice.
    const snaps = planCustomerSwitchVatSnap({
      items: [{ vat_rate: 25 }, { vat_rate: 25 }],
      previousDefaultRate: 25,
      nextDefaultRate: 0,
    })
    expect(snaps).toEqual([
      { index: 0, rate: 0 },
      { index: 1, rate: 0 },
    ])
  })

  it('leaves a deliberate 12% hotel line alone', () => {
    // The line the Stockholm hotel explicitly set to 12% survives the switch:
    // it is lawful (taxed where performed) and the user chose it. The inherited
    // 25% line next to it still follows the new customer.
    const snaps = planCustomerSwitchVatSnap({
      items: [{ vat_rate: 12 }, { vat_rate: 25 }],
      previousDefaultRate: 25,
      nextDefaultRate: 0,
    })
    expect(snaps).toEqual([{ index: 1, rate: 0 }])
  })

  it('moves an inherited 0% onto the domestic default in the reverse direction', () => {
    // EU → Swedish customer. The old code snapped only when the NEW customer
    // forced a single rate, so 0% lines silently survived onto a domestic
    // invoice and under-charged VAT.
    const snaps = planCustomerSwitchVatSnap({
      items: [{ vat_rate: 0 }],
      previousDefaultRate: 0,
      nextDefaultRate: 25,
    })
    expect(snaps).toEqual([{ index: 0, rate: 25 }])
  })

  it('treats a line with no rate as inherited', () => {
    const snaps = planCustomerSwitchVatSnap({
      items: [{}, { vat_rate: null }],
      previousDefaultRate: 25,
      nextDefaultRate: 0,
    })
    expect(snaps).toEqual([
      { index: 0, rate: 0 },
      { index: 1, rate: 0 },
    ])
  })

  it('never touches free-text rows', () => {
    const snaps = planCustomerSwitchVatSnap({
      items: [{ line_type: 'text', vat_rate: 0 }, { line_type: 'product', vat_rate: 0 }],
      previousDefaultRate: 0,
      nextDefaultRate: 25,
    })
    expect(snaps).toEqual([{ index: 1, rate: 25 }])
  })

  it('does nothing when both customers share a default', () => {
    // e.g. Swedish → another Swedish customer, or EU → non-EU (both 0%).
    expect(
      planCustomerSwitchVatSnap({
        items: [{ vat_rate: 12 }, { vat_rate: 25 }],
        previousDefaultRate: 25,
        nextDefaultRate: 25,
      }),
    ).toEqual([])
  })
})

// The "Swedish VAT to a foreign business" sentence moved to
// explainVatTreatment() (lib/invoices/__tests__/vat-rules.test.ts).
