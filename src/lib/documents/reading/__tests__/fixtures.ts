/**
 * Synthetic documents for the reading tests: a Peppol invoice and credit
 * note as the Access Point's UBL-JSON (the xml2js rendering of the XML:
 * prefixed keys, every element an array, text under `_`, attributes under
 * `$`), and inbox extractions of a receipt and a credit note as a model
 * reads them. Every name and number is made up.
 */
import type { InvoiceExtractionResult } from '@/types'

const t = (value: string | number) => [{ _: String(value) }]
const sek = (value: number) => [{ _: String(value), $: { currencyID: 'SEK' } }]

export const SELLER_ORG = '5500000001'
export const SELLER_VAT = 'SE550000000101'

function supplierParty() {
  return [
    {
      'cac:Party': [
        {
          'cbc:EndpointID': [{ _: SELLER_ORG, $: { schemeID: '0007' } }],
          'cac:PartyName': [{ 'cbc:Name': t('Exempel Leverantör') }],
          'cac:PostalAddress': [
            {
              'cbc:StreetName': t('Provgatan 1'),
              'cbc:CityName': t('Exempelstad'),
              'cbc:PostalZone': t('11122'),
              'cac:Country': [{ 'cbc:IdentificationCode': t('SE') }],
            },
          ],
          'cac:PartyTaxScheme': [{ 'cbc:CompanyID': t(SELLER_VAT), 'cac:TaxScheme': [{ 'cbc:ID': t('VAT') }] }],
          'cac:PartyLegalEntity': [{ 'cbc:RegistrationName': t('Exempel Leverantör AB'), 'cbc:CompanyID': t(SELLER_ORG) }],
        },
      ],
    },
  ]
}

function customerParty() {
  return [{ 'cac:Party': [{ 'cbc:EndpointID': [{ _: '5500000002', $: { schemeID: '0007' } }], 'cac:PartyLegalEntity': [{ 'cbc:RegistrationName': t('Mottagare AB') }] }] }]
}

const taxTotal = () => [
  {
    'cbc:TaxAmount': sek(250),
    'cac:TaxSubtotal': [
      {
        'cbc:TaxableAmount': sek(1000),
        'cbc:TaxAmount': sek(250),
        'cac:TaxCategory': [{ 'cbc:ID': t('S'), 'cbc:Percent': t('25'), 'cac:TaxScheme': [{ 'cbc:ID': t('VAT') }] }],
      },
    ],
  },
]

const monetaryTotal = () => [
  { 'cbc:LineExtensionAmount': sek(1000), 'cbc:TaxExclusiveAmount': sek(1000), 'cbc:TaxInclusiveAmount': sek(1250), 'cbc:PayableAmount': sek(1250) },
]

const item = () => [{ 'cbc:Name': t('Konsulttimme'), 'cac:ClassifiedTaxCategory': [{ 'cbc:ID': t('S'), 'cbc:Percent': t('25'), 'cac:TaxScheme': [{ 'cbc:ID': t('VAT') }] }] }]

/** A Peppol BIS Billing 3 invoice: 2 hours at 500, 25 % VAT, bankgiro with an OCR reference. */
export function peppolInvoiceJson() {
  return {
    Invoice: [
      {
        'cbc:CustomizationID': t('urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0'),
        'cbc:ProfileID': t('urn:fdc:peppol.eu:2017:poacc:billing:01:1.0'),
        'cbc:ID': t('INV-1001'),
        'cbc:IssueDate': t('2026-10-01'),
        'cbc:DueDate': t('2026-10-31'),
        'cbc:InvoiceTypeCode': t('380'),
        'cbc:DocumentCurrencyCode': t('SEK'),
        'cbc:BuyerReference': t('REF-1'),
        'cac:AccountingSupplierParty': supplierParty(),
        'cac:AccountingCustomerParty': customerParty(),
        'cac:PaymentMeans': [
          {
            'cbc:PaymentMeansCode': t('30'),
            'cbc:PaymentID': t('1234567897'),
            'cac:PayeeFinancialAccount': [{ 'cbc:ID': t('1234567'), 'cac:FinancialInstitutionBranch': [{ 'cbc:ID': t('SE:BANKGIRO') }] }],
          },
        ],
        'cac:TaxTotal': taxTotal(),
        'cac:LegalMonetaryTotal': monetaryTotal(),
        'cac:InvoiceLine': [
          {
            'cbc:ID': t('1'),
            'cbc:InvoicedQuantity': [{ _: '2', $: { unitCode: 'HUR' } }],
            'cbc:LineExtensionAmount': sek(1000),
            'cac:Item': item(),
            'cac:Price': [{ 'cbc:PriceAmount': sek(500) }],
          },
        ],
      },
    ],
  }
}

/** A Peppol credit note crediting INV-1001 in full. */
export function peppolCreditNoteJson() {
  return {
    CreditNote: [
      {
        'cbc:CustomizationID': t('urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0'),
        'cbc:ID': t('CN-77'),
        'cbc:IssueDate': t('2026-10-05'),
        'cbc:CreditNoteTypeCode': t('381'),
        'cbc:DocumentCurrencyCode': t('SEK'),
        'cac:BillingReference': [{ 'cac:InvoiceDocumentReference': [{ 'cbc:ID': t('INV-1001') }] }],
        'cac:AccountingSupplierParty': supplierParty(),
        'cac:AccountingCustomerParty': customerParty(),
        'cac:TaxTotal': taxTotal(),
        'cac:LegalMonetaryTotal': monetaryTotal(),
        'cac:CreditNoteLine': [
          {
            'cbc:ID': t('1'),
            'cbc:CreditedQuantity': [{ _: '2', $: { unitCode: 'HUR' } }],
            'cbc:LineExtensionAmount': sek(1000),
            'cac:Item': item(),
            'cac:Price': [{ 'cbc:PriceAmount': sek(500) }],
          },
        ],
      },
    ],
  }
}

/** A café receipt as the model reads a photo of it: 6 % and 12 % VAT, öresavrundning. */
export function receiptExtraction(overrides: Partial<InvoiceExtractionResult> = {}): InvoiceExtractionResult {
  return {
    documentKind: 'receipt',
    legibility: 'good',
    supplier: { name: 'Kafé Exempel', orgNumber: '550000-0003', vatNumber: null, address: null, bankgiro: null, plusgiro: null, iban: null, bic: null },
    invoice: { invoiceNumber: 'K-42', invoiceDate: '2026-10-02', dueDate: null, paymentReference: null, currency: 'SEK', creditedInvoiceNumber: null },
    lineItems: [{ description: 'Kaffe', quantity: 1, unitPrice: 45, lineTotal: 45, vatRate: 12, accountSuggestion: null }],
    totals: { subtotal: 134.86, vatAmount: 13.14, total: 148, roundingAmount: 0 },
    vatBreakdown: [
      { rate: 12, base: 40.18, amount: 4.82 },
      { rate: 6, base: 94.68, amount: 8.32 },
    ],
    confidence: 1,
    ...overrides,
  }
}

/** A supplier credit note as the model reads its PDF: amounts below zero, the credited invoice named. */
export function creditNoteExtraction(): InvoiceExtractionResult {
  return {
    documentKind: 'credit_note',
    legibility: 'good',
    supplier: { name: 'Exempel Leverantör AB', orgNumber: SELLER_ORG, vatNumber: SELLER_VAT, address: null, bankgiro: '123-4567', plusgiro: null, iban: null, bic: null },
    invoice: { invoiceNumber: 'CN-9', invoiceDate: '2026-10-06', dueDate: null, paymentReference: null, currency: 'SEK', creditedInvoiceNumber: 'INV-0900' },
    lineItems: [{ description: 'Återbetalning', quantity: 1, unitPrice: -400, lineTotal: -400, vatRate: 25, accountSuggestion: null }],
    totals: { subtotal: -400, vatAmount: -100, total: -500, roundingAmount: null },
    vatBreakdown: [{ rate: 25, base: -400, amount: -100 }],
    confidence: 1,
  }
}
