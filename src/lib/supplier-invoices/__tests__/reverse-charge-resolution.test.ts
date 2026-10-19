/**
 * resolveSupplierInvoiceReverseCharge: the one place every supplier-invoice
 * door (create, inbox convert, MCP staging and its executor) decides the
 * reverse-charge flag and vat_treatment (accounted#58). An EU or non-EU
 * supplier is omvänd skattskyldighet unless the caller says otherwise
 * (swedish-vat skill 2.1-2.3; ML 16 kap 6 §), and the two fields never
 * disagree.
 */
import { describe, it, expect } from 'vitest'
import { resolveSupplierInvoiceReverseCharge, resolveSupplierInvoiceReverseChargeKind } from '../create'

describe('resolveSupplierInvoiceReverseCharge', () => {
  it.each([
    // supplier type, what the caller said, resolved
    ['swedish_business', {}, { reverseCharge: false, vatTreatment: 'standard_25' }],
    ['eu_business', {}, { reverseCharge: true, vatTreatment: 'reverse_charge' }],
    ['non_eu_business', {}, { reverseCharge: true, vatTreatment: 'reverse_charge' }],
    [null, {}, { reverseCharge: false, vatTreatment: 'standard_25' }],
    // A stated treatment alone does not lift a foreign supplier's default (as before).
    ['eu_business', { vat_treatment: 'standard_25' }, { reverseCharge: true, vatTreatment: 'reverse_charge' }],
    ['swedish_business', { vat_treatment: 'reduced_12' }, { reverseCharge: false, vatTreatment: 'reduced_12' }],
    // The explicit flag is the caller's word.
    ['eu_business', { reverse_charge: false, vat_treatment: 'exempt' }, { reverseCharge: false, vatTreatment: 'exempt' }],
    ['non_eu_business', { reverse_charge: false }, { reverseCharge: false, vatTreatment: 'standard_25' }],
    ['swedish_business', { reverse_charge: true }, { reverseCharge: true, vatTreatment: 'reverse_charge' }],
    // A treatment of reverse_charge without the flag is reverse charge: it used
    // to resolve to the flag off with the treatment reverse_charge, which books
    // neither 2641 nor the fiktiv moms.
    ['swedish_business', { vat_treatment: 'reverse_charge' }, { reverseCharge: true, vatTreatment: 'reverse_charge' }],
  ] as const)('%s, %j', (supplierType, body, expected) => {
    expect(resolveSupplierInvoiceReverseCharge(supplierType, body)).toEqual(expected)
  })
})

// crm#1323: goods (ruta 20) or services (ruta 21) is a choice only an EU
// supplier's reverse charge has; anywhere else the field is refused, never
// silently dropped.
describe('resolveSupplierInvoiceReverseChargeKind', () => {
  it('keeps an EU supplier\'s word under reverse charge', () => {
    expect(resolveSupplierInvoiceReverseChargeKind('eu_business', true, 'eu_goods')).toEqual({ ok: true, kind: 'eu_goods' })
    expect(resolveSupplierInvoiceReverseChargeKind('eu_business', true, 'eu_services')).toEqual({ ok: true, kind: 'eu_services' })
  })

  it('stores nothing when nothing is said, whatever the supplier', () => {
    expect(resolveSupplierInvoiceReverseChargeKind('eu_business', true, undefined)).toEqual({ ok: true, kind: null })
    expect(resolveSupplierInvoiceReverseChargeKind('swedish_business', false, null)).toEqual({ ok: true, kind: null })
  })

  it.each([
    ['eu_business', false],
    ['non_eu_business', true],
    ['swedish_business', true],
    [null, true],
  ] as const)('refuses a kind for %s with reverse charge %s', (supplierType, reverseCharge) => {
    expect(resolveSupplierInvoiceReverseChargeKind(supplierType, reverseCharge, 'eu_goods')).toMatchObject({
      ok: false,
      code: 'SI_CREATE_INVALID_INPUT',
    })
  })
})
