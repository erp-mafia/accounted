/**
 * Address order by country: "postnummer ort" in Sweden and most of Europe,
 * "City, ST ZIP" in the US and Canada, on the invoice PDF and wherever the
 * app prints an address. Every name and address is made up.
 */
import { describe, expect, it } from 'vitest'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import { InvoicePDF } from '@/lib/invoices/pdf-template'
import { deliveryAddressLines } from '@/lib/invoices/delivery-address'
import { addressHasState, formatPostalAddress, postalPlaceLine } from '../postal-address'
import { treeText } from './pdf-tree'
import type { Customer, InvoiceItem } from '@/types'

/** The place line the PDF printed before the order went by country. */
function previousPlaceLine(postal: string | null, city: string | null): string | null {
  return postal || city ? `${postal ?? ''} ${city ?? ''}`.trim() : null
}

describe('postalPlaceLine', () => {
  it('keeps a Swedish address exactly as before: "postnummer ort"', () => {
    const cases: Array<[string | null, string | null]> = [
      ['111 22', 'Stockholm'],
      ['11122', 'Exempelstad'],
      ['111 22', null],
      [null, 'Stockholm'],
      [null, null],
    ]
    for (const [postal, city] of cases) {
      expect(postalPlaceLine({ postal_code: postal, city, country: 'SE' })).toBe(previousPlaceLine(postal, city))
    }
  })

  it('writes the rest of Europe the same way', () => {
    expect(postalPlaceLine({ postal_code: '10115', city: 'Exempelstadt', country: 'DE' })).toBe('10115 Exempelstadt')
    expect(postalPlaceLine({ postal_code: '0150', city: 'Provby', country: 'NO' })).toBe('0150 Provby')
  })

  it('writes a US address "City, ST ZIP"', () => {
    expect(postalPlaceLine({ postal_code: '98006', city: 'Bellevue', address_state: 'WA', country: 'US' })).toBe(
      'Bellevue, WA 98006',
    )
  })

  it('puts the city first in the US also without a state', () => {
    expect(postalPlaceLine({ postal_code: '98006', city: 'Bellevue', country: 'US' })).toBe('Bellevue 98006')
  })

  it('leaves out what a US address lacks', () => {
    expect(postalPlaceLine({ city: 'Bellevue', address_state: 'WA', country: 'US' })).toBe('Bellevue, WA')
    expect(postalPlaceLine({ postal_code: '98006', address_state: 'WA', country: 'US' })).toBe('WA 98006')
    expect(postalPlaceLine({ postal_code: '98006', country: 'US' })).toBe('98006')
    expect(postalPlaceLine({ city: 'Bellevue', country: 'US' })).toBe('Bellevue')
    expect(postalPlaceLine({ address_state: '  ', postal_code: '', city: null, country: 'US' })).toBeNull()
  })

  it('reads the country as the form and old rows hold it', () => {
    expect(postalPlaceLine({ postal_code: '98006', city: 'Bellevue', address_state: 'WA', country: 'us' })).toBe(
      'Bellevue, WA 98006',
    )
    expect(postalPlaceLine({ postal_code: '98006', city: 'Bellevue', address_state: 'WA', country: 'USA' })).toBe(
      'Bellevue, WA 98006',
    )
  })

  it('writes a Canadian address "City, PROV POSTAL"', () => {
    expect(postalPlaceLine({ postal_code: 'K1A 0B1', city: 'Ottawa', address_state: 'ON', country: 'CA' })).toBe(
      'Ottawa, ON K1A 0B1',
    )
  })

  it('keeps a state set elsewhere (only the API can) after the town', () => {
    expect(postalPlaceLine({ postal_code: '2000', city: 'Provstad', address_state: 'NSW', country: 'AU' })).toBe(
      '2000 Provstad NSW',
    )
  })
})

describe('addressHasState', () => {
  it('is the US and Canada', () => {
    expect(addressHasState('US')).toBe(true)
    expect(addressHasState('CA')).toBe(true)
    expect(addressHasState('us')).toBe(true)
    expect(addressHasState('SE')).toBe(false)
    expect(addressHasState('DE')).toBe(false)
    expect(addressHasState(null)).toBe(false)
    expect(addressHasState('')).toBe(false)
  })
})

describe('formatPostalAddress', () => {
  it('gives a Swedish block as before: street lines and "postnummer ort"', () => {
    expect(
      formatPostalAddress({ address_line1: 'Provgatan 1', address_line2: 'Box 12', postal_code: '111 22', city: 'Stockholm', country: 'SE' }),
    ).toEqual(['Provgatan 1', 'Box 12', '111 22 Stockholm'])
  })

  it('gives a US block with the country line the caller prints', () => {
    expect(
      formatPostalAddress(
        { address_line1: '100 Example Ave', postal_code: '98006', city: 'Bellevue', address_state: 'WA', country: 'US' },
        'USA',
      ),
    ).toEqual(['100 Example Ave', 'Bellevue, WA 98006', 'USA'])
  })

  it('skips empty parts', () => {
    expect(formatPostalAddress({ address_line1: ' ', address_line2: null, country: 'SE' }, null)).toEqual([])
  })
})

const item: InvoiceItem = {
  id: 'item-0',
  invoice_id: 'inv-1',
  sort_order: 0,
  line_type: 'product',
  description: 'Konsulttimmar',
  quantity: 2,
  unit: 'st',
  unit_price: 1000,
  line_total: 2000,
  vat_rate: 0,
  vat_amount: 0,
  created_at: '2026-11-01T00:00:00Z',
}

function pdfText(customer: Customer, deliveryAddress: unknown = null): string {
  return treeText(
    InvoicePDF({
      invoice: makeInvoice({ id: 'inv-1', status: 'sent', invoice_number: '1001', total: 2000, delivery_address: deliveryAddress as never }),
      customer,
      items: [item],
      company: makeCompanySettings(),
      paymentQr: null,
    }),
  )
}

describe('the invoice PDF', () => {
  const usCustomer = makeCustomer({
    name: 'Example Corp',
    customer_type: 'non_eu_business',
    org_number: null,
    vat_number: null,
    address_line1: '100 Example Ave',
    postal_code: '98006',
    city: 'Bellevue',
    address_state: 'WA',
    country: 'US',
    language: 'en',
  })

  it('prints a US buyer "City, ST ZIP" with the country on its own line', () => {
    const text = pdfText(usCustomer)
    expect(text).toContain('100 Example Ave\nBellevue, WA 98006\nUnited States')
    expect(text).not.toContain('98006 Bellevue')
  })

  it('prints a Swedish buyer "postnummer ort" and no country, as before', () => {
    const text = pdfText(makeCustomer({ address_line1: 'Storgatan 1', postal_code: '111 22', city: 'Stockholm', country: 'SE' }))
    expect(text).toContain('Storgatan 1\n111 22 Stockholm')
  })

  it('orders a delivery address without its own country by the buyer\'s', () => {
    const text = pdfText(usCustomer, { name: 'Example Warehouse', postal_code: '98004', city: 'Bellevue' })
    expect(text).toContain('Example Warehouse\nBellevue 98004')
  })
})

describe('deliveryAddressLines', () => {
  it('keeps "postnummer ort" for a Swedish buyer and follows the address\'s own country first', () => {
    const address = { name: 'Lager', postal_code: '111 22', city: 'Exempelstad' }
    expect(deliveryAddressLines(address, 'SE', (code) => code, 'SE')).toEqual(['Lager', '111 22 Exempelstad'])
    expect(deliveryAddressLines(address)).toEqual(['Lager', '111 22 Exempelstad'])
    expect(deliveryAddressLines({ ...address, postal_code: '98004', city: 'Bellevue', country: 'US' }, 'SE', () => 'USA', 'SE')).toEqual([
      'Lager',
      'Bellevue 98004',
      'USA',
    ])
  })
})
