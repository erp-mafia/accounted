import { describe, it, expect } from 'vitest'
import {
  mapBLToSalesInvoice,
  mapBLToSupplierInvoice,
  mapBLToCustomer,
  mapBLToSupplier,
  mapBLToJournal,
  mapBLToAccountingAccount,
  mapBLToCompanyInformation,
} from '../mapper'

/**
 * Fixture-driven tests against payload shapes captured from the BL sandbox
 * (dev_docs/bjorn_lunden/fixtures/, 2026-06). The shapes matter more than the
 * values: `status` is an ARRAY of numeric codes, customer and supplier use
 * different field names for the same concepts, and journal `amount` carries
 * the debit/credit sign.
 */

// Trimmed + anonymized /customerinvoice/batch item
function salesInvoiceRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entityId: 1,
    amount: 1250.0,
    amountInOriginalCurrency: 1250.0,
    amountInLocalCurrency: 1250.0,
    amountPaidInOriginalCurrency: 0.0,
    amountPaidInLocalCurrency: 0.0,
    currency: 'SEK',
    customerId: '1000',
    customerName: 'Test Kund AB',
    dueDate: '2026-03-13',
    invoiceNumber: 1, // BL sends a NUMBER on the customer side
    invoiceDate: '2026-02-11',
    ocrRef: '133',
    paid: false,
    preliminary: false,
    status: [1],
    ...over,
  }
}

// Trimmed + anonymized /supplierinvoice/batch item
function supplierInvoiceRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entityId: 7,
    amountInLocalCurrency: 1000.0,
    amountPaidInLocalCurrency: 0.0,
    amountRemainingInLocalCurrency: 1000.0,
    currency: 'SEK',
    dueDate: '2025-12-01',
    invoiceDate: '2025-11-01',
    invoiceNumber: '1', // string on the supplier side
    paid: false,
    preliminary: false,
    supplierId: '1000',
    supplierName: 'Leverantör AB',
    status: [1],
    ...over,
  }
}

describe('deriveBLInvoiceStatus via mapBLToSalesInvoice', () => {
  it('paid=false with overdue code [1] → overdue', () => {
    expect(mapBLToSalesInvoice(salesInvoiceRaw()).status).toBe('overdue')
  })

  it('unpaid without codes → booked', () => {
    expect(mapBLToSalesInvoice(salesInvoiceRaw({ status: [0] })).status).toBe('booked')
    expect(mapBLToSalesInvoice(salesInvoiceRaw({ status: [] })).status).toBe('booked')
    expect(mapBLToSalesInvoice(salesInvoiceRaw({ status: undefined })).status).toBe('booked')
  })

  it('paid=true → paid', () => {
    const dto = mapBLToSalesInvoice(salesInvoiceRaw({ paid: true, amountPaidInLocalCurrency: 1250.0 }))
    expect(dto.status).toBe('paid')
    expect(dto.paymentStatus.paid).toBe(true)
    expect(dto.paymentStatus.balance.value).toBe(0)
  })

  it('fully-paid code [2] → paid even when the paid flag lags', () => {
    expect(mapBLToSalesInvoice(salesInvoiceRaw({ status: [2] })).status).toBe('paid')
    expect(mapBLToSalesInvoice(salesInvoiceRaw({ status: [4] })).status).toBe('paid') // overpaid
  })

  it('deleted [5] and customer loss [6] are terminal: win over paid', () => {
    expect(mapBLToSalesInvoice(salesInvoiceRaw({ status: [5], paid: true })).status).toBe('cancelled')
    expect(mapBLToSalesInvoice(salesInvoiceRaw({ status: [6] })).status).toBe('cancelled')
  })

  it('collection codes [7]/[8] → overdue', () => {
    expect(mapBLToSalesInvoice(salesInvoiceRaw({ status: [7] })).status).toBe('overdue')
    expect(mapBLToSalesInvoice(salesInvoiceRaw({ status: [8] })).status).toBe('overdue')
  })

  it('preliminary → draft', () => {
    expect(mapBLToSalesInvoice(salesInvoiceRaw({ preliminary: true, status: [0] })).status).toBe('draft')
  })

  it('maps amounts, customer identification and number-typed invoiceNumber', () => {
    const dto = mapBLToSalesInvoice(salesInvoiceRaw({ amountPaidInLocalCurrency: 250.0 }))
    expect(dto.invoiceNumber).toBe('1')
    expect(dto.id).toBe('1')
    expect(dto.issueDate).toBe('2026-02-11')
    expect(dto.dueDate).toBe('2026-03-13')
    expect(dto.legalMonetaryTotal.payableAmount.value).toBe(1250)
    expect(dto.paymentStatus.balance.value).toBe(1000) // 1250 - 250
    expect(dto.customer.name).toBe('Test Kund AB')
    expect(dto.customer.identifications).toEqual([{ id: '1000', schemeId: 'BL:CUSTOMER_ID' }])
  })
})

describe('mapBLToSupplierInvoice', () => {
  it('balance comes from amountRemainingInLocalCurrency', () => {
    const dto = mapBLToSupplierInvoice(
      supplierInvoiceRaw({ amountPaidInLocalCurrency: 400.0, amountRemainingInLocalCurrency: 600.0 }),
    )
    expect(dto.paymentStatus.balance.value).toBe(600)
    expect(dto.paymentStatus.paid).toBe(false)
  })

  it('falls back to total − paid when amountRemaining is absent', () => {
    const dto = mapBLToSupplierInvoice(
      supplierInvoiceRaw({ amountPaidInLocalCurrency: 400.0, amountRemainingInLocalCurrency: undefined }),
    )
    expect(dto.paymentStatus.balance.value).toBe(600)
  })

  it('maps supplier identification and entityId as id', () => {
    const dto = mapBLToSupplierInvoice(supplierInvoiceRaw())
    expect(dto.id).toBe('7')
    expect(dto.invoiceNumber).toBe('1')
    expect(dto.supplier.name).toBe('Leverantör AB')
    expect(dto.supplier.identifications).toEqual([{ id: '1000', schemeId: 'BL:SUPPLIER_ID' }])
    expect(dto.status).toBe('overdue') // status [1] + unpaid
  })

  it('deleted code [5] → cancelled', () => {
    expect(mapBLToSupplierInvoice(supplierInvoiceRaw({ status: [5] })).status).toBe('cancelled')
  })
})

describe('mapBLToCustomer: customer-side field names', () => {
  // Trimmed /customer item: organisationNumber + zip (NOT organisationId/zipCode)
  const raw: Record<string, unknown> = {
    entityId: 1,
    id: '1000',
    name: 'test gubbe',
    organisationNumber: '1234567890',
    street: '',
    box: 'Chillsgatan 26A',
    zip: '11539',
    city: 'Stockholm',
    country: 'Sverige',
    phone: '0700000000',
    email: 'kund@example.com',
    currency: 'SEK',
    vatNumber: '',
    paymentTerms: '30', // string in BL
    closed: false,
  }

  it('maps id, orgnr, address, contact and payment terms', () => {
    const dto = mapBLToCustomer(raw)
    expect(dto.id).toBe('1000')
    expect(dto.customerNumber).toBe('1000')
    expect(dto.party.name).toBe('test gubbe')
    expect(dto.party.identifications).toEqual([{ id: '1234567890', schemeId: 'SE:ORGNR' }])
    expect(dto.party.postalAddress?.postalZone).toBe('11539')
    expect(dto.party.postalAddress?.additionalStreetName).toBe('Chillsgatan 26A')
    expect(dto.party.contact?.email).toBe('kund@example.com')
    expect(dto.defaultPaymentTermsDays).toBe(30)
    expect(dto.active).toBe(true)
  })

  it('closed → inactive', () => {
    expect(mapBLToCustomer({ ...raw, closed: true }).active).toBe(false)
  })
})

describe('mapBLToSupplier: supplier-side field names', () => {
  // Trimmed /supplier item: organisationId + zipCode + vatNr (NOT organisationNumber/zip/vatNumber)
  const raw: Record<string, unknown> = {
    entityId: 1,
    id: '1000',
    name: 'Leverantör AB',
    organisationId: '5512345678',
    address1: 'Östermalmsgatan 26 A',
    address2: 'C/O Test',
    zipCode: '11426',
    city: 'STOCKHOLM',
    countryCode: 'SE',
    email: 'leverantor@example.com',
    bg: '55555555',
    pg: null,
    iban: null,
    vatNr: 'SE551234567801',
    paymentTerms: '30',
    closed: false,
  }

  it('maps orgnr, address, giro and VAT number from supplier-flavored fields', () => {
    const dto = mapBLToSupplier(raw)
    expect(dto.id).toBe('1000')
    expect(dto.party.identifications).toEqual([{ id: '5512345678', schemeId: 'SE:ORGNR' }])
    expect(dto.party.postalAddress?.streetName).toBe('Östermalmsgatan 26 A')
    expect(dto.party.postalAddress?.postalZone).toBe('11426')
    expect(dto.party.postalAddress?.countryCode).toBe('SE')
    expect(dto.vatNumber).toBe('SE551234567801')
    expect(dto.bankGiro).toBe('55555555')
    expect(dto.plusGiro).toBeNull()
    expect(dto.defaultPaymentTermsDays).toBe(30)
  })
})

describe('mapBLToJournal: amount sign convention', () => {
  it('positive amount → debit, negative → credit', () => {
    const dto = mapBLToJournal({
      entityId: 40748,
      journalId: 'B',
      journalEntryId: 3,
      journalEntryDate: '2025-01-08',
      journalEntryText: 'Banköverföring',
      financialYearId: 9,
      ledgerEntries: [
        { accountId: '1930', amount: -21600.0, text: '' },
        { accountId: '1681', amount: 21600.0, text: '' },
      ],
      totalDebitSum: 21600.0,
      totalCreditSum: 21600.0,
    })

    expect(dto.entries).toHaveLength(2)
    expect(dto.entries[0]).toMatchObject({ accountNumber: '1930', debit: 0, credit: 21600 })
    expect(dto.entries[1]).toMatchObject({ accountNumber: '1681', debit: 21600, credit: 0 })
    expect(dto.totalDebit?.value).toBe(21600)
    expect(dto.totalCredit?.value).toBe(21600)
  })

  it('tolerates empty ledgerEntries (sandbox has bare journal entries)', () => {
    const dto = mapBLToJournal({
      entityId: 1,
      journalEntryId: 206,
      journalEntryDate: '2025-02-11',
      ledgerEntries: [],
    })
    expect(dto.entries).toEqual([])
    expect(dto.totalDebit?.value).toBe(0)
  })
})

describe('mapBLToAccountingAccount', () => {
  it("prefers BL's own type field (income→revenue, cost→expense)", () => {
    expect(mapBLToAccountingAccount({ id: '3010', name: 'Försäljning', type: 'income' }).type).toBe('revenue')
    expect(mapBLToAccountingAccount({ id: '8999', name: 'Årets resultat', type: 'cost' }).type).toBe('expense')
    expect(mapBLToAccountingAccount({ id: '1930', name: 'Företagskonto', type: 'asset' }).type).toBe('asset')
    expect(mapBLToAccountingAccount({ id: '2440', name: 'Leverantörsskulder', type: 'liability' }).type).toBe('liability')
  })

  it('covers off-plan accounts via the type field where ranges cannot', () => {
    // 0099 "Konvertering" is below the 1xxx asset range
    expect(mapBLToAccountingAccount({ id: '0099', name: 'Konvertering', type: 'asset' }).type).toBe('asset')
  })

  it('falls back to BAS ranges when type is missing', () => {
    expect(mapBLToAccountingAccount({ id: '1510', name: 'Kundfordringar' }).type).toBe('asset')
    expect(mapBLToAccountingAccount({ id: '2610', name: 'Utgående moms' }).type).toBe('liability')
    expect(mapBLToAccountingAccount({ id: '3010', name: 'Försäljning' }).type).toBe('revenue')
    expect(mapBLToAccountingAccount({ id: '6570', name: 'Bankkostnader' }).type).toBe('expense')
  })

  it('maps vatCode, sruCode and closed flag', () => {
    const dto = mapBLToAccountingAccount({
      id: '1930',
      name: 'Företagskonto',
      vatCode: '0',
      sruCode: '7281',
      closed: true,
      type: 'asset',
    })
    expect(dto.accountNumber).toBe('1930')
    expect(dto.vatCode).toBe('0')
    expect(dto.sruCode).toBe('7281')
    expect(dto.active).toBe(false)
  })
})

describe('mapBLToCompanyInformation: /details shape', () => {
  it('maps name, orgnr and preferredSettings.currency', () => {
    const dto = mapBLToCompanyInformation({
      entityId: 1,
      name: 'Arcim TEST',
      orgNumber: '5595386219',
      street: '',
      box: 'Östermalmsgatan 26A',
      zip: '114 26',
      city: 'Stockholm',
      country: 'Sverige',
      email: 'info@example.com',
      vatNumber: '',
      preferredSettings: { currency: 'SEK', activeFinancialYear: '202501' },
    })

    expect(dto.companyName).toBe('Arcim TEST')
    expect(dto.organizationNumber).toBe('5595386219')
    expect(dto.baseCurrency).toBe('SEK')
    expect(dto.address?.postalZone).toBe('114 26')
    expect(dto.legalEntity?.companyIdSchemeId).toBe('SE:ORGNR')
  })

  it('defaults currency to SEK when preferredSettings is absent', () => {
    expect(mapBLToCompanyInformation({ name: 'X' }).baseCurrency).toBe('SEK')
  })
})
