import { describe, it, expect } from 'vitest'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import {
  BUYER_ADDRESS_MISSING_WARNING,
  SELLER_ADDRESS_MISSING_WARNING,
  hasPostalAddress,
  invoicePartiesVerdict,
  simplifiedInvoiceWarning,
} from '@/lib/invoices/invoice-parties'

// ML (2023:200) 17 kap.: 24 § p.5-6 (both parties' full name and address on
// a faktura issued under 10, 11 or 14 §), 26 § (förenklad faktura at most
// 4 000 kr including moms, or from a seller under the 18 kap. exemption),
// 27 § (never where the buyer in another EU country pays the VAT) and 28 §
// (a förenklad faktura identifies the seller and needs nothing of the buyer).
const seller = makeCompanySettings({ vat_registered: true })
const momsfri = makeCompanySettings({ vat_registered: false, vat_number: null })
const noAddress = { address_line1: null, address_line2: null, postal_code: null, city: null }
const privatePerson = makeCustomer({ ...noAddress, customer_type: 'individual' })

describe('hasPostalAddress', () => {
  it('needs a street line and a postal code or a town', () => {
    expect(hasPostalAddress({ address_line1: 'Storgatan 1', postal_code: '111 22', city: 'Stockholm' })).toBe(true)
    expect(hasPostalAddress({ address_line1: 'Main Street 5', city: 'Dublin' })).toBe(true)
    expect(hasPostalAddress({ address_line1: 'Storgatan 1', postal_code: '111 22' })).toBe(true)
    expect(hasPostalAddress({ address_line1: 'Storgatan 1' })).toBe(false)
  })

  it('reads a street on the second line too', () => {
    expect(hasPostalAddress({ address_line1: ' ', address_line2: 'Box 123', postal_code: '111 22' })).toBe(true)
  })

  it('takes a postal code and a town without a street', () => {
    expect(hasPostalAddress({ postal_code: '171 94', city: 'Solna' })).toBe(true)
    expect(hasPostalAddress({ address_line1: '  ', postal_code: '111 22', city: 'Stockholm' })).toBe(true)
  })

  it('refuses a town, a postal code or a state alone', () => {
    expect(hasPostalAddress({ postal_code: '111 22' })).toBe(false)
    expect(hasPostalAddress({ city: 'Stockholm' })).toBe(false)
    expect(hasPostalAddress({ postal_code: ' ', city: 'Stockholm' })).toBe(false)
    expect(hasPostalAddress({ address_line1: '1 Main St', address_state: 'WA', country: 'US' })).toBe(false)
    expect(hasPostalAddress({})).toBe(false)
  })
})

describe('invoicePartiesVerdict', () => {
  it('is ok with both parties named', () => {
    expect(invoicePartiesVerdict(makeInvoice(), makeCustomer(), seller)).toBe('ok')
  })

  describe('a förenklad faktura: at most 4 000 kr including moms (26 § p.1)', () => {
    it('warns, without refusing, for a buyer without an address', () => {
      expect(invoicePartiesVerdict(makeInvoice({ total: 1250 }), makeCustomer(noAddress), seller)).toBe(
        'buyer_missing_simplified',
      )
    })

    it('holds at exactly 4 000 kr and refuses one öre over', () => {
      expect(invoicePartiesVerdict(makeInvoice({ total: 4000 }), makeCustomer(noAddress), seller)).toBe(
        'buyer_missing_simplified',
      )
      expect(invoicePartiesVerdict(makeInvoice({ total: 4000.01 }), makeCustomer(noAddress), seller)).toBe('buyer_missing')
    })

    it('reads the stored SEK total of a foreign invoice', () => {
      const eur = makeInvoice({ currency: 'EUR', total: 300, total_sek: 4100, exchange_rate: 11.5 })
      expect(invoicePartiesVerdict(eur, makeCustomer(noAddress), seller)).toBe('buyer_missing')
    })

    it('refuses a foreign total that cannot be stated in kronor', () => {
      const eur = makeInvoice({ currency: 'EUR', total: 10, total_sek: null, exchange_rate: null })
      expect(invoicePartiesVerdict(eur, makeCustomer(noAddress), seller)).toBe('buyer_missing')
    })

    it('leaves out the seller address too, warning about it, while something identifies the seller (28 § p.2)', () => {
      const bare = makeCompanySettings({ ...noAddress, vat_registered: true })
      expect(invoicePartiesVerdict(makeInvoice({ total: 1250 }), makeCustomer(), bare)).toBe('seller_missing_simplified')
      // The company comes first: its details are one fix for every invoice.
      expect(invoicePartiesVerdict(makeInvoice({ total: 1250 }), makeCustomer(noAddress), bare)).toBe(
        'seller_missing_simplified',
      )
      const numberOnly = makeCompanySettings({ ...noAddress, company_name: null, vat_registered: true })
      expect(invoicePartiesVerdict(makeInvoice({ total: 1250 }), makeCustomer(), numberOnly)).toBe(
        'seller_missing_simplified',
      )
    })

    it('refuses a seller that nothing identifies', () => {
      const anonymous = makeCompanySettings({ ...noAddress, company_name: ' ', org_number: null, vat_number: null })
      expect(invoicePartiesVerdict(makeInvoice({ total: 1250 }), makeCustomer(), anonymous)).toBe('seller_missing')
    })

    it('lets a non-EU business go without an address', () => {
      const buyer = makeCustomer({ ...noAddress, customer_type: 'non_eu_business', country: 'NO' })
      expect(invoicePartiesVerdict(makeInvoice({ total: 500, vat_treatment: 'export' }), buyer, seller)).toBe(
        'buyer_missing_simplified',
      )
    })

    it('lets a domestic reverse charge go without the buyer address: 27 § excludes only an EU buyer', () => {
      const invoice = makeInvoice({ total: 1000, vat_treatment: 'reverse_charge_domestic' })
      expect(invoicePartiesVerdict(invoice, makeCustomer(noAddress), seller)).toBe('buyer_missing_simplified')
      const large = makeInvoice({ total: 12500, vat_treatment: 'reverse_charge_domestic' })
      expect(invoicePartiesVerdict(large, makeCustomer(noAddress), seller)).toBe('buyer_missing')
    })

    it('lets an EU business charged Swedish moms go without an address: it is a domestic sale', () => {
      const buyer = makeCustomer({ ...noAddress, customer_type: 'eu_business', country: 'DE' })
      expect(invoicePartiesVerdict(makeInvoice({ total: 1250, vat_treatment: 'standard_25' }), buyer, seller)).toBe(
        'buyer_missing_simplified',
      )
    })
  })

  describe('a seller under the small-business exemption (26 § p.4)', () => {
    it('may issue a förenklad faktura at any amount', () => {
      const invoice = makeInvoice({ total: 50000, vat_amount: 0, vat_treatment: 'exempt' })
      expect(invoicePartiesVerdict(invoice, makeCustomer(noAddress), momsfri)).toBe('buyer_missing_simplified')
    })

    it('never to an EU business, which pays the VAT in its own country (27 § p.2)', () => {
      const buyer = makeCustomer({ ...noAddress, customer_type: 'eu_business', country: 'DE' })
      expect(invoicePartiesVerdict(makeInvoice({ total: 500, vat_treatment: 'exempt' }), buyer, momsfri)).toBe('buyer_missing')
    })
  })

  describe('where the buyer in another EU country pays the VAT (27 §)', () => {
    it('refuses a reverse-charge sale at any amount, for either party', () => {
      const reverseCharge = makeInvoice({ total: 500, vat_treatment: 'reverse_charge' })
      const buyer = makeCustomer({ ...noAddress, customer_type: 'eu_business', country: 'DE' })
      expect(invoicePartiesVerdict(reverseCharge, buyer, seller)).toBe('buyer_missing')
      const bare = makeCompanySettings({ ...noAddress, vat_registered: true })
      const named = makeCustomer({ customer_type: 'eu_business', country: 'DE' })
      expect(invoicePartiesVerdict(reverseCharge, named, bare)).toBe('seller_missing')
    })
  })

  describe('a private buyer (10 and 11 §§)', () => {
    it('asks nothing of an invoice to a private person', () => {
      const bare = makeCompanySettings({ ...noAddress, vat_registered: true })
      expect(invoicePartiesVerdict(makeInvoice({ total: 12500, items: [] }), privatePerson, seller)).toBe('ok')
      expect(invoicePartiesVerdict(makeInvoice({ total: 12500, items: [] }), privatePerson, bare)).toBe('ok')
      const inFinland = makeCustomer({ ...noAddress, customer_type: 'individual', country: 'FI' })
      expect(invoicePartiesVerdict(makeInvoice({ total: 500, items: [] }), inFinland, seller)).toBe('ok')
    })

    it('asks for both when the lines were not loaded, as for construction work', () => {
      expect(invoicePartiesVerdict(makeInvoice({ total: 12500 }), privatePerson, seller)).toBe('buyer_missing')
    })

    it('asks for both on construction work, a ROT or grön teknik line (11 § p.3)', () => {
      for (const deduction_type of ['rot', 'gron_teknik'] as const) {
        const work = makeInvoice({ total: 12500, items: [{ deduction_type }] as never })
        expect(invoicePartiesVerdict(work, privatePerson, seller)).toBe('buyer_missing')
        const small = makeInvoice({ total: 3000, items: [{ deduction_type }] as never })
        expect(invoicePartiesVerdict(small, privatePerson, seller)).toBe('buyer_missing_simplified')
      }
    })

    it('asks nothing of a RUT line, which is not construction work', () => {
      const rut = makeInvoice({ total: 12500, items: [{ deduction_type: 'rut' }] as never })
      expect(invoicePartiesVerdict(rut, privatePerson, seller)).toBe('ok')
    })
  })

  describe('an exempt supply (12 §)', () => {
    it('asks nothing of a domestic sale on which a VAT-registered seller charges no VAT', () => {
      const bare = makeCompanySettings({ ...noAddress, vat_registered: true })
      const rent = makeInvoice({ total: 15000, vat_amount: 0, vat_treatment: 'standard_25' })
      expect(invoicePartiesVerdict(rent, makeCustomer(noAddress), seller)).toBe('ok')
      expect(invoicePartiesVerdict(rent, makeCustomer(noAddress), bare)).toBe('ok')
    })

    it('asks for both once any line carries VAT', () => {
      const mixed = makeInvoice({ total: 15000, vat_amount: 1000, vat_treatment: 'standard_25' })
      expect(invoicePartiesVerdict(mixed, makeCustomer(noAddress), seller)).toBe('buyer_missing')
    })

    it('keeps asking for a zero-rated reverse charge or export, which needs its invoice', () => {
      const builder = makeInvoice({ total: 15000, vat_amount: 0, vat_treatment: 'reverse_charge_domestic' })
      expect(invoicePartiesVerdict(builder, makeCustomer(noAddress), seller)).toBe('buyer_missing')
      const buyer = makeCustomer({ ...noAddress, customer_type: 'non_eu_business', country: 'NO' })
      const exported = makeInvoice({ total: 15000, vat_amount: 0, vat_treatment: 'export' })
      expect(invoicePartiesVerdict(exported, buyer, seller)).toBe('buyer_missing')
    })
  })

  it('refuses a buyer without a name on a full faktura', () => {
    expect(invoicePartiesVerdict(makeInvoice(), makeCustomer({ name: ' ' }), seller)).toBe('buyer_missing')
  })

  it('names the seller first on a full faktura', () => {
    const bare = makeCompanySettings({ ...noAddress, vat_registered: true })
    expect(invoicePartiesVerdict(makeInvoice(), makeCustomer(noAddress), bare)).toBe('seller_missing')
  })

  it('reads nothing into a customer the caller did not select', () => {
    expect(invoicePartiesVerdict(makeInvoice(), undefined, seller)).toBe('ok')
  })

  it('asks nothing of a credit note', () => {
    const bare = makeCompanySettings({ ...noAddress })
    expect(invoicePartiesVerdict(makeInvoice({ total: -12500 }), makeCustomer(noAddress), bare)).toBe('ok')
    expect(invoicePartiesVerdict(makeInvoice({ credited_invoice_id: 'inv-0' }), makeCustomer(noAddress), bare)).toBe('ok')
  })
})

describe('simplifiedInvoiceWarning', () => {
  it('names the party a förenklad faktura leaves out, and nothing else', () => {
    expect(simplifiedInvoiceWarning('seller_missing_simplified')).toBe(SELLER_ADDRESS_MISSING_WARNING)
    expect(simplifiedInvoiceWarning('buyer_missing_simplified')).toBe(BUYER_ADDRESS_MISSING_WARNING)
    for (const verdict of ['ok', 'seller_missing', 'buyer_missing'] as const) {
      expect(simplifiedInvoiceWarning(verdict)).toBeNull()
    }
  })
})
