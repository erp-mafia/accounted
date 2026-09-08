/**
 * CreateSupplierParamsSchema: vat_number is optional for every supplier type.
 *
 * The schema used to require a VAT number for supplier_type 'eu_business',
 * citing ML 17 kap 24 §. That section governs what a seller must put on an
 * INVOICE it issues, not what a buyer's supplier register must hold, and an EU
 * supplier below its national registration threshold has no VAT number at all.
 * The rule refused legitimate suppliers on the staged/agent path while
 * components/suppliers/SupplierForm.tsx created the same company through the UI.
 */
import { describe, it, expect } from 'vitest'
import { CreateSupplierParamsSchema } from '../create-supplier'
import { generateReverseChargeBasisLines } from '@/lib/bookkeeping/vat-entries'

describe('CreateSupplierParamsSchema org_number', () => {
  // #2391: the staged path stores the same 10-digit key as the dashboard.
  it('stores the 10-digit key for every accepted spelling', () => {
    for (const typed of ['556677-8899', '5566778899', '165566778899', ' 556677-8899 ']) {
      const parsed = CreateSupplierParamsSchema.parse({ name: 'Testbrand AB', org_number: typed })
      expect(parsed.org_number, typed).toBe('5566778899')
    }
  })

  it('leaves a 12-digit value that is not a century form as typed', () => {
    // A VAT number (orgnr + 01) passes the shape check but is not an identity
    // the key may rewrite.
    const parsed = CreateSupplierParamsSchema.parse({ name: 'Testbrand AB', org_number: '556677889901' })
    expect(parsed.org_number).toBe('556677889901')
  })

  it('still rejects a value that is not a Swedish org number', () => {
    expect(() =>
      CreateSupplierParamsSchema.parse({ name: 'Testbrand AB', org_number: 'DK12345678' }),
    ).toThrow(/org number/)
  })
})

describe('CreateSupplierParamsSchema vat_number', () => {
  it('accepts an EU business supplier with no VAT number (below its national threshold)', () => {
    const parsed = CreateSupplierParamsSchema.parse({
      name: 'Kleinanbieter GmbH',
      supplier_type: 'eu_business',
      country: 'DE',
    })
    expect(parsed.supplier_type).toBe('eu_business')
    expect(parsed.vat_number).toBeUndefined()
  })

  it('treats an empty-string VAT number on an EU supplier as unset, not invalid', () => {
    const parsed = CreateSupplierParamsSchema.parse({
      name: 'Kleinanbieter GmbH',
      supplier_type: 'eu_business',
      vat_number: '   ',
    })
    expect(parsed.vat_number).toBeUndefined()
  })

  it('still accepts an EU business supplier that does have a VAT number', () => {
    const parsed = CreateSupplierParamsSchema.parse({
      name: 'Cloud Hosting GmbH',
      supplier_type: 'eu_business',
      vat_number: 'DE123456789',
    })
    expect(parsed.vat_number).toBe('DE123456789')
  })

  it('leaves non-EU and Swedish suppliers unaffected', () => {
    expect(
      CreateSupplierParamsSchema.parse({ name: 'US Vendor Inc', supplier_type: 'non_eu_business' }).vat_number,
    ).toBeUndefined()
    expect(
      CreateSupplierParamsSchema.parse({ name: 'Svensk Leverantör AB', supplier_type: 'swedish_business' }).vat_number,
    ).toBeUndefined()
  })

  it('still rejects a malformed VAT number when one is supplied', () => {
    expect(() =>
      CreateSupplierParamsSchema.parse({
        name: 'Cloud Hosting GmbH',
        supplier_type: 'eu_business',
        vat_number: 'XX123',
      }),
    ).toThrow(/vat_number|country prefix/i)
  })
})

describe('reverse charge does not consume supplier.vat_number', () => {
  /**
   * The decisive question behind making the field optional: omvänd
   * betalningsskyldighet on an EU purchase is selected from supplier_type plus
   * the invoice's reverse_charge flag. A VIES-validated counterparty VAT number
   * is a condition for zero-rating an intra-community SUPPLY (the seller's
   * side), not for a buyer self-assessing on a purchase. If someone ever moves
   * a VAT-number gate into the reverse-charge path, this test breaks.
   */
  it('books EU service purchase basis lines from supplier_type alone', () => {
    const parsed = CreateSupplierParamsSchema.parse({
      name: 'Kleinanbieter GmbH',
      supplier_type: 'eu_business',
    })
    const lines = generateReverseChargeBasisLines(1000, 0.25, parsed.supplier_type)
    expect(lines.map((l) => l.account_number)).toEqual(['4535', '4598'])
    expect(lines[0].debit_amount).toBe(1000)
    expect(lines[1].credit_amount).toBe(1000)
  })
})
