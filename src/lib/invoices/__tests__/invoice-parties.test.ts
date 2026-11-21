import { describe, it, expect } from 'vitest'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import { hasPostalAddress, invoicePartiesVerdict } from '@/lib/invoices/invoice-parties'

// ML 17 kap. 24 § p.5-6 and the förenklad faktura of 17 kap. 26-28 §§
// (swedish-invoice-compliance, invoice-rules.md §2): crm#2080.
const seller = makeCompanySettings({ vat_registered: true })
const noAddress = { address_line1: null, address_line2: null, postal_code: null, city: null }

describe('hasPostalAddress', () => {
  it('needs a street line and a postal code or a town', () => {
    expect(hasPostalAddress({ address_line1: 'Storgatan 1', postal_code: '111 22', city: 'Stockholm' })).toBe(true)
    expect(hasPostalAddress({ address_line1: 'Main Street 5', city: 'Dublin' })).toBe(true)
    expect(hasPostalAddress({ address_line1: 'Storgatan 1' })).toBe(false)
    expect(hasPostalAddress({ address_line1: '  ', postal_code: '111 22', city: 'Stockholm' })).toBe(false)
    expect(hasPostalAddress({ postal_code: '111 22', city: 'Stockholm' })).toBe(false)
  })
})

describe('invoicePartiesVerdict', () => {
  it('is ok with both parties named', () => {
    expect(invoicePartiesVerdict(makeInvoice(), makeCustomer(), seller)).toBe('ok')
  })

  it('warns, without refusing, for a buyer without an address on a förenklad faktura', () => {
    expect(invoicePartiesVerdict(makeInvoice({ total: 1250 }), makeCustomer(noAddress), seller)).toBe(
      'buyer_missing_simplified',
    )
  })

  it('refuses the buyer one öre over 4 000 kr', () => {
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

  it('refuses a consumer in another EU country (a distance sale) under 4 000 kr', () => {
    const buyer = makeCustomer({ ...noAddress, customer_type: 'individual', country: 'Finland' })
    expect(invoicePartiesVerdict(makeInvoice({ total: 500 }), buyer, seller)).toBe('buyer_missing')
  })

  it('lets a non-EU buyer under 4 000 kr go without an address', () => {
    const buyer = makeCustomer({ ...noAddress, customer_type: 'non_eu_business', country: 'NO' })
    expect(invoicePartiesVerdict(makeInvoice({ total: 500, vat_treatment: 'export' }), buyer, seller)).toBe(
      'buyer_missing_simplified',
    )
  })

  it('refuses an EU sale even from a seller outside the VAT register', () => {
    const momsfri = makeCompanySettings({ vat_registered: false, vat_number: null })
    const buyer = makeCustomer({ ...noAddress, customer_type: 'eu_business', country: 'DE' })
    expect(invoicePartiesVerdict(makeInvoice({ total: 500, vat_treatment: 'exempt' }), buyer, momsfri)).toBe('buyer_missing')
  })

  it('refuses a buyer without a name', () => {
    expect(invoicePartiesVerdict(makeInvoice(), makeCustomer({ name: ' ' }), seller)).toBe('buyer_missing')
  })

  it('names the seller first', () => {
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
