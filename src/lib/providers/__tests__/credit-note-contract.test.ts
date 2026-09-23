import { describe, it, expect } from 'vitest'
import { ResourceType, CREDIT_NOTE_TYPE_CODE, type SalesInvoiceDto, type SupplierInvoiceDto } from '../dto'
import { FORTNOX_RESOURCE_CONFIGS } from '../fortnox/config'
import { VISMA_RESOURCE_CONFIGS } from '../visma/config'
import { BOKIO_RESOURCE_CONFIGS } from '../bokio/config'
import { BRIOX_RESOURCE_CONFIGS } from '../briox/config'
import { BL_RESOURCE_CONFIGS } from '../bjornlunden/config'
import { WINT_RESOURCE_CONFIGS } from '../wint/config'
import { mapFortnoxToSalesInvoice, mapFortnoxToSupplierInvoice } from '../fortnox/mapper'
import { mapVismaToSalesInvoice, mapVismaToSupplierInvoice } from '../visma/mapper'
import { mapBokioToSalesInvoice, mapBokioToCreditNote, mapBokioToSupplierInvoice } from '../bokio/mapper'
import { mapBrioxToSalesInvoice, mapBrioxToSupplierInvoice } from '../briox/mapper'
import { mapBLToSalesInvoice, mapBLToSupplierInvoice } from '../bjornlunden/mapper'
import { mapWintToSalesInvoice } from '../wint/mapper'

/**
 * The credit-note contract of SalesInvoiceDto and SupplierInvoiceDto, enforced
 * for EVERY provider and both registers.
 *
 * The migration importer reads one signal to decide that a sales document is
 * a kreditfaktura: `invoiceTypeCode` 381 (lib/providers/dto.ts). A mapper
 * that leaves it unset lands the credit note as an ordinary invoice, and
 * nothing fails: the row balances, it just says "Betald" beside a negative
 * amount, points at no original and is never counted. That is how 3 200
 * Fortnox credit notes reached production as paid invoices (#2789). The rule
 * used to live in a comment; this file is what makes it fail a build.
 *
 * Every fixture is shaped like the provider's WIRE format, not like what the
 * mapper wishes it were: the Fortnox mapper tested `Credit === true` while
 * Fortnox's OpenAPI schema types the flag as the string "true", and not one
 * Fortnox credit note in production ever read as credited.
 *
 * The supplier register had the mirror defect (#2838): no supplier mapper but
 * Visma's typed a credit note at all, so a provider's supplier kreditfaktura
 * landed as an ordinary payable with a negative total (about 40 rows in
 * production, from Fortnox, Bokio and Björn Lundén). The same contract now
 * runs over every registered SUPPLIER mapper, with the same rule: a flag where
 * the provider documents one, and a negative payable total for everyone.
 */

type Raw = Record<string, unknown>
type InvoiceDto = SalesInvoiceDto | SupplierInvoiceDto
type InvoiceMapper = (raw: Raw) => InvoiceDto

interface ContractCase {
  provider: string
  mapper: InvoiceMapper
  /** A credit note as the provider flags it. Absent when no flag is documented. */
  flaggedCredit?: Raw
  /**
   * A document with a negative payable total and no credit flag at all: the
   * only signal a provider without a documented flag sends (Briox, Björn
   * Lundén, WINT) and the only one on Fortnox's list form. Absent for the
   * providers whose own flag already carries the contract (Visma, Bokio).
   */
  negativeTotal?: Raw
  /** An ordinary invoice: must NOT be typed 381. */
  ordinary: Raw
  /**
   * The ORIGINAL invoice after it has been credited, where the provider marks
   * that on the original. It keeps its positive amounts and must never be
   * typed 381: doing so would reverse the sign of a real receivable.
   */
  creditedOriginal?: Raw
  /** Sign the provider states a credit note's total with. */
  statedSign: 'negative' | 'magnitude'
  /** The credited invoice the flagged fixture names, when the provider names one. */
  expectedRef?: InvoiceDto['creditedInvoiceRef']
}

const CASES: ContractCase[] = [
  {
    provider: 'fortnox',
    mapper: mapFortnoxToSalesInvoice,
    // InvoiceFull (GET /3/invoices/{DocumentNumber}). Fortnox's OpenAPI types
    // `Credit` and `CreditInvoiceReference` as strings; amounts are negative
    // and the row carries the sign on the quantity (production shape).
    flaggedCredit: {
      DocumentNumber: '1043', CustomerNumber: '12', CustomerName: 'Kund AB',
      InvoiceDate: '2026-03-10', DueDate: '2026-04-09', Currency: 'SEK',
      Credit: 'true', CreditInvoiceReference: '1038',
      Booked: true, Sent: true, Cancelled: false, VATIncluded: false,
      Net: -1000, TotalVAT: -250, Total: -1250, Balance: 0,
      InvoiceRows: [{ RowId: 1, Description: 'Konsulttimmar', DeliveredQuantity: '-2.00', Price: 500, Total: -1000, VAT: 25, Unit: 'tim' }],
    },
    // InvoiceShort (the list form) carries neither `Credit` nor the reference.
    negativeTotal: {
      DocumentNumber: '1043', CustomerNumber: '12', CustomerName: 'Kund AB',
      InvoiceDate: '2026-03-10', DueDate: '2026-04-09', Currency: 'SEK',
      Booked: true, Sent: true, Cancelled: false, Total: -1250, Balance: 0,
    },
    ordinary: {
      DocumentNumber: '1038', CustomerNumber: '12', CustomerName: 'Kund AB',
      InvoiceDate: '2026-03-01', DueDate: '2026-03-31', Currency: 'SEK',
      Credit: 'false', CreditInvoiceReference: '0',
      Booked: true, Sent: true, Cancelled: false, Net: 1000, TotalVAT: 250, Total: 1250, Balance: 1250,
    },
    // The debit invoice once credited: Fortnox points it at its credit
    // invoice and settles the balance.
    creditedOriginal: {
      DocumentNumber: '1038', CustomerNumber: '12', CustomerName: 'Kund AB',
      InvoiceDate: '2026-03-01', DueDate: '2026-03-31', Currency: 'SEK',
      Credit: 'false', CreditInvoiceReference: '1043',
      Booked: true, Sent: true, Cancelled: false, Net: 1000, TotalVAT: 250, Total: 1250, Balance: 0,
    },
    statedSign: 'negative',
    expectedRef: { id: '1038', invoiceNumber: '1038' },
  },
  {
    provider: 'visma',
    mapper: mapVismaToSalesInvoice,
    flaggedCredit: {
      Id: 'v-cn', InvoiceNumber: '57', InvoiceDate: '2026-03-10', DueDate: '2026-04-09', CurrencyCode: 'SEK',
      IsCreditInvoice: true, TotalAmount: -1250, TotalVatAmount: -250, RemainingAmount: 0, InvoiceCustomerName: 'Kund AB', Rows: [],
    },
    ordinary: {
      Id: 'v-inv', InvoiceNumber: '56', InvoiceDate: '2026-03-01', DueDate: '2026-03-31', CurrencyCode: 'SEK',
      IsCreditInvoice: false, TotalAmount: 1250, RemainingAmount: 1250, InvoiceCustomerName: 'Kund AB', Rows: [],
    },
    statedSign: 'negative',
  },
  {
    provider: 'bokio (/invoices)',
    mapper: mapBokioToSalesInvoice,
    flaggedCredit: {
      id: 'b-cn', invoiceNumber: 'KR-7', status: 'credit', invoiceDate: '2026-03-10', dueDate: '2026-04-09',
      currency: 'SEK', totalAmount: 1250, totalTax: 250, paidAmount: 0, customerRef: { id: 'c1', name: 'Kund AB' }, lineItems: [],
    },
    ordinary: {
      id: 'b-inv', invoiceNumber: '6', status: 'published', invoiceDate: '2026-03-01', dueDate: '2026-03-31',
      currency: 'SEK', totalAmount: 1250, totalTax: 250, paidAmount: 0, customerRef: { id: 'c1', name: 'Kund AB' }, lineItems: [],
    },
    creditedOriginal: {
      id: 'b-inv', invoiceNumber: '6', status: 'credited', invoiceDate: '2026-03-01', dueDate: '2026-03-31',
      currency: 'SEK', totalAmount: 1250, totalTax: 250, paidAmount: 0, customerRef: { id: 'c1', name: 'Kund AB' },
      creditNoteRefs: [{ id: 'b-cn' }], lineItems: [],
    },
    statedSign: 'magnitude',
  },
  {
    provider: 'bokio (/credit-notes)',
    mapper: mapBokioToCreditNote,
    flaggedCredit: {
      id: 'b-cn', invoiceNumber: 'KR-7', status: 'published', creditDate: '2026-03-10', dueDate: '2026-04-09',
      currency: 'SEK', totalAmount: 1250, totalTax: 250, paidAmount: 0, customerRef: { id: 'c1', name: 'Kund AB' },
      invoiceRef: { id: 'b-inv', invoiceNumber: '6' }, lineItems: [],
    },
    ordinary: {},
    statedSign: 'magnitude',
    expectedRef: { id: 'b-inv', invoiceNumber: '6' },
  },
  {
    provider: 'briox',
    mapper: mapBrioxToSalesInvoice,
    // Briox publishes no credit flag this mapper could be verified against:
    // the negative total is the only signal it is given.
    negativeTotal: {
      id: 71, invoice_number: '2044', invoice_date: '2026-03-10', due_date: '2026-04-09',
      total_amount: '-1250.00', net_amount: '-1000.00', vat_amount: '-250.00', balance: '0.00', customer_name: 'Kund AB', booked: true,
      rows: [{ id: 1, description: 'Konsulttimmar', quantity: '-2', price: '500.00', total: '-1000.00', vat_rate: '25' }],
    },
    ordinary: {
      id: 70, invoice_number: '2043', invoice_date: '2026-03-01', due_date: '2026-03-31',
      total_amount: '1250.00', net_amount: '1000.00', vat_amount: '250.00', balance: '1250.00', customer_name: 'Kund AB', booked: true,
    },
    // `status: 'credited'` on positive amounts reads as "this invoice has
    // been credited" (as Bokio's and WINT's equivalents do), not as "this is
    // the credit note".
    creditedOriginal: {
      id: 70, invoice_number: '2043', invoice_date: '2026-03-01', due_date: '2026-03-31', status: 'credited',
      total_amount: '1250.00', net_amount: '1000.00', vat_amount: '250.00', balance: '0.00', customer_name: 'Kund AB', booked: true,
    },
    statedSign: 'negative',
  },
  {
    provider: 'bjornlunden',
    mapper: mapBLToSalesInvoice,
    negativeTotal: {
      entityId: 902, invoiceNumber: '3051', invoiceDate: '2026-03-10', dueDate: '2026-04-09', currency: 'SEK',
      customerId: 'K12', customerName: 'Kund AB', amountInLocalCurrency: -1250, amountPaidInLocalCurrency: -1250, paid: true, status: [2],
    },
    ordinary: {
      entityId: 901, invoiceNumber: '3050', invoiceDate: '2026-03-01', dueDate: '2026-03-31', currency: 'SEK',
      customerId: 'K12', customerName: 'Kund AB', amountInLocalCurrency: 1250, amountPaidInLocalCurrency: 0, paid: false, status: [0],
    },
    statedSign: 'negative',
  },
  {
    provider: 'wint',
    mapper: mapWintToSalesInvoice,
    negativeTotal: {
      Id: 5002, SerialNumber: 1008, PostingDate: '2026-03-10T00:00:00', DueDate: '2026-04-09T00:00:00', Currency: 'SEK',
      CustomerName: 'Kund AB', TotalAmount: -1250, TotalTax: -250, LeftToPay: 0, Status: 'Paid', PaymentState: 'Paid', Rows: [],
    },
    ordinary: {
      Id: 5001, SerialNumber: 1007, PostingDate: '2026-03-01T00:00:00', DueDate: '2026-03-31T00:00:00', Currency: 'SEK',
      CustomerName: 'Kund AB', TotalAmount: 1250, TotalTax: 250, LeftToPay: 1250, Status: 'Unpaid', PaymentState: 'Unpaid', Rows: [],
    },
    // CreditStatus describes what happened TO this invoice.
    creditedOriginal: {
      Id: 5001, SerialNumber: 1007, PostingDate: '2026-03-01T00:00:00', DueDate: '2026-03-31T00:00:00', Currency: 'SEK',
      CustomerName: 'Kund AB', TotalAmount: 1250, TotalTax: 250, LeftToPay: 0, Status: 'Unpaid', CreditStatus: 'Credited', Rows: [],
    },
    statedSign: 'negative',
  },
]

describe('credit-note contract: every provider sales mapper', () => {
  it('has a contract case for every sales mapper a provider registers', () => {
    // A new provider, or a new sales resource on an old one, registers its
    // mapper in a resource config. It cannot do so without a case above.
    const configs = [
      FORTNOX_RESOURCE_CONFIGS, VISMA_RESOURCE_CONFIGS, BOKIO_RESOURCE_CONFIGS,
      BRIOX_RESOURCE_CONFIGS, BL_RESOURCE_CONFIGS, WINT_RESOURCE_CONFIGS,
    ] as Partial<Record<ResourceType, { mapper: unknown }>>[]
    const registered = configs.flatMap((config) =>
      [ResourceType.SalesInvoices, ResourceType.CreditNotes].flatMap((resource) =>
        config[resource] ? [config[resource]!.mapper] : []))
    expect(registered).toHaveLength(7)
    const covered = new Set<unknown>(CASES.map((c) => c.mapper))
    for (const mapper of registered) {
      expect(covered.has(mapper), `no credit-note contract case for ${(mapper as { name: string }).name}`).toBe(true)
    }
  })

  describeContractCases(CASES)
})

function describeContractCases(cases: ContractCase[]) {
  for (const c of cases) {
    describe(c.provider, () => {
      if (c.flaggedCredit) {
        it('types a credit note the provider flags as 381', () => {
          const dto = c.mapper(c.flaggedCredit!)
          expect(dto.invoiceTypeCode).toBe(CREDIT_NOTE_TYPE_CODE)
          // Never an open or a paid receivable in the lifecycle status either.
          expect(['credited', 'draft']).toContain(dto.status)
        })

        it('states the credit note in the sign convention the importer is told to expect', () => {
          const total = c.mapper(c.flaggedCredit!).legalMonetaryTotal.payableAmount.value
          if (c.statedSign === 'negative') expect(total).toBeLessThan(0)
          else expect(total).toBeGreaterThan(0)
        })

        it('names the credited invoice exactly when the provider does', () => {
          expect(c.mapper(c.flaggedCredit!).creditedInvoiceRef).toEqual(c.expectedRef)
        })
      }

      if (c.negativeTotal) {
        it('types a document with a negative payable total as 381 without any flag', () => {
          const dto = c.mapper(c.negativeTotal!)
          expect(dto.invoiceTypeCode).toBe(CREDIT_NOTE_TYPE_CODE)
          expect(['credited', 'draft']).toContain(dto.status)
        })
      }

      it('has at least one credit-note fixture', () => {
        expect(c.flaggedCredit ?? c.negativeTotal).toBeDefined()
      })

      if (Object.keys(c.ordinary).length > 0) {
        it('leaves an ordinary invoice untyped and without a credited reference', () => {
          const dto = c.mapper(c.ordinary)
          expect(dto.invoiceTypeCode).toBeUndefined()
          expect(dto.creditedInvoiceRef).toBeUndefined()
        })
      }

      if (c.creditedOriginal) {
        it('never types the credited ORIGINAL as a credit note', () => {
          const dto = c.mapper(c.creditedOriginal!)
          expect(dto.invoiceTypeCode).toBeUndefined()
          expect(dto.creditedInvoiceRef).toBeUndefined()
          expect(dto.legalMonetaryTotal.payableAmount.value).toBeGreaterThan(0)
        })
      }
    })
  }
}

describe('mapFortnoxToSalesInvoice: the Credit flag on the wire', () => {
  const credit = CASES[0].flaggedCredit!

  it('reads the flag as Fortnox serialises it (a string) and as its docs describe it (a boolean)', () => {
    for (const flag of ['true', 'True', true]) {
      const dto = mapFortnoxToSalesInvoice({ ...credit, Credit: flag, Total: 0, Net: 0, TotalVAT: 0 })
      expect(dto.invoiceTypeCode, `Credit=${JSON.stringify(flag)}`).toBe(CREDIT_NOTE_TYPE_CODE)
      expect(dto.status).toBe('credited')
    }
    for (const flag of ['false', false, undefined, null, 0]) {
      const dto = mapFortnoxToSalesInvoice({ ...CASES[0].ordinary, Credit: flag })
      expect(dto.invoiceTypeCode, `Credit=${JSON.stringify(flag)}`).toBeUndefined()
    }
  })

  it('reads CreditInvoiceReference whether it arrives as a string or a number, and ignores an empty one', () => {
    expect(mapFortnoxToSalesInvoice({ ...credit, CreditInvoiceReference: 1038 }).creditedInvoiceRef)
      .toEqual({ id: '1038', invoiceNumber: '1038' })
    for (const empty of ['0', 0, '', null, undefined]) {
      expect(mapFortnoxToSalesInvoice({ ...credit, CreditInvoiceReference: empty }).creditedInvoiceRef,
        `CreditInvoiceReference=${JSON.stringify(empty)}`).toBeUndefined()
    }
  })

  it('never lets a credit note name itself as the invoice it credits', () => {
    expect(mapFortnoxToSalesInvoice({ ...credit, CreditInvoiceReference: '1043' }).creditedInvoiceRef).toBeUndefined()
  })
})

/**
 * The supplier register. No provider but Fortnox and Visma documents a credit
 * flag on a supplier invoice, and only Fortnox names the credited invoice
 * (`CreditReference`); for the rest the negative payable total is the one
 * signal there is, and none is invented.
 */
const SUPPLIER_CASES: ContractCase[] = [
  {
    provider: 'fortnox',
    mapper: mapFortnoxToSupplierInvoice,
    // SupplierInvoice (GET /3/supplierinvoices/{GivenNumber}). Fortnox's
    // OpenAPI types `Credit` as a boolean and `CreditReference` as an integer
    // here. SupplierInvoiceRows are the ACCOUNTING rows of the document, so
    // they balance to zero and the 2440 row carries the opposite sign of the
    // header: on a credit note 2440 is debited (production shape).
    flaggedCredit: {
      GivenNumber: '312', SupplierNumber: '7', SupplierName: 'Leverantör AB', InvoiceNumber: 'K-5531',
      InvoiceDate: '2026-03-10', DueDate: '2026-04-09', Currency: 'SEK',
      Credit: true, CreditReference: 311, Booked: true, Cancelled: false,
      Total: -1250, VAT: -250, Balance: 0,
      SupplierInvoiceRows: [
        { Account: 2440, Debit: 1250, Credit: 0, Total: 1250 },
        { Account: 4010, Debit: 0, Credit: 1000, Total: -1000 },
        { Account: 2641, Debit: 0, Credit: 250, Total: -250 },
      ],
    },
    // The list form, and any payload that leaves the flag out.
    negativeTotal: {
      GivenNumber: '312', SupplierNumber: '7', SupplierName: 'Leverantör AB', InvoiceNumber: 'K-5531',
      InvoiceDate: '2026-03-10', DueDate: '2026-04-09', Currency: 'SEK', Booked: true, Cancelled: false, Total: -1250, Balance: 0,
    },
    ordinary: {
      GivenNumber: '311', SupplierNumber: '7', SupplierName: 'Leverantör AB', InvoiceNumber: '5530',
      InvoiceDate: '2026-03-01', DueDate: '2026-03-31', Currency: 'SEK',
      Credit: false, CreditReference: 0, Booked: true, Cancelled: false, Total: 5000, VAT: 1000, Balance: 5000,
    },
    // The debit invoice once credited: Fortnox points it at its credit invoice.
    creditedOriginal: {
      GivenNumber: '311', SupplierNumber: '7', SupplierName: 'Leverantör AB', InvoiceNumber: '5530',
      InvoiceDate: '2026-03-01', DueDate: '2026-03-31', Currency: 'SEK',
      Credit: false, CreditReference: 312, Booked: true, Cancelled: false, Total: 5000, VAT: 1000, Balance: 3750,
    },
    statedSign: 'negative',
    expectedRef: { id: '311', invoiceNumber: '311' },
  },
  {
    provider: 'visma',
    mapper: mapVismaToSupplierInvoice,
    // SupplierInvoiceApi: Rows are accounting rows stated as magnitudes.
    flaggedCredit: {
      Id: 'v-scn', InvoiceNumber: 'K-5531', InvoiceDate: '2026-03-10', DueDate: '2026-04-09', CurrencyCode: 'SEK',
      IsCreditInvoice: true, TotalAmount: -1250, VatAmount: -250, PaymentStatus: 6, Status: 1, SupplierName: 'Leverantör AB',
      Rows: [{ LineNumber: 1, AccountNumber: 2440, DebetAmount: 1250, CreditAmount: 0 }, { LineNumber: 2, AccountNumber: 4010, DebetAmount: 0, CreditAmount: 1000 }],
    },
    negativeTotal: {
      Id: 'v-scn', InvoiceNumber: 'K-5531', InvoiceDate: '2026-03-10', DueDate: '2026-04-09', CurrencyCode: 'SEK',
      TotalAmount: -1250, PaymentStatus: 6, Status: 1, SupplierName: 'Leverantör AB', Rows: [],
    },
    ordinary: {
      Id: 'v-si', InvoiceNumber: '5530', InvoiceDate: '2026-03-01', DueDate: '2026-03-31', CurrencyCode: 'SEK',
      IsCreditInvoice: false, TotalAmount: 5000, PaymentStatus: 3, Status: 1, SupplierName: 'Leverantör AB', Rows: [],
    },
    statedSign: 'negative',
  },
  {
    provider: 'bokio',
    mapper: mapBokioToSupplierInvoice,
    // supplierInvoiceGet has no status, no credit flag and no reference.
    negativeTotal: {
      id: 'b-scn', invoiceNumber: 'K-5531', invoiceDate: '2026-03-10', dueDate: '2026-04-09', currency: 'SEK',
      totalAmount: -1250, remainingAmount: 0, supplierRef: { id: 's1', name: 'Leverantör AB' }, journalEntryRef: { id: 'je-1' },
      lineItems: [{ id: 1, description: 'Retur', quantity: 1, unitPrice: -1000, taxRate: 25 }],
    },
    ordinary: {
      id: 'b-si', invoiceNumber: '5530', invoiceDate: '2026-03-01', dueDate: '2026-03-31', currency: 'SEK',
      totalAmount: 5000, remainingAmount: 5000, supplierRef: { id: 's1', name: 'Leverantör AB' }, journalEntryRef: { id: 'je-0' }, lineItems: [],
    },
    statedSign: 'negative',
  },
  {
    provider: 'briox',
    mapper: mapBrioxToSupplierInvoice,
    negativeTotal: {
      id: 81, invoice_number: 'K-5531', invoice_date: '2026-03-10', due_date: '2026-04-09',
      total_amount: '-1250.00', net_amount: '-1000.00', vat_amount: '-250.00', balance: '0.00', supplier_name: 'Leverantör AB', booked: true,
      rows: [{ id: 1, description: 'Retur', quantity: '-1', price: '1000.00', total: '-1000.00', account_number: 4010 }],
    },
    ordinary: {
      id: 80, invoice_number: '5530', invoice_date: '2026-03-01', due_date: '2026-03-31',
      total_amount: '5000.00', net_amount: '4000.00', vat_amount: '1000.00', balance: '5000.00', supplier_name: 'Leverantör AB', booked: true,
    },
    // As on the sales side: `credited` beside positive amounts is the ORIGINAL.
    creditedOriginal: {
      id: 80, invoice_number: '5530', invoice_date: '2026-03-01', due_date: '2026-03-31', status: 'credited',
      total_amount: '5000.00', net_amount: '4000.00', vat_amount: '1000.00', balance: '0.00', supplier_name: 'Leverantör AB', booked: true,
    },
    statedSign: 'negative',
  },
  {
    provider: 'bjornlunden',
    mapper: mapBLToSupplierInvoice,
    negativeTotal: {
      entityId: 912, invoiceNumber: 'K-5531', invoiceDate: '2026-03-10', dueDate: '2026-04-09', currency: 'SEK',
      supplierId: 'L7', supplierName: 'Leverantör AB', amountInLocalCurrency: -1250, amountPaidInLocalCurrency: -1250,
      amountRemainingInLocalCurrency: 0, paid: true, status: [2],
    },
    ordinary: {
      entityId: 911, invoiceNumber: '5530', invoiceDate: '2026-03-01', dueDate: '2026-03-31', currency: 'SEK',
      supplierId: 'L7', supplierName: 'Leverantör AB', amountInLocalCurrency: 5000, amountPaidInLocalCurrency: 0,
      amountRemainingInLocalCurrency: 5000, paid: false, status: [0],
    },
    statedSign: 'negative',
  },
]

describe('credit-note contract: every provider supplier mapper', () => {
  it('has a contract case for every supplier mapper a provider registers', () => {
    const configs = [
      FORTNOX_RESOURCE_CONFIGS, VISMA_RESOURCE_CONFIGS, BOKIO_RESOURCE_CONFIGS,
      BRIOX_RESOURCE_CONFIGS, BL_RESOURCE_CONFIGS, WINT_RESOURCE_CONFIGS,
    ] as Partial<Record<ResourceType, { mapper: unknown }>>[]
    const registered = configs.flatMap((config) =>
      config[ResourceType.SupplierInvoices] ? [config[ResourceType.SupplierInvoices]!.mapper] : [])
    // WINT registers no supplier-invoice resource.
    expect(registered).toHaveLength(5)
    const covered = new Set<unknown>(SUPPLIER_CASES.map((c) => c.mapper))
    for (const mapper of registered) {
      expect(covered.has(mapper), `no credit-note contract case for ${(mapper as { name: string }).name}`).toBe(true)
    }
  })

  it('gives every supplier mapper the negative-total backstop, whatever flag it also reads', () => {
    for (const c of SUPPLIER_CASES) expect(c.negativeTotal, c.provider).toBeDefined()
  })

  describeContractCases(SUPPLIER_CASES)
})

describe('mapFortnoxToSupplierInvoice: the credit fields on the wire', () => {
  const credit = SUPPLIER_CASES[0].flaggedCredit!

  it('reads the flag as a boolean or a string, and the total as a number or a string', () => {
    for (const flag of [true, 'true', 'True']) {
      const dto = mapFortnoxToSupplierInvoice({ ...credit, Credit: flag, Total: 0, VAT: 0 })
      expect(dto.invoiceTypeCode, `Credit=${JSON.stringify(flag)}`).toBe(CREDIT_NOTE_TYPE_CODE)
      expect(dto.status).toBe('credited')
    }
    const { Credit: _flag, ...unflagged } = credit
    expect(mapFortnoxToSupplierInvoice({ ...unflagged, Total: '-1250.00' }).invoiceTypeCode).toBe(CREDIT_NOTE_TYPE_CODE)
    for (const flag of ['false', false, undefined, null, 0]) {
      const dto = mapFortnoxToSupplierInvoice({ ...SUPPLIER_CASES[0].ordinary, Credit: flag })
      expect(dto.invoiceTypeCode, `Credit=${JSON.stringify(flag)}`).toBeUndefined()
    }
  })

  it('reads CreditReference as a number or a string, ignores an empty one and never a self-reference', () => {
    expect(mapFortnoxToSupplierInvoice({ ...credit, CreditReference: '311' }).creditedInvoiceRef)
      .toEqual({ id: '311', invoiceNumber: '311' })
    for (const empty of ['0', 0, '', null, undefined, '312', 312]) {
      expect(mapFortnoxToSupplierInvoice({ ...credit, CreditReference: empty }).creditedInvoiceRef,
        `CreditReference=${JSON.stringify(empty)}`).toBeUndefined()
    }
  })

  it('a cancelled credit invoice stays cancelled in the DTO', () => {
    expect(mapFortnoxToSupplierInvoice({ ...credit, Cancelled: true }).status).toBe('cancelled')
  })
})
