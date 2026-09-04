import { describe, expect, it } from 'vitest'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import type { InvoiceItem } from '@/types'
import {
  generatePeppolBisBillingInvoice,
  PEPPOL_BIS_BILLING_CUSTOMIZATION_ID,
  PEPPOL_BIS_BILLING_PROFILE_ID,
} from '../peppol-bis-billing'

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

  it('rejects VAT rounding that conflicts with EN 16931 category rounding', () => {
    const input = makeValidInput()
    input.items = [
      makeItem({ id: 'item-1', quantity: 1, unit_price: 0.01, line_total: 0.01, vat_amount: 0 }),
      makeItem({ id: 'item-2', sort_order: 1, quantity: 1, unit_price: 0.01, line_total: 0.01, vat_amount: 0 }),
    ]
    input.invoice = makeInvoice({
      ...input.invoice,
      subtotal: 0.02,
      vat_amount: 0,
      total: 0.02,
      remaining_amount: 0.02,
      ore_rounding: false,
    })

    const result = generatePeppolBisBillingInvoice(input)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.map(({ code }) => code)).toContain('VAT_ROUNDING_MISMATCH')
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

  it('prefers invoice_marking over your_reference for BT-10 BuyerReference', () => {
    const input = makeValidInput()
    input.invoice = makeInvoice({ ...input.invoice, invoice_marking: 'KST 4711' })

    const result = generatePeppolBisBillingInvoice(input)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.xml).toContain('<cbc:BuyerReference>KST 4711</cbc:BuyerReference>')
  })

  it('accepts a marking-only invoice (no your_reference) as buyer reference', () => {
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
})
