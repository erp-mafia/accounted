import { describe, expect, it } from 'vitest'
import {
  buildSelfBillingSnapshot,
  creditNoteSelfBillingSnapshot,
  defaultSelfBillingAcceptanceText,
  readSelfBillingSnapshot,
  type SelfBillingCompanySource,
  type SelfBillingSupplierSource,
} from '../snapshot'
import { selfBilledLockedFields } from '../edit-guard'
import { resolveSupplierInvoiceDueDate, supplierPaymentTermsDays } from '../../due-date'

const SUPPLIER: SelfBillingSupplierSource = {
  name: 'Exempel Energi AB',
  org_number: '5599887766',
  vat_number: 'SE559988776601',
  address_line1: 'Bruksvägen 2',
  address_line2: null,
  postal_code: '662 30',
  city: 'Åmål',
  country: 'SE',
  bankgiro: '5050-1055',
  plusgiro: null,
  iban: '  ',
  bic: null,
  clearing_number: '8327',
  account_number: '123456789',
}

const COMPANY: SelfBillingCompanySource = {
  company_name: 'Exempelbolaget AB',
  org_number: '5566778899',
  vat_number: 'SE556677889901',
  address_line1: 'Storgatan 1',
  address_line2: null,
  postal_code: '111 22',
  city: 'Stockholm',
  country: 'SE',
  self_billing_acceptance_text: null,
}

describe('buildSelfBillingSnapshot', () => {
  it('freezes both parties, the payee, the agreement and the default clause', () => {
    const result = buildSelfBillingSnapshot({ supplier: SUPPLIER, company: COMPANY, agreementRef: ' Flexavtal 2026 ', chargesVat: true })
    if (!result.ok) throw new Error('expected a snapshot')
    expect(result.snapshot).toEqual({
      v: 1,
      seller: {
        name: 'Exempel Energi AB',
        org_number: '5599887766',
        vat_number: 'SE559988776601',
        address_line1: 'Bruksvägen 2',
        address_line2: null,
        postal_code: '662 30',
        city: 'Åmål',
        country: 'SE',
      },
      buyer: {
        name: 'Exempelbolaget AB',
        org_number: '5566778899',
        vat_number: 'SE556677889901',
        address_line1: 'Storgatan 1',
        address_line2: null,
        postal_code: '111 22',
        city: 'Stockholm',
        country: 'SE',
      },
      // A blank IBAN is no IBAN.
      pay_to: { bankgiro: '5050-1055', plusgiro: null, iban: null, bic: null, clearing_number: '8327', account_number: '123456789' },
      agreement_ref: 'Flexavtal 2026',
      acceptance_text: defaultSelfBillingAcceptanceText('Flexavtal 2026'),
      credits: null,
    })
  })

  it('prints the company\'s own clause when it has one', () => {
    const result = buildSelfBillingSnapshot({
      supplier: SUPPLIER,
      company: { ...COMPANY, self_billing_acceptance_text: 'Godkänd om ingen invändning inom 8 dagar.' },
      agreementRef: 'A1',
      chargesVat: true,
    })
    if (!result.ok) throw new Error('expected a snapshot')
    expect(result.snapshot.acceptance_text).toBe('Godkänd om ingen invändning inom 8 dagar.')
  })

  it('the default clause names the agreement and invents no objection period', () => {
    const text = defaultSelfBillingAcceptanceText('Flexavtal 2026')
    expect(text).toContain('Flexavtal 2026')
    expect(text).toContain('självfakturering')
    expect(text).not.toMatch(/\d+ dagar/)
  })

  it('names every field ML 17 kap 24 § needs and the cards lack', () => {
    const result = buildSelfBillingSnapshot({
      supplier: { ...SUPPLIER, name: ' ', vat_number: null, city: null },
      company: { ...COMPANY, company_name: null, org_number: '', postal_code: null },
      agreementRef: 'A1',
      chargesVat: true,
    })
    expect(result).toEqual({
      ok: false,
      missing: ['seller.name', 'seller.address', 'seller.vat_number', 'buyer.name', 'buyer.org_number', 'buyer.address'],
    })
  })

  it('needs the seller\'s VAT number only when the invoice charges VAT', () => {
    const result = buildSelfBillingSnapshot({ supplier: { ...SUPPLIER, vat_number: null }, company: COMPANY, agreementRef: 'A1', chargesVat: false })
    expect(result.ok).toBe(true)
  })
})

describe('credit note and stored snapshots', () => {
  it('a credit note keeps the original\'s parties and names the invoice it credits', () => {
    const original = buildSelfBillingSnapshot({ supplier: SUPPLIER, company: COMPANY, agreementRef: 'A1', chargesVat: true })
    if (!original.ok) throw new Error('expected a snapshot')
    const credit = creditNoteSelfBillingSnapshot(original.snapshot, { number: 'SF-007', invoice_date: '2026-09-30' })
    expect(credit).toEqual({ ...original.snapshot, credits: { number: 'SF-007', invoice_date: '2026-09-30' } })
  })

  it('an unreadable stored snapshot reads as null', () => {
    expect(readSelfBillingSnapshot(null)).toBeNull()
    expect(readSelfBillingSnapshot({ v: 2 })).toBeNull()
    expect(creditNoteSelfBillingSnapshot({ seller: 'x' }, { number: 'SF-1', invoice_date: '2026-01-01' })).toBeNull()
  })
})

describe('selfBilledLockedFields', () => {
  const existing = { is_self_billed: true, supplier_invoice_number: 'SF-007', invoice_date: '2026-09-30' }

  it('locks the number and the date of a self-billing invoice', () => {
    expect(selfBilledLockedFields({ supplier_invoice_number: 'SF-008', invoice_date: '2026-10-01' }, existing)).toEqual([
      'supplier_invoice_number',
      'invoice_date',
    ])
  })

  it('lets the same values, the due date and anything on an ordinary invoice through', () => {
    expect(selfBilledLockedFields({ supplier_invoice_number: 'SF-007', invoice_date: '2026-09-30' }, existing)).toEqual([])
    expect(selfBilledLockedFields({}, existing)).toEqual([])
    expect(selfBilledLockedFields({ supplier_invoice_number: 'X' }, { ...existing, is_self_billed: false })).toEqual([])
  })
})

describe('resolveSupplierInvoiceDueDate', () => {
  it('keeps a given due date', () => {
    expect(resolveSupplierInvoiceDueDate('2026-11-15', '2026-09-30', 10)).toBe('2026-11-15')
  })

  it('adds the supplier\'s terms, 0 included, else 30 days', () => {
    expect(resolveSupplierInvoiceDueDate(undefined, '2026-09-30', 10)).toBe('2026-10-10')
    expect(resolveSupplierInvoiceDueDate(null, '2026-09-30', 0)).toBe('2026-09-30')
    expect(resolveSupplierInvoiceDueDate('', '2026-12-15', null)).toBe('2027-01-14')
    expect(supplierPaymentTermsDays(-1)).toBe(30)
    expect(supplierPaymentTermsDays(2.5)).toBe(30)
  })
})
