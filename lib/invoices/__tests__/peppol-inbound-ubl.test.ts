import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parseUblJsonDocument,
  swedishOrgNumberFrom,
  ublAttr,
  ublChildren,
  ublText,
} from '@/lib/invoices/peppol-inbound-ubl'

/** Qvalia's live UBL-JSON for the first inbound sandbox invoice (contact data sanitized). */
const QVALIA_MESSAGE = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'qvalia-inbound-invoice.json'), 'utf8'),
) as unknown

describe('parseUblJsonDocument', () => {
  it('reads the Qvalia inbound invoice end to end', () => {
    const doc = parseUblJsonDocument(QVALIA_MESSAGE)
    expect(doc).not.toBeNull()
    if (!doc) return

    expect(doc.documentType).toBe('Invoice')
    expect(doc.documentId).toBe('20267497')
    expect(doc.customizationId).toBe('urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0')
    expect(doc.issueDate).toBe('2026-08-21')
    expect(doc.dueDate).toBe('2026-09-20')
    expect(doc.typeCode).toBe('380')
    expect(doc.currency).toBe('SEK')
    expect(doc.buyerReference).toBe('Test kundreferens')

    expect(doc.supplier).toMatchObject({
      name: 'Qvalia AB',
      endpoint: { scheme: '0007', identifier: '5567321707' },
      legalCompanyId: '5567321707',
      orgNumber: '5567321707',
      vatNumber: 'SE556732170701',
      street: 'Wallingatan 33 3tr',
      city: 'Stockholm',
      postalZone: '11124',
      countryCode: 'SE',
      email: 'help@qvalia.com',
    })
    expect(doc.customer).toMatchObject({
      name: 'Arcim Technology AB',
      endpoint: { scheme: '0007', identifier: '5595386219' },
      orgNumber: '5595386219',
    })

    expect(doc.paymentMeans).toHaveLength(1)
    expect(doc.paymentMeans[0]).toMatchObject({
      code: '30',
      accountId: '12344321',
      branchId: 'BBAN',
      bankgiro: null,
      plusgiro: null,
      iban: null,
    })

    expect(doc.totals).toEqual({
      lineExtension: 100,
      taxExclusive: 100,
      taxInclusive: 112,
      allowanceTotal: null,
      chargeTotal: 0,
      prepaid: null,
      payableRounding: 0,
      payable: 112,
      taxAmount: 12,
    })
    expect(doc.taxSubtotals).toEqual([
      { taxableAmount: 100, taxAmount: 12, categoryId: 'S', percent: 12, exemptionReason: null },
    ])
    expect(doc.lines).toEqual([{
      id: '1',
      name: 'New test item',
      description: null,
      quantity: 1,
      unitCode: 'EA',
      priceAmount: 100,
      lineExtensionAmount: 100,
      vatCategoryId: 'S',
      vatPercent: 12,
      sellersItemId: '123789',
      buyerAccountingCost: null,
    }])
    expect(doc.attachments).toEqual([])
    expect(doc.warnings).toEqual([])
  })

  it('reads the OASIS UBL-JSON shape (bare keys, attributes beside the text) and Swedish giro branches', () => {
    const doc = parseUblJsonDocument({
      Invoice: {
        ID: [{ _: 'F-1' }],
        IssueDate: [{ _: '2026-08-01' }],
        DocumentCurrencyCode: [{ _: 'SEK' }],
        AccountingSupplierParty: [{ Party: [{
          EndpointID: [{ _: '5560160680', schemeID: '0007' }],
          PartyLegalEntity: [{ RegistrationName: [{ _: 'Säljare AB' }], CompanyID: [{ _: '556016-0680' }] }],
        }] }],
        AccountingCustomerParty: [{ Party: [{ EndpointID: [{ _: '5595386219', schemeID: '0007' }] }] }],
        PaymentMeans: [
          { PaymentMeansCode: [{ _: '30' }], PaymentID: [{ _: '123456789' }], PayeeFinancialAccount: [{ ID: [{ _: '991-2346' }], FinancialInstitutionBranch: [{ ID: [{ _: 'SE:BANKGIRO' }] }] }] },
          { PaymentMeansCode: [{ _: '58' }], PayeeFinancialAccount: [{ ID: [{ _: 'SE45 5000 0000 0583 9825 7466' }] }] },
        ],
        LegalMonetaryTotal: [{ PayableAmount: [{ _: '125.50', currencyID: 'SEK' }] }],
        InvoiceLine: [{ ID: [{ _: '1' }], InvoicedQuantity: [{ _: '2', unitCode: 'HUR' }], LineExtensionAmount: [{ _: '100' }], Item: [{ Name: [{ _: 'Rådgivning' }] }] }],
      },
    })
    expect(doc?.supplier.orgNumber).toBe('5560160680')
    expect(doc?.paymentMeans[0]).toMatchObject({ paymentId: '123456789', bankgiro: '9912346', branchId: 'SE:BANKGIRO' })
    expect(doc?.paymentMeans[1].iban).toBe('SE4550000000058398257466')
    expect(doc?.totals.payable).toBe(125.5)
    expect(doc?.lines[0]).toMatchObject({ quantity: 2, unitCode: 'HUR', name: 'Rådgivning' })
    expect(doc?.warnings).toEqual([])
  })

  it('recognizes credit notes, billing references and embedded attachments', () => {
    const doc = parseUblJsonDocument({
      'CreditNote': {
        'cbc:ID': [{ _: 'K-9' }],
        'cac:BillingReference': [{ 'cac:InvoiceDocumentReference': [{ 'cbc:ID': [{ _: 'F-1' }] }] }],
        'cac:AdditionalDocumentReference': [{
          'cbc:ID': [{ _: 'spec' }],
          'cac:Attachment': [{ 'cbc:EmbeddedDocumentBinaryObject': [{ _: 'UjBsR09E', $: { mimeCode: 'application/pdf', filename: 'spec.pdf' } }] }],
        }],
        'cac:AccountingSupplierParty': [{ 'cac:Party': [{ 'cbc:EndpointID': [{ _: '1', $: { schemeID: '0088' } }] }] }],
        'cac:AccountingCustomerParty': [{ 'cac:Party': [{}] }],
        'cac:LegalMonetaryTotal': [{ 'cbc:PayableAmount': [{ _: '-100' }] }],
        'cac:CreditNoteLine': [{ 'cbc:ID': [{ _: '1' }], 'cbc:CreditedQuantity': [{ _: '1' }] }],
      },
    })
    expect(doc?.documentType).toBe('CreditNote')
    expect(doc?.billingReferences).toEqual(['F-1'])
    expect(doc?.attachments).toEqual([{
      id: 'spec', description: null, filename: 'spec.pdf', mimeType: 'application/pdf', base64: 'UjBsR09E', externalUri: null,
    }])
    expect(doc?.supplier.orgNumber).toBeNull()
    expect(doc?.totals.payable).toBe(-100)
  })

  it('returns null for non-UBL input and records warnings instead of throwing on thin documents', () => {
    expect(parseUblJsonDocument(null)).toBeNull()
    expect(parseUblJsonDocument({ Order: {} })).toBeNull()
    const thin = parseUblJsonDocument({ Invoice: { 'cac:InvoiceLine': [] , 'cbc:ID': [{ _: 'X' }] } })
    expect(thin?.documentId).toBe('X')
    expect(thin?.warnings).toEqual(expect.arrayContaining(['no lines', 'payable amount missing']))
  })
})

describe('ubl helpers', () => {
  it('read prefixed and bare keys, attributes in both placements, and org numbers', () => {
    const node = { 'cbc:ID': [{ _: 'a', $: { schemeID: 'x' } }], Name: 'plain' }
    expect(ublText(node, 'ID')).toBe('a')
    expect(ublAttr(ublChildren(node, 'ID')[0], 'schemeID')).toBe('x')
    expect(ublText(node, 'Name')).toBe('plain')
    expect(swedishOrgNumberFrom('556016-0680')).toBe('5560160680')
    expect(swedishOrgNumberFrom('165560160680')).toBe('5560160680')
    expect(swedishOrgNumberFrom('12', null)).toBeNull()
  })
})
