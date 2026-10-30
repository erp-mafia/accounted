import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase, makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import { generateOcrReference } from '@/lib/bankgiro/luhn'
import { computeLineVat } from '@/lib/bookkeeping/invoice-line-amounts'
import { buildInvoiceWriteData } from '@/lib/invoices/build-invoice-write'
import { roundOre, sumOre } from '@/lib/money'
import type { EntityType, InvoiceItem } from '@/types'
import {
  generatePeppolBisBillingInvoice,
  peppolAttachmentIssues,
  PEPPOL_BIS_BILLING_CUSTOMIZATION_ID,
  PEPPOL_BIS_BILLING_PROFILE_ID,
} from '../peppol-bis-billing'
import { countTextRowsLeftOutOfPeppol } from '../peppol-lines'

function makeItem(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'item-1',
    invoice_id: 'invoice-1',
    sort_order: 0,
    line_type: 'product',
    description: 'Rådgivning',
    quantity: 2,
    unit: 'tim',
    unit_price: 100,
    line_total: 200,
    vat_rate: 25,
    vat_amount: 50,
    ...overrides,
  }
}

function makeValidInput() {
  const customer = makeCustomer({
    name: 'Kund & Partner AB',
    org_number: '556677-8899',
    vat_number: 'SE556677889901',
  })
  const company = makeCompanySettings({
    company_name: 'Säljare <Sverige> AB',
    entity_type: 'aktiebolag',
    org_number: '556016-0680',
    vat_number: 'SE556016068001',
    bankgiro: '991-2346',
    ore_rounding: true,
  })
  const items = [
    makeItem(),
    makeItem({
      id: 'item-2',
      sort_order: 1,
      description: 'Lunch',
      quantity: 1,
      unit: 'st',
      unit_price: 100,
      line_total: 100,
      vat_rate: 12,
      vat_amount: 12,
    }),
  ]
  const invoice = makeInvoice({
    id: 'invoice-1',
    invoice_number: 'F-2026-42',
    invoice_date: '2026-08-13',
    due_date: '2026-09-12',
    delivery_date: '2026-08-12',
    status: 'sent',
    subtotal: 300,
    vat_amount: 62,
    total: 362,
    remaining_amount: 362,
    vat_treatment: 'standard_25',
    your_reference: 'REF & 42',
    notes: 'Tack <igen>',
  })
  return { invoice, customer, company, items }
}

/**
 * Per-line VAT exactly as the creation path stores it: every line is rounded to
 * öre on its own (computeLineVat, which lib/invoices/build-invoice-write.ts
 * stores) and the header VAT is the sum of those rounded amounts. Sweden
 * permits that; EN 16931 has no way to express it, which is why the
 * difference has to travel in BT-114.
 */
function storedLineVat(lineTotal: number, vatRate: number): number {
  return computeLineVat(lineTotal, vatRate)
}

/** An invoice built from single-unit lines with creation-path per-line VAT. */
function makePerLineRoundingInput(lines: Array<{ unitPrice: number; vatRate: number }>) {
  const input = makeValidInput()
  input.items = lines.map(({ unitPrice, vatRate }, index) => makeItem({
    id: `item-${index + 1}`,
    sort_order: index,
    quantity: 1,
    unit: 'st',
    unit_price: unitPrice,
    line_total: unitPrice,
    vat_rate: vatRate,
    vat_amount: storedLineVat(unitPrice, vatRate),
  }))
  const subtotal = sumOre(input.items.map((item) => item.line_total))
  const vatAmount = sumOre(input.items.map((item) => item.vat_amount))
  const total = roundOre(subtotal + vatAmount)
  input.invoice = makeInvoice({
    ...input.invoice,
    subtotal,
    vat_amount: vatAmount,
    total,
    remaining_amount: total,
    // Öresavrundning off so the assertions isolate the VAT-split delta.
    ore_rounding: false,
  })
  return input
}

describe('generatePeppolBisBillingInvoice', () => {
  it('prints the same payee as the PDF: the resolved SEK payment account, not the raw legacy column', () => {
    const input = makeValidInput()
    // Legacy column says one bankgiro, the resolver's SEK entry another (the
    // state a v1/MCP settings write used to leave behind). The XML must
    // follow the resolver, like the PDF and the email do.
    input.company = makeCompanySettings({
      ...input.company,
      bankgiro: '991-2346',
      invoice_payment_accounts: {
        SEK: {
          bank_name: null,
          clearing_number: null,
          account_number: null,
          bankgiro: '5050-1055',
          plusgiro: null,
          swish: null,
          iban: null,
          bic: null,
          bank_code: null,
          foreign_account_number: null,
        },
      },
    })

    const result = generatePeppolBisBillingInvoice(input)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.xml).toContain('<cbc:ID>50501055</cbc:ID>')
    expect(result.xml).not.toContain('9912346')
  })

  it('generates a Swedish Peppol BIS Billing 3 invoice with reconciled VAT groups', () => {
    const result = generatePeppolBisBillingInvoice(makeValidInput())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.filename).toBe('peppol-invoice-F-2026-42.xml')
    expect(result.xml).toContain(`<cbc:CustomizationID>${PEPPOL_BIS_BILLING_CUSTOMIZATION_ID}</cbc:CustomizationID>`)
    expect(result.xml).toContain(`<cbc:ProfileID>${PEPPOL_BIS_BILLING_PROFILE_ID}</cbc:ProfileID>`)
    expect(result.xml).toContain('<cbc:EndpointID schemeID="0007">5560160680</cbc:EndpointID>')
    expect(result.xml).toContain('<cbc:EndpointID schemeID="0007">5566778899</cbc:EndpointID>')
    expect(result.xml).toContain('<cbc:CompanyID>Godkänd för F-skatt</cbc:CompanyID>')
    expect(result.xml).toContain('<cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>')
    expect(result.xml).toContain('<cbc:ID>SE:BANKGIRO</cbc:ID>')
    expect(result.xml).toContain('<cbc:TaxableAmount currencyID="SEK">100.00</cbc:TaxableAmount>')
    expect(result.xml).toContain('<cbc:TaxableAmount currencyID="SEK">200.00</cbc:TaxableAmount>')
    expect(result.xml).toContain('<cbc:TaxAmount currencyID="SEK">62.00</cbc:TaxAmount>')
    expect(result.xml).toContain('<cbc:PayableAmount currencyID="SEK">362.00</cbc:PayableAmount>')
    expect(result.xml).toContain('<cbc:InvoicedQuantity unitCode="HUR">2</cbc:InvoicedQuantity>')
  })

  it('escapes user-controlled XML values without damaging Swedish text', () => {
    const result = generatePeppolBisBillingInvoice(makeValidInput())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.xml).toContain('<cbc:RegistrationName>Säljare &lt;Sverige&gt; AB</cbc:RegistrationName>')
    expect(result.xml).toContain('<cbc:RegistrationName>Kund &amp; Partner AB</cbc:RegistrationName>')
    expect(result.xml).toContain('<cbc:BuyerReference>REF &amp; 42</cbc:BuyerReference>')
    expect(result.xml).toContain('<cbc:Note>Tack &lt;igen&gt;</cbc:Note>')
  })

  it('expresses öresavrundning as PayableRoundingAmount', () => {
    const input = makeValidInput()
    input.items = [makeItem({ quantity: 1, unit_price: 80.4, line_total: 80.4, vat_amount: 20.1 })]
    input.invoice = makeInvoice({
      ...input.invoice,
      subtotal: 80.4,
      vat_amount: 20.1,
      total: 100.5,
      remaining_amount: 101,
    })

    const result = generatePeppolBisBillingInvoice(input)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.xml).toContain('<cbc:TaxInclusiveAmount currencyID="SEK">100.50</cbc:TaxInclusiveAmount>')
    expect(result.xml).toContain('<cbc:PayableRoundingAmount currencyID="SEK">0.50</cbc:PayableRoundingAmount>')
    expect(result.xml).toContain('<cbc:PayableAmount currencyID="SEK">101.00</cbc:PayableAmount>')
  })

  it('rejects invoice data outside the supported profile', () => {
    const input = makeValidInput()
    input.invoice = makeInvoice({
      ...input.invoice,
      invoice_number: null,
      currency: 'EUR',
      your_reference: null,
      deduction_total: 10,
    })
    input.customer = makeCustomer({ ...input.customer, customer_type: 'individual' })
    input.company = makeCompanySettings({ ...input.company, bankgiro: null })
    input.items = [makeItem({ unit: 'paket', vat_rate: 0, vat_amount: 0 })]

    const result = generatePeppolBisBillingInvoice(input)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.map(({ code }) => code)).toEqual(expect.arrayContaining([
      'INVOICE_NUMBER_REQUIRED',
      'CURRENCY_UNSUPPORTED',
      'BUYER_REFERENCE_REQUIRED',
      'DEDUCTION_UNSUPPORTED',
      'BUYER_TYPE_UNSUPPORTED',
      'PAYMENT_ACCOUNT_REQUIRED',
      'UNIT_UNSUPPORTED',
      'VAT_RATE_UNSUPPORTED',
    ]))
  })

  it('exports per-line VAT rounding as BT-114 instead of rejecting it (#2544)', () => {
    // 3 × 99,99 at 25%: the creation path stores 25,00 per line (75,00 total),
    // EN 16931 BR-CO-17 derives 299,97 × 25% = 74,99 for the category. The öre
    // of difference rides in PayableRoundingAmount so the customer still owes
    // the 374,97 that was invoiced, booked and printed on the PDF.
    const input = makePerLineRoundingInput([
      { unitPrice: 99.99, vatRate: 25 },
      { unitPrice: 99.99, vatRate: 25 },
      { unitPrice: 99.99, vatRate: 25 },
    ])
    expect(input.invoice.vat_amount).toBe(75)
    expect(input.invoice.total).toBe(374.97)

    const result = generatePeppolBisBillingInvoice(input)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.xml).toContain('<cbc:TaxExclusiveAmount currencyID="SEK">299.97</cbc:TaxExclusiveAmount>')
    expect(result.xml).toContain('<cbc:TaxAmount currencyID="SEK">74.99</cbc:TaxAmount>')
    expect(result.xml).toContain('<cbc:TaxInclusiveAmount currencyID="SEK">374.96</cbc:TaxInclusiveAmount>')
    expect(result.xml).toContain('<cbc:PayableRoundingAmount currencyID="SEK">0.01</cbc:PayableRoundingAmount>')
    expect(result.xml).toContain('<cbc:PayableAmount currencyID="SEK">374.97</cbc:PayableAmount>')
  })

  it('nets the per-line rounding delta across several VAT categories', () => {
    // 3 × 99,99 at 25% (+0,01) and 3 × 99,90 at 12% (+0,01).
    const input = makePerLineRoundingInput([
      { unitPrice: 99.99, vatRate: 25 },
      { unitPrice: 99.99, vatRate: 25 },
      { unitPrice: 99.99, vatRate: 25 },
      { unitPrice: 99.9, vatRate: 12 },
      { unitPrice: 99.9, vatRate: 12 },
      { unitPrice: 99.9, vatRate: 12 },
    ])
    expect(input.invoice.total).toBe(710.64)

    const result = generatePeppolBisBillingInvoice(input)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.xml).toContain('<cbc:TaxableAmount currencyID="SEK">299.70</cbc:TaxableAmount>')
    expect(result.xml).toContain('<cbc:TaxAmount currencyID="SEK">35.96</cbc:TaxAmount>')
    expect(result.xml).toContain('<cbc:TaxAmount currencyID="SEK">74.99</cbc:TaxAmount>')
    expect(result.xml).toContain('<cbc:TaxAmount currencyID="SEK">110.95</cbc:TaxAmount>')
    expect(result.xml).toContain('<cbc:TaxInclusiveAmount currencyID="SEK">710.62</cbc:TaxInclusiveAmount>')
    expect(result.xml).toContain('<cbc:PayableRoundingAmount currencyID="SEK">0.02</cbc:PayableRoundingAmount>')
    expect(result.xml).toContain('<cbc:PayableAmount currencyID="SEK">710.64</cbc:PayableAmount>')
  })

  it('accepts per-line rounding that accumulates over many lines', () => {
    // The band scales with the line count, so a 10-line invoice whose delta is
    // 2 öre is still a legitimate export and not a rounding "mismatch".
    const input = makePerLineRoundingInput(
      Array.from({ length: 10 }, () => ({ unitPrice: 99.99, vatRate: 25 })),
    )

    const result = generatePeppolBisBillingInvoice(input)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.xml).toContain('<cbc:TaxInclusiveAmount currencyID="SEK">1249.88</cbc:TaxInclusiveAmount>')
    expect(result.xml).toContain('<cbc:PayableRoundingAmount currencyID="SEK">0.02</cbc:PayableRoundingAmount>')
    expect(result.xml).toContain('<cbc:PayableAmount currencyID="SEK">1249.90</cbc:PayableAmount>')
  })

  it('carries a negative per-line rounding delta as a negative BT-114', () => {
    // Two 0,01 lines: each rounds to 0,00 VAT, the 0,02 category base rounds to
    // 0,01. This fixture used to be a hard VAT_ROUNDING_MISMATCH reject.
    const input = makePerLineRoundingInput([
      { unitPrice: 0.01, vatRate: 25 },
      { unitPrice: 0.01, vatRate: 25 },
    ])
    expect(input.invoice.vat_amount).toBe(0)

    const result = generatePeppolBisBillingInvoice(input)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.xml).toContain('<cbc:TaxInclusiveAmount currencyID="SEK">0.03</cbc:TaxInclusiveAmount>')
    expect(result.xml).toContain('<cbc:PayableRoundingAmount currencyID="SEK">-0.01</cbc:PayableRoundingAmount>')
    expect(result.xml).toContain('<cbc:PayableAmount currencyID="SEK">0.02</cbc:PayableAmount>')
  })

  it('rejects VAT amounts that are wrong rather than merely rounded per line', () => {
    const input = makeValidInput()
    // The 25% line nets 200,00, so its VAT is 50,00. A stored 51,00 is a whole
    // krona out: far outside anything per-line öre rounding can produce.
    input.items = [makeItem({ vat_amount: 51 }), input.items[1]]
    input.invoice = makeInvoice({
      ...input.invoice,
      vat_amount: 63,
      total: 363,
      remaining_amount: 363,
    })

    const result = generatePeppolBisBillingInvoice(input)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.map(({ code }) => code)).toEqual(expect.arrayContaining([
      'LINE_VAT_MISMATCH',
      'VAT_ROUNDING_MISMATCH',
    ]))
  })

  it('accepts a half-öre VAT line exactly as the invoice builder stores it (crm#1343)', async () => {
    // 5713 st x 0,10 kr at 25 %: the builder stored 142,82 while this check
    // computed 142,83, so the invoice could not be sent (LINE_VAT_MISMATCH).
    // Both now use computeLineVat.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })
    const input = makeValidInput()
    const build = await buildInvoiceWriteData({
      supabase: supabase as unknown as SupabaseClient,
      companyId: 'company-1',
      customer: input.customer,
      documentType: 'invoice',
      input: {
        customer_id: input.customer.id,
        invoice_date: '2026-08-13',
        due_date: '2026-09-12',
        currency: 'SEK',
        items: [{ description: 'Etikett', quantity: 5713, unit: 'st', unit_price: 0.1, vat_rate: 25 }],
      },
    })
    expect(build.ok).toBe(true)
    if (!build.ok) return
    input.items = build.items.map((row, index) => makeItem({
      ...row,
      id: `item-${index + 1}`,
      line_type: 'product',
    }))
    input.invoice = makeInvoice({
      ...input.invoice,
      subtotal: build.invoiceFields.subtotal,
      vat_amount: build.invoiceFields.vat_amount,
      total: build.invoiceFields.total,
      remaining_amount: build.invoiceFields.remaining_amount,
      ore_rounding: false,
    })
    expect(input.items[0].vat_amount).toBe(142.83)

    const result = generatePeppolBisBillingInvoice(input)

    expect(result.ok ? [] : result.issues.map(({ code }) => code)).toEqual([])
  })

  it('still flags the 142,82 the old rounding stored on that line', () => {
    const input = makePerLineRoundingInput([{ unitPrice: 571.3, vatRate: 25 }])
    input.items = [{ ...input.items[0], vat_amount: 142.82 }]
    input.invoice = makeInvoice({ ...input.invoice, vat_amount: 142.82, total: 714.12, remaining_amount: 714.12 })

    const result = generatePeppolBisBillingInvoice(input)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.map(({ code }) => code)).toContain('LINE_VAT_MISMATCH')
  })

  it('rejects invoice totals that do not reconcile to the emitted lines', () => {
    const input = makeValidInput()
    input.invoice = makeInvoice({ ...input.invoice, total: 999 })

    const result = generatePeppolBisBillingInvoice(input)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.map(({ code }) => code)).toContain('INVOICE_TOTALS_MISMATCH')
  })

  it('requires the seller registered VAT identifier instead of deriving one', () => {
    const input = makeValidInput()
    input.company = makeCompanySettings({ ...input.company, vat_number: null })

    const result = generatePeppolBisBillingInvoice(input)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.map(({ code }) => code)).toContain('SUPPLIER_VAT_NUMBER_REQUIRED')
  })

  it('validates a Swedish VAT identifier without assuming it is derived from the org number', () => {
    const input = makeValidInput()
    input.company = makeCompanySettings({ ...input.company, vat_number: 'SE123456789012' })

    const result = generatePeppolBisBillingInvoice(input)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.xml).toContain('<cbc:CompanyID>SE123456789012</cbc:CompanyID>')
  })

  it('rejects a malformed Swedish seller VAT identifier', () => {
    const input = makeValidInput()
    input.company = makeCompanySettings({ ...input.company, vat_number: 'SE5560160680' })

    const result = generatePeppolBisBillingInvoice(input)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.map(({ code }) => code)).toContain('SUPPLIER_VAT_NUMBER_INVALID')
  })

  it('accepts the 12-digit organization-number form used by Swedish systems', () => {
    const input = makeValidInput()
    input.company = makeCompanySettings({ ...input.company, org_number: '165560160680' })

    const result = generatePeppolBisBillingInvoice(input)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.xml).toContain('<cbc:EndpointID schemeID="0007">5560160680</cbc:EndpointID>')
  })

  it('rejects a sole trader until a non-personal GLN participant ID can be configured', () => {
    const input = makeValidInput()
    input.company = makeCompanySettings({
      ...input.company,
      entity_type: 'enskild_firma',
      org_number: '800101-1231',
    })

    const result = generatePeppolBisBillingInvoice(input)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.map(({ code }) => code)).toEqual(expect.arrayContaining([
      'SUPPLIER_ENTITY_TYPE_UNSUPPORTED',
      'SUPPLIER_PARTICIPANT_IDENTIFIER_UNSUPPORTED',
    ]))
  })

  it('accepts an ideell förening with an organisationsnummer as supplier for the same reason', () => {
    const input = makeValidInput()
    input.company = makeCompanySettings({ ...input.company, entity_type: 'ideell_forening' })
    const result = generatePeppolBisBillingInvoice(input)
    if (!result.ok) {
      expect(result.issues.map(({ code }) => code)).not.toContain('SUPPLIER_ENTITY_TYPE_UNSUPPORTED')
    }
  })

  it('accepts an ekonomisk förening as supplier: its organisationsnummer is a scheme 0007 participant', () => {
    const input = makeValidInput()
    input.company = makeCompanySettings({ ...input.company, entity_type: 'ekonomisk_forening' })

    const result = generatePeppolBisBillingInvoice(input)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.xml).toContain('schemeID="0007"')
    }
  })

  it('rejects a personnummer-only buyer instead of labeling it as scheme 0007', () => {
    const input = makeValidInput()
    input.customer = makeCustomer({ ...input.customer, org_number: '800101-1231' })

    const result = generatePeppolBisBillingInvoice(input)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.map(({ code }) => code)).toContain(
      'BUYER_PARTICIPANT_IDENTIFIER_UNSUPPORTED',
    )
  })

  it('sends your_reference as BT-10 BuyerReference and invoice_marking as BT-13 OrderReference', () => {
    const input = makeValidInput()
    input.invoice = makeInvoice({ ...input.invoice, invoice_marking: 'PO & 4711' })

    const result = generatePeppolBisBillingInvoice(input)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.xml).toContain('<cbc:BuyerReference>REF &amp; 42</cbc:BuyerReference>')
    expect(result.xml).toContain(
      '  <cbc:BuyerReference>REF &amp; 42</cbc:BuyerReference>\n' +
      '  <cac:OrderReference>\n' +
      '    <cbc:ID>PO &amp; 4711</cbc:ID>\n' +
      '  </cac:OrderReference>\n' +
      '  <cac:AccountingSupplierParty>',
    )
  })

  it('leaves out exactly the text rows the send dialog warns about, and keeps the note', () => {
    const input = makeValidInput()
    input.items = [
      makeItem({ id: 'text-1', sort_order: 0, line_type: 'text', description: 'Avser projekt Norrland' }),
      makeItem({ ...input.items[0], sort_order: 1 }),
      makeItem({ id: 'text-2', sort_order: 2, line_type: 'text', description: ' ' }),
      makeItem({ ...input.items[1], sort_order: 3 }),
    ]

    const result = generatePeppolBisBillingInvoice(input)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.xml).not.toContain('Avser projekt Norrland')
    expect(result.xml.match(/<cac:InvoiceLine>/g)).toHaveLength(2)
    expect(result.xml).toContain('<cbc:Note>Tack &lt;igen&gt;</cbc:Note>')
    expect(countTextRowsLeftOutOfPeppol(input.items)).toBe(1)
  })

  it('omits BT-13 OrderReference when there is no invoice_marking', () => {
    const result = generatePeppolBisBillingInvoice(makeValidInput())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.xml).not.toContain('<cac:OrderReference>')
  })

  it('falls back to invoice_marking for BT-10 when there is no your_reference', () => {
    const input = makeValidInput()
    input.invoice = makeInvoice({
      ...input.invoice,
      your_reference: null,
      invoice_marking: 'PO-2026-17',
    })

    const result = generatePeppolBisBillingInvoice(input)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.xml).toContain('<cbc:BuyerReference>PO-2026-17</cbc:BuyerReference>')
    expect(result.xml).toContain('<cac:OrderReference>\n    <cbc:ID>PO-2026-17</cbc:ID>')
  })

  it('sends the Er referens the invoice was issued with as BT-10 only, never the card or BT-19 (crm#1200)', () => {
    // The Fakturareferens is copied into your_reference when the invoice is
    // written; a later change to the card must not reach an issued invoice.
    // BT-19 AccountingCost stays unset: the field is free text (a cost centre
    // or a person), and the skill documents only BT-10 for buyer routing.
    const input = makeValidInput()
    input.customer = makeCustomer({ ...input.customer, invoice_reference: 'KST 5520' })
    input.invoice = makeInvoice({ ...input.invoice, your_reference: 'KST 4410' })

    const result = generatePeppolBisBillingInvoice(input)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.xml).toContain('<cbc:BuyerReference>KST 4410</cbc:BuyerReference>')
    expect(result.xml).not.toContain('KST 5520')
    expect(result.xml).not.toContain('AccountingCost')
  })

  it('renders a per-line discount as a BG-27 allowance with net LineExtensionAmount', () => {
    const input = makeValidInput()
    // 2 × 100 = 200 gross, 10% discount = 20, net 180, VAT 25% on net = 45.
    input.items = [
      makeItem({ discount_percent: 10, line_total: 180, vat_amount: 45 }),
    ]
    input.invoice = makeInvoice({
      ...input.invoice,
      subtotal: 180,
      vat_amount: 45,
      total: 225,
      remaining_amount: 225,
    })

    const result = generatePeppolBisBillingInvoice(input)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.xml).toContain('<cbc:LineExtensionAmount currencyID="SEK">180.00</cbc:LineExtensionAmount>')
    expect(result.xml).toContain('<cbc:ChargeIndicator>false</cbc:ChargeIndicator>')
    expect(result.xml).toContain('<cbc:AllowanceChargeReasonCode>95</cbc:AllowanceChargeReasonCode>')
    expect(result.xml).toContain('<cbc:MultiplierFactorNumeric>10</cbc:MultiplierFactorNumeric>')
    expect(result.xml).toContain('<cbc:Amount currencyID="SEK">20.00</cbc:Amount>')
    expect(result.xml).toContain('<cbc:BaseAmount currencyID="SEK">200.00</cbc:BaseAmount>')
    // The undiscounted unit price stays in cac:Price (BT-146).
    expect(result.xml).toContain('<cbc:PriceAmount currencyID="SEK">100</cbc:PriceAmount>')
  })

  it('rejects a discounted line whose stored total is not net of the discount', () => {
    const input = makeValidInput()
    input.items = [makeItem({ discount_percent: 10, line_total: 200, vat_amount: 50 })]

    const result = generatePeppolBisBillingInvoice(input)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.map(({ code }) => code)).toContain('LINE_TOTAL_MISMATCH')
  })

  it('rejects credit notes and self-billed invoices in the generation layer', () => {
    for (const invoice of [
      makeInvoice({
        ...makeValidInput().invoice,
        credited_invoice_id: '22222222-2222-4222-8222-222222222222',
      }),
      makeInvoice({ ...makeValidInput().invoice, is_self_billed: true }),
    ]) {
      const input = makeValidInput()
      input.invoice = invoice
      const result = generatePeppolBisBillingInvoice(input)

      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.issues.map(({ code }) => code)).toContain('DOCUMENT_TYPE_UNSUPPORTED')
    }
  })

  // Founder decision 2026-09-29: with no valid bankgiro or plusgiro the
  // invoice is paid to the IBAN (with the BIC when there is one).
  describe('payee precedence: bankgiro, then plusgiro, then IBAN', () => {
    const IBAN = 'SE4550000000058398257466'

    function paymentMeans(xml: string): string {
      const end = '</cac:PaymentMeans>'
      return xml.slice(xml.indexOf('<cac:PaymentMeans>'), xml.indexOf(end) + end.length)
    }

    it('pays to the IBAN, with the BIC as BT-86, when the company has no bankgiro or plusgiro', () => {
      const input = makeValidInput()
      input.company = makeCompanySettings({
        ...input.company,
        bankgiro: null,
        iban: 'se45 5000 0000 0583 9825 7466',
        bic: 'ESSESESS',
      })

      const result = generatePeppolBisBillingInvoice(input)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(paymentMeans(result.xml)).toBe([
        '<cac:PaymentMeans>',
        '    <cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>',
        `    <cbc:PaymentID>${generateOcrReference('F-2026-42')}</cbc:PaymentID>`,
        '    <cac:PayeeFinancialAccount>',
        `      <cbc:ID>${IBAN}</cbc:ID>`,
        '      <cac:FinancialInstitutionBranch>',
        '        <cbc:ID>ESSESESS</cbc:ID>',
        '      </cac:FinancialInstitutionBranch>',
        '    </cac:PayeeFinancialAccount>',
        '  </cac:PaymentMeans>',
      ].join('\n'))
    })

    it('leaves out FinancialInstitutionBranch for an IBAN without a valid BIC', () => {
      for (const bic of [null, 'ESSE']) {
        const input = makeValidInput()
        input.company = makeCompanySettings({ ...input.company, bankgiro: null, iban: IBAN, bic })

        const result = generatePeppolBisBillingInvoice(input)

        expect(result.ok).toBe(true)
        if (!result.ok) continue
        expect(paymentMeans(result.xml)).toContain(`<cbc:ID>${IBAN}</cbc:ID>`)
        expect(paymentMeans(result.xml)).toContain('<cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>')
        expect(paymentMeans(result.xml)).not.toContain('FinancialInstitutionBranch')
      }
    })

    it('prefers the bankgiro over an IBAN', () => {
      const input = makeValidInput()
      input.company = makeCompanySettings({ ...input.company, iban: IBAN, bic: 'ESSESESS' })

      const result = generatePeppolBisBillingInvoice(input)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(paymentMeans(result.xml)).toContain('<cbc:ID>9912346</cbc:ID>')
      expect(paymentMeans(result.xml)).toContain('<cbc:ID>SE:BANKGIRO</cbc:ID>')
      expect(result.xml).not.toContain(IBAN)
      expect(result.xml).not.toContain('ESSESESS')
    })

    it('prefers the plusgiro over an IBAN', () => {
      const input = makeValidInput()
      input.company = makeCompanySettings({
        ...input.company,
        bankgiro: null,
        plusgiro: '4567-4',
        iban: IBAN,
        bic: 'ESSESESS',
      })

      const result = generatePeppolBisBillingInvoice(input)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(paymentMeans(result.xml)).toContain('<cbc:ID>45674</cbc:ID>')
      expect(paymentMeans(result.xml)).toContain('<cbc:ID>SE:PLUSGIRO</cbc:ID>')
      expect(result.xml).not.toContain(IBAN)
    })

    it('falls through a bankgiro that fails its check digit to the IBAN', () => {
      const input = makeValidInput()
      input.company = makeCompanySettings({ ...input.company, bankgiro: '991-2345', iban: IBAN, bic: null })

      const result = generatePeppolBisBillingInvoice(input)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(paymentMeans(result.xml)).toContain(`<cbc:ID>${IBAN}</cbc:ID>`)
      expect(result.xml).not.toContain('SE:BANKGIRO')
    })

    it('refuses an IBAN that fails its checksum when there is no giro to fall back on', () => {
      const input = makeValidInput()
      input.company = makeCompanySettings({
        ...input.company,
        bankgiro: null,
        iban: 'SE4550000000058398257467',
        bic: 'ESSESESS',
      })

      const result = generatePeppolBisBillingInvoice(input)

      expect(result.ok).toBe(false)
      if (result.ok) return
      const issue = result.issues.find(({ code }) => code === 'PAYMENT_ACCOUNT_REQUIRED')
      expect(issue?.messageSv).toBe('Ett giltigt Bankgiro, Plusgiro eller IBAN krävs för svensk Peppol-export.')
      expect(issue?.messageEn).toBe('A valid Bankgiro, Plusgiro or IBAN is required for Swedish Peppol export.')
    })
  })

  // Founder decision 2026-09-29: every legal form with an organisationsnummer
  // sends; only a form whose org number is the owner's personnummer waits for
  // a GLN. The gate reads that capability, never a list of forms.
  describe('sender legal form', () => {
    it.each<[string, string, string]>([
      ['ideell_forening', '802002-1237', 'SE802002123701'],
      // Not in EntityType yet (PLANNED_LEGAL_FORMS, #2652): a form the
      // registry does not know is not refused by name either.
      ['ekonomisk_forening', '769600-1234', 'SE769600123401'],
    ])('lets a %s send under its organisationsnummer', (form, orgNumber, vatNumber) => {
      const input = makeValidInput()
      input.company = makeCompanySettings({
        ...input.company,
        entity_type: form as EntityType,
        org_number: orgNumber,
        vat_number: vatNumber,
      })

      const result = generatePeppolBisBillingInvoice(input)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.sender).toEqual({ scheme: '0007', identifier: orgNumber.replace('-', '') })
    })

    it('refuses an enskild firma with the GLN explanation', () => {
      const input = makeValidInput()
      input.company = makeCompanySettings({
        ...input.company,
        entity_type: 'enskild_firma',
        org_number: '800101-1231',
      })

      const result = generatePeppolBisBillingInvoice(input)

      expect(result.ok).toBe(false)
      if (result.ok) return
      const issue = result.issues.find(({ code }) => code === 'SUPPLIER_ENTITY_TYPE_UNSUPPORTED')
      expect(issue?.messageSv).toBe(
        'Enskild firma har ägarens personnummer som organisationsnummer och behöver därför ett separat GLN som Peppol-identifierare. GLN kan inte konfigureras ännu.',
      )
      expect(issue?.messageEn).toMatch(/personal identity number as its organisation number, so it needs a separate GLN/)
      expect(`${issue?.messageSv} ${issue?.messageEn}`).not.toMatch(/aktiebolag|limited compan/i)
    })
  })
})

// crm#1084: the article number frozen on the line travels as BT-155 (Item
// Seller's identifier) when the company prints article numbers.
describe('generatePeppolBisBillingInvoice: article number', () => {
  function inputWithArticleLine(showArticleNumber: boolean | undefined) {
    const input = makeValidInput()
    input.company = makeCompanySettings({ ...input.company, invoice_show_article_number: showArticleNumber })
    input.items = [
      { ...input.items[0], article_id: 'art-1', article_number: 'A-<100>' },
      { ...input.items[1], article_id: null, article_number: null },
    ]
    return input
  }

  it('sends the number as SellersItemIdentification, after Name and before ClassifiedTaxCategory', () => {
    const result = generatePeppolBisBillingInvoice(inputWithArticleLine(true))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const firstLine = result.xml.slice(result.xml.indexOf('<cac:InvoiceLine>'), result.xml.indexOf('</cac:InvoiceLine>'))
    expect(firstLine).toContain('<cac:SellersItemIdentification>\n        <cbc:ID>A-&lt;100&gt;</cbc:ID>\n      </cac:SellersItemIdentification>')
    expect(firstLine.indexOf('<cbc:Name>')).toBeLessThan(firstLine.indexOf('<cac:SellersItemIdentification>'))
    expect(firstLine.indexOf('<cac:SellersItemIdentification>')).toBeLessThan(firstLine.indexOf('<cac:ClassifiedTaxCategory>'))
    // The free-text line carries none.
    expect(result.xml.split('<cac:SellersItemIdentification>')).toHaveLength(2)
  })

  it('sends no seller item identifier while the setting is off', () => {
    for (const setting of [false, undefined]) {
      const result = generatePeppolBisBillingInvoice(inputWithArticleLine(setting))
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.xml).not.toContain('SellersItemIdentification')
    }
  })
})

describe('embedded attachments (crm#1545)', () => {
  const MB = 1024 * 1024
  const pdf = (filename: string, bytes = 32) => ({
    filename,
    contentType: 'application/pdf',
    content: Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(Math.max(bytes - 9, 0), 0x20)]),
  })

  it('embeds each PDF as an AdditionalDocumentReference between the order reference and the seller, in order', () => {
    const input = makeValidInput()
    input.invoice = makeInvoice({ ...input.invoice, invoice_marking: 'PO 4711' })
    const first = pdf('Tidrapport <oktober>.pdf')
    const second = pdf('Dagbok.pdf')

    const result = generatePeppolBisBillingInvoice({ ...input, attachments: [first, second] })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.xml).toContain(
      '  </cac:OrderReference>\n' +
      '  <cac:AdditionalDocumentReference>\n' +
      '    <cbc:ID>Tidrapport &lt;oktober&gt;.pdf</cbc:ID>\n' +
      '    <cac:Attachment>\n' +
      `      <cbc:EmbeddedDocumentBinaryObject mimeCode="application/pdf" filename="Tidrapport &lt;oktober&gt;.pdf">${first.content.toString('base64')}</cbc:EmbeddedDocumentBinaryObject>\n` +
      '    </cac:Attachment>\n' +
      '  </cac:AdditionalDocumentReference>\n' +
      '  <cac:AdditionalDocumentReference>\n' +
      '    <cbc:ID>Dagbok.pdf</cbc:ID>',
    )
    const xml = result.xml
    expect(xml.indexOf('Dagbok.pdf')).toBeLessThan(xml.indexOf('<cac:AccountingSupplierParty>'))
    // No DocumentTypeCode: in BIS Billing 3 it marks an invoiced object (BT-18), not an attachment.
    expect(xml).not.toContain('DocumentTypeCode')
    // The invoice number stays the document's first cbc:ID (the transport reads it from there).
    expect(/<cbc:ID>([^<]+)<\/cbc:ID>/.exec(xml)?.[1]).toBe('F-2026-42')
  })

  it('emits no AdditionalDocumentReference without attachments', () => {
    const result = generatePeppolBisBillingInvoice(makeValidInput())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.xml).not.toContain('AdditionalDocumentReference')
  })

  it('refuses a file that is not a PDF with a Swedish message naming it', () => {
    const result = generatePeppolBisBillingInvoice({
      ...makeValidInput(),
      attachments: [pdf('ok.pdf'), { filename: 'bild.png', contentType: 'image/png', content: Buffer.from('png') }],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'PEPPOL_ATTACHMENT_NOT_PDF',
        field: 'attachments[1]',
        messageSv: expect.stringContaining('bild.png är ingen PDF'),
      }),
    ])
  })

  it('accepts exactly 5 MB of files and refuses one byte more, in Swedish', () => {
    const atLimit = generatePeppolBisBillingInvoice({
      ...makeValidInput(),
      attachments: [pdf('a.pdf', 3 * MB), pdf('b.pdf', 2 * MB)],
    })
    expect(atLimit.ok).toBe(true)

    const over = generatePeppolBisBillingInvoice({
      ...makeValidInput(),
      attachments: [pdf('a.pdf', 3 * MB), pdf('b.pdf', 2 * MB + 1)],
    })
    expect(over.ok).toBe(false)
    if (over.ok) return
    expect(over.issues).toEqual([
      expect.objectContaining({
        code: 'PEPPOL_ATTACHMENTS_TOO_LARGE',
        messageSv: expect.stringContaining('högst 5 MB tillsammans via Peppol'),
      }),
    ])
  })
})

describe('peppolAttachmentIssues (crm#1545)', () => {
  it('judges stored metadata the same way: a missing type is not a PDF', () => {
    expect(peppolAttachmentIssues([{ filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 10 }])).toEqual([])
    expect(peppolAttachmentIssues([{ filename: 'a.pdf', contentType: null, sizeBytes: 10 }]).map((i) => i.code))
      .toEqual(['PEPPOL_ATTACHMENT_NOT_PDF'])
  })
})
