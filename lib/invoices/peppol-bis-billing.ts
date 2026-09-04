import { escapeXml } from '@/lib/xml/escape'
import {
  generateOcrReference,
  validateBankgiroNumber,
  validatePlusgiroNumber,
} from '@/lib/bankgiro/luhn'
import { isSaneDateString, normalizeOrgNumber } from '@/lib/invariants'
import { resolveInvoicePaymentAccount } from '@/lib/invoices/payment-accounts'
import { computeLineAmounts, hasLineDiscount } from '@/lib/invoices/line-amounts'
import { getDisplayTotal } from '@/lib/invoices/rounding'
import { equalOre, roundOre } from '@/lib/money'
import type { CompanySettings, Customer, Invoice, InvoiceItem } from '@/types'

export const PEPPOL_BIS_BILLING_CUSTOMIZATION_ID =
  'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0'
export const PEPPOL_BIS_BILLING_PROFILE_ID =
  'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0'
/** Peppol document type identifier for a BIS Billing 3 UBL 2.1 invoice (SMP capability key). */
export const PEPPOL_BIS_BILLING_INVOICE_DOCUMENT_TYPE_ID =
  'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0::2.1'

const SUPPORTED_VAT_RATES = new Set([6, 12, 25])
const UNIT_CODES: Record<string, string> = {
  st: 'EA',
  tim: 'HUR',
  dag: 'DAY',
  'månad': 'MON',
  km: 'KMT',
  kg: 'KGM',
}

export interface PeppolValidationIssue {
  code: string
  field: string
  messageSv: string
  messageEn: string
}

export interface PeppolInvoiceInput {
  invoice: Invoice
  customer: Customer
  items: InvoiceItem[]
  company: CompanySettings
}

export type PeppolInvoiceResult =
  | {
      ok: true
      xml: string
      filename: string
      sender: { scheme: '0007'; identifier: string }
      recipient: { scheme: '0007'; identifier: string }
    }
  | { ok: false; issues: PeppolValidationIssue[] }

interface PreparedParty {
  name: string
  orgNumber: string
  vatNumber: string | null
  addressLine1: string
  addressLine2: string | null
  postalCode: string
  city: string
  email: string | null
  phone: string | null
}

interface PreparedInvoice {
  supplier: PreparedParty
  buyer: PreparedParty
  payment: {
    accountId: string
    branchId: 'SE:BANKGIRO' | 'SE:PLUSGIRO'
    paymentId: string
  }
  productItems: InvoiceItem[]
  taxBreakdown: Array<{ rate: number; taxableAmount: number; taxAmount: number }>
  payableAmount: number
  roundingAmount: number
}

function validationIssue(
  code: string,
  field: string,
  messageSv: string,
  messageEn: string,
): PeppolValidationIssue {
  return { code, field, messageSv, messageEn }
}

function roundMoney(value: number): number {
  return roundOre(value)
}

function equalMoney(left: number, right: number): boolean {
  return equalOre(left, right)
}

function formatMoney(value: number): string {
  const cents = Math.round(roundOre(value) * 100)
  const sign = cents < 0 ? '-' : ''
  const absolute = Math.abs(cents)
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`
}

function formatDecimal(value: number): string {
  const precision = 1_000_000
  const scaled = Math.round(value * precision)
  const sign = scaled < 0 ? '-' : ''
  const absolute = Math.abs(scaled)
  const whole = Math.floor(absolute / precision)
  const fraction = String(absolute % precision).padStart(6, '0').replace(/0+$/, '')
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`
}

function hasText(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeOrganizationNumber(value: string | null): string | null {
  return normalizeOrgNumber(value)
}

function normalizeVatNumber(value: string | null): string | null {
  return value?.replace(/[\s-]/g, '').toUpperCase() || null
}

function isIsoDate(value: string | null): value is string {
  return Boolean(value && isSaneDateString(value))
}

function prepareParty(
  role: 'supplier' | 'buyer',
  source: {
    name: string | null
    orgNumber: string | null
    vatNumber: string | null
    addressLine1: string | null
    addressLine2: string | null
    postalCode: string | null
    city: string | null
    country: string | null
    email: string | null
    phone: string | null
  },
  vatRequired: boolean,
  issues: PeppolValidationIssue[],
): PreparedParty | null {
  const prefixSv = role === 'supplier' ? 'Säljaren' : 'Köparen'
  const prefixEn = role === 'supplier' ? 'The seller' : 'The buyer'
  const fieldPrefix = role === 'supplier' ? 'company' : 'customer'
  const orgNumber = normalizeOrganizationNumber(source.orgNumber)

  if (!hasText(source.name)) {
    issues.push(validationIssue(
      `${role.toUpperCase()}_NAME_REQUIRED`, `${fieldPrefix}.name`,
      `${prefixSv} måste ha ett namn.`, `${prefixEn} must have a name.`,
    ))
  }
  if (!orgNumber) {
    issues.push(validationIssue(
      `${role.toUpperCase()}_ORG_NUMBER_INVALID`, `${fieldPrefix}.org_number`,
      `${prefixSv} måste ha ett giltigt svenskt organisationsnummer.`,
      `${prefixEn} must have a valid Swedish organization number.`,
    ))
  }
  if (orgNumber && Number(orgNumber[2]) < 2) {
    issues.push(validationIssue(
      `${role.toUpperCase()}_PARTICIPANT_IDENTIFIER_UNSUPPORTED`, `${fieldPrefix}.org_number`,
      `${prefixSv} måste använda ett organisationsnummer för 0007. Personnummerbaserade identifierare kräver GLN-stöd.`,
      `${prefixEn} must use an organization number for scheme 0007. Personal-identity-based identifiers require GLN support.`,
    ))
  }
  if (!hasText(source.addressLine1) || !hasText(source.postalCode) || !hasText(source.city)) {
    issues.push(validationIssue(
      `${role.toUpperCase()}_ADDRESS_REQUIRED`, `${fieldPrefix}.address`,
      `${prefixSv} måste ha gatuadress, postnummer och ort.`,
      `${prefixEn} must have a street address, postal code, and city.`,
    ))
  }
  if (source.country?.toUpperCase() !== 'SE') {
    issues.push(validationIssue(
      `${role.toUpperCase()}_COUNTRY_UNSUPPORTED`, `${fieldPrefix}.country`,
      `${prefixSv} måste ha Sverige som land för denna Peppol-export.`,
      `${prefixEn} must be located in Sweden for this Peppol export.`,
    ))
  }

  if (!orgNumber || Number(orgNumber[2]) < 2 || !hasText(source.name) || !hasText(source.addressLine1) ||
      !hasText(source.postalCode) || !hasText(source.city) || source.country?.toUpperCase() !== 'SE') {
    return null
  }

  const vatNumber = normalizeVatNumber(source.vatNumber)
  if (vatRequired && !vatNumber) {
    issues.push(validationIssue(
      `${role.toUpperCase()}_VAT_NUMBER_REQUIRED`, `${fieldPrefix}.vat_number`,
      `${prefixSv} måste ha sitt registrerade momsregistreringsnummer.`,
      `${prefixEn} must provide its registered VAT identifier.`,
    ))
    return null
  }
  if (vatNumber && !/^SE\d{12}$/.test(vatNumber)) {
    issues.push(validationIssue(
      `${role.toUpperCase()}_VAT_NUMBER_INVALID`, `${fieldPrefix}.vat_number`,
      `${prefixSv} måste ha ett svenskt momsregistreringsnummer med SE följt av 12 siffror.`,
      `${prefixEn} must have a Swedish VAT identifier with SE followed by 12 digits.`,
    ))
    return null
  }

  return {
    name: source.name.trim(),
    orgNumber,
    vatNumber,
    addressLine1: source.addressLine1.trim(),
    addressLine2: source.addressLine2?.trim() || null,
    postalCode: source.postalCode.trim(),
    city: source.city.trim(),
    email: source.email?.trim() || null,
    phone: source.phone?.trim() || null,
  }
}

function prepareInvoice(input: PeppolInvoiceInput):
  | { prepared: PreparedInvoice; issues: [] }
  | { prepared: null; issues: PeppolValidationIssue[] } {
  const { invoice, customer, company } = input
  const issues: PeppolValidationIssue[] = []

  if (invoice.document_type !== 'invoice' || invoice.credited_invoice_id || invoice.is_self_billed) {
    issues.push(validationIssue(
      'DOCUMENT_TYPE_UNSUPPORTED', 'invoice.document_type',
      'Endast vanliga kundfakturor kan exporteras i detta Peppol-format.',
      'Only standard customer invoices can be exported in this Peppol format.',
    ))
  }
  if (!hasText(invoice.invoice_number)) {
    issues.push(validationIssue(
      'INVOICE_NUMBER_REQUIRED', 'invoice.invoice_number',
      'Fakturan måste vara slutförd och ha ett fakturanummer före export.',
      'The invoice must be finalized and have an invoice number before export.',
    ))
  }
  if (invoice.status === 'cancelled') {
    issues.push(validationIssue(
      'CANCELLED_INVOICE_UNSUPPORTED', 'invoice.status',
      'En makulerad faktura kan inte exporteras till Peppol.',
      'A cancelled invoice cannot be exported to Peppol.',
    ))
  }
  if (invoice.currency !== 'SEK') {
    issues.push(validationIssue(
      'CURRENCY_UNSUPPORTED', 'invoice.currency',
      'Denna Peppol-export stöder endast svenska fakturor i SEK.',
      'This Peppol export supports Swedish invoices in SEK only.',
    ))
  }
  if (!isIsoDate(invoice.invoice_date) || !isIsoDate(invoice.due_date) ||
      (invoice.delivery_date !== null && !isIsoDate(invoice.delivery_date))) {
    issues.push(validationIssue(
      'DATE_INVALID', 'invoice.dates',
      'Fakturadatum, förfallodatum och leveransdatum måste vara giltiga datum.',
      'Invoice, due, and delivery dates must be valid dates.',
    ))
  }
  // BT-10 BuyerReference: fakturamärkning wins when set (SFTI convention:
  // the buyer's routing/marking string), else Er referens.
  if (!hasText(invoice.invoice_marking) && !hasText(invoice.your_reference)) {
    issues.push(validationIssue(
      'BUYER_REFERENCE_REQUIRED', 'invoice.your_reference',
      'Märkning eller Er referens krävs för Peppol när inköpsordernummer saknas.',
      'A marking or buyer reference is required for Peppol when no purchase order reference is available.',
    ))
  }
  if ((invoice.deduction_total ?? 0) !== 0) {
    issues.push(validationIssue(
      'DEDUCTION_UNSUPPORTED', 'invoice.deduction_total',
      'ROT- och RUT-avdrag stöds ännu inte av Peppol-exporten.',
      'ROT and RUT deductions are not yet supported by the Peppol export.',
    ))
  }
  if (!company.vat_registered || !['standard_25', 'reduced_12', 'reduced_6'].includes(invoice.vat_treatment)) {
    issues.push(validationIssue(
      'VAT_TREATMENT_UNSUPPORTED', 'invoice.vat_treatment',
      'Exporten stöder endast momspliktig svensk försäljning med 6, 12 eller 25 procent moms.',
      'The export supports taxable Swedish sales with 6, 12, or 25 percent VAT only.',
    ))
  }
  if (customer.customer_type !== 'swedish_business') {
    issues.push(validationIssue(
      'BUYER_TYPE_UNSUPPORTED', 'customer.customer_type',
      'Kunden måste vara ett svenskt företag eller en svensk organisation.',
      'The customer must be a Swedish business or organization.',
    ))
  }
  if (company.entity_type !== 'aktiebolag') {
    issues.push(validationIssue(
      'SUPPLIER_ENTITY_TYPE_UNSUPPORTED', 'company.entity_type',
      'Enskild firma kräver ett separat GLN som Peppol-identifierare. Exporten stöder därför endast aktiebolag tills GLN kan konfigureras.',
      'A sole trader requires a separate GLN as its Peppol identifier. This export therefore supports limited companies only until GLN can be configured.',
    ))
  }

  const supplier = prepareParty('supplier', {
    name: company.company_name,
    orgNumber: company.org_number,
    vatNumber: company.vat_number,
    addressLine1: company.address_line1,
    addressLine2: company.address_line2,
    postalCode: company.postal_code,
    city: company.city,
    country: company.country,
    email: company.email,
    phone: company.phone,
  }, true, issues)
  const buyer = prepareParty('buyer', {
    name: customer.name,
    orgNumber: customer.org_number,
    vatNumber: customer.vat_number,
    addressLine1: customer.address_line1,
    addressLine2: customer.address_line2,
    postalCode: customer.postal_code,
    city: customer.city,
    country: customer.country,
    email: customer.email,
    phone: customer.phone,
  }, false, issues)

  // Same payee the PDF and the email print: the resolver, not the raw legacy
  // columns. Peppol is SEK-only (validated above), so resolve for SEK.
  const payee = resolveInvoicePaymentAccount(company, 'SEK', invoice.payment_details ?? null)
  let payment: PreparedInvoice['payment'] | null = null
  if (hasText(payee?.bankgiro) && validateBankgiroNumber(payee.bankgiro)) {
    payment = {
      accountId: payee.bankgiro.replace(/\D/g, ''),
      branchId: 'SE:BANKGIRO',
      paymentId: generateOcrReference(invoice.invoice_number ?? ''),
    }
  } else if (hasText(payee?.plusgiro) && validatePlusgiroNumber(payee.plusgiro)) {
    payment = {
      accountId: payee.plusgiro.replace(/\D/g, ''),
      branchId: 'SE:PLUSGIRO',
      paymentId: generateOcrReference(invoice.invoice_number ?? ''),
    }
  } else {
    issues.push(validationIssue(
      'PAYMENT_ACCOUNT_REQUIRED', 'company.bankgiro',
      'Ett giltigt Bankgiro eller Plusgiro krävs för svensk Peppol-export.',
      'A valid Bankgiro or Plusgiro account is required for Swedish Peppol export.',
    ))
  }
  if (payment && !/^\d{2,25}$/.test(payment.paymentId)) {
    issues.push(validationIssue(
      'PAYMENT_REFERENCE_INVALID', 'invoice.invoice_number',
      'Fakturanumret kan inte omvandlas till en giltig OCR-referens.',
      'The invoice number cannot be converted to a valid OCR payment reference.',
    ))
    payment = null
  }

  const productItems = input.items
    .filter((item) => item.line_type !== 'text')
    .sort((left, right) => left.sort_order - right.sort_order)
  if (productItems.length === 0) {
    issues.push(validationIssue(
      'INVOICE_LINES_REQUIRED', 'invoice.items',
      'Minst en fakturarad med belopp krävs.',
      'At least one invoice line with an amount is required.',
    ))
  }

  const taxGroups = new Map<number, { taxableAmount: number; lineTaxAmount: number }>()
  productItems.forEach((item, index) => {
    const lineField = `invoice.items.${index}`
    if (!hasText(item.description) || !Number.isFinite(item.quantity) || item.quantity <= 0 ||
        !Number.isFinite(item.unit_price) || item.unit_price < 0 || !Number.isFinite(item.line_total)) {
      issues.push(validationIssue(
        'INVOICE_LINE_INVALID', lineField,
        `Fakturarad ${index + 1} måste ha beskrivning, positivt antal och giltiga belopp.`,
        `Invoice line ${index + 1} must have a description, positive quantity, and valid amounts.`,
      ))
    }
    if (!UNIT_CODES[item.unit]) {
      issues.push(validationIssue(
        'UNIT_UNSUPPORTED', `${lineField}.unit`,
        `Enheten på fakturarad ${index + 1} stöds inte av Peppol-exporten.`,
        `The unit on invoice line ${index + 1} is not supported by the Peppol export.`,
      ))
    }
    if (!SUPPORTED_VAT_RATES.has(item.vat_rate)) {
      issues.push(validationIssue(
        'VAT_RATE_UNSUPPORTED', `${lineField}.vat_rate`,
        `Momssatsen på fakturarad ${index + 1} måste vara 6, 12 eller 25 procent.`,
        `The VAT rate on invoice line ${index + 1} must be 6, 12, or 25 percent.`,
      ))
    }
    // Net of any line discount: line_total must equal (qty × price) − rabatt,
    // the same exact öre arithmetic the write path stores
    // (lib/invoices/line-amounts.ts) and the BG-27 allowance below renders.
    const expectedAmounts = computeLineAmounts(item.quantity, item.unit_price, item.discount_percent)
    if (!equalMoney(item.line_total, roundMoney(expectedAmounts.net))) {
      issues.push(validationIssue(
        'LINE_TOTAL_MISMATCH', `${lineField}.line_total`,
        `Beloppet på fakturarad ${index + 1} stämmer inte med antal gånger pris minus rabatt.`,
        `The amount on invoice line ${index + 1} does not equal quantity times price less discount.`,
      ))
    }
    if (item.discount_percent !== undefined && (item.discount_percent < 0 || item.discount_percent > 100)) {
      issues.push(validationIssue(
        'LINE_DISCOUNT_INVALID', `${lineField}.discount_percent`,
        `Rabatten på fakturarad ${index + 1} måste vara mellan 0 och 100 procent.`,
        `The discount on invoice line ${index + 1} must be between 0 and 100 percent.`,
      ))
    }
    if (!equalMoney(item.vat_amount, roundMoney(item.line_total * item.vat_rate / 100))) {
      issues.push(validationIssue(
        'LINE_VAT_MISMATCH', `${lineField}.vat_amount`,
        `Momsbeloppet på fakturarad ${index + 1} stämmer inte.`,
        `The VAT amount on invoice line ${index + 1} is inconsistent.`,
      ))
    }
    const group = taxGroups.get(item.vat_rate) ?? { taxableAmount: 0, lineTaxAmount: 0 }
    group.taxableAmount = roundMoney(group.taxableAmount + item.line_total)
    group.lineTaxAmount = roundMoney(group.lineTaxAmount + item.vat_amount)
    taxGroups.set(item.vat_rate, group)
  })

  const taxBreakdown = [...taxGroups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([rate, group]) => ({
      rate,
      taxableAmount: group.taxableAmount,
      taxAmount: roundMoney(group.taxableAmount * rate / 100),
    }))
  taxBreakdown.forEach((group) => {
    if (!equalMoney(group.taxAmount, taxGroups.get(group.rate)?.lineTaxAmount ?? 0)) {
      issues.push(validationIssue(
        'VAT_ROUNDING_MISMATCH', 'invoice.items',
        `Momsavrundningen för ${group.rate} procent kan inte uttryckas enligt EN 16931. Justera fakturaraderna.`,
        `VAT rounding for the ${group.rate} percent category cannot be represented under EN 16931. Adjust the invoice lines.`,
      ))
    }
  })

  const calculatedSubtotal = roundMoney(productItems.reduce((sum, item) => sum + item.line_total, 0))
  const calculatedVat = roundMoney(taxBreakdown.reduce((sum, group) => sum + group.taxAmount, 0))
  const calculatedTotal = roundMoney(calculatedSubtotal + calculatedVat)
  if (!equalMoney(invoice.subtotal, calculatedSubtotal) ||
      !equalMoney(invoice.vat_amount, calculatedVat) || !equalMoney(invoice.total, calculatedTotal)) {
    issues.push(validationIssue(
      'INVOICE_TOTALS_MISMATCH', 'invoice.total',
      'Fakturans delsumma, moms eller total stämmer inte med fakturaraderna.',
      'The invoice subtotal, VAT, or total does not reconcile with its lines.',
    ))
  }

  const rounding = getDisplayTotal(invoice, company)
  if (rounding.displayed <= 0) {
    issues.push(validationIssue(
      'PAYABLE_AMOUNT_INVALID', 'invoice.total',
      'Beloppet att betala måste vara större än noll.',
      'The payable amount must be greater than zero.',
    ))
  }

  if (issues.length > 0 || !supplier || !buyer || !payment) return { prepared: null, issues }
  return {
    prepared: {
      supplier,
      buyer,
      payment,
      productItems,
      taxBreakdown,
      payableAmount: rounding.displayed,
      roundingAmount: rounding.roundingDelta,
    },
    issues: [],
  }
}

function renderAddress(party: PreparedParty): string {
  return [
    `        <cbc:StreetName>${escapeXml(party.addressLine1)}</cbc:StreetName>`,
    party.addressLine2
      ? `        <cbc:AdditionalStreetName>${escapeXml(party.addressLine2)}</cbc:AdditionalStreetName>`
      : null,
    `        <cbc:CityName>${escapeXml(party.city)}</cbc:CityName>`,
    `        <cbc:PostalZone>${escapeXml(party.postalCode)}</cbc:PostalZone>`,
    '        <cac:Country>',
    '          <cbc:IdentificationCode>SE</cbc:IdentificationCode>',
    '        </cac:Country>',
  ].filter(Boolean).join('\n')
}

function renderContact(party: PreparedParty): string | null {
  if (!party.email && !party.phone) return null
  return [
    '      <cac:Contact>',
    party.phone ? `        <cbc:Telephone>${escapeXml(party.phone)}</cbc:Telephone>` : null,
    party.email ? `        <cbc:ElectronicMail>${escapeXml(party.email)}</cbc:ElectronicMail>` : null,
    '      </cac:Contact>',
  ].filter(Boolean).join('\n')
}

function renderParty(
  wrapper: 'AccountingSupplierParty' | 'AccountingCustomerParty',
  party: PreparedParty,
  fSkatt: boolean,
): string {
  const taxBlocks = [
    party.vatNumber
      ? [
          '      <cac:PartyTaxScheme>',
          `        <cbc:CompanyID>${party.vatNumber}</cbc:CompanyID>`,
          '        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>',
          '      </cac:PartyTaxScheme>',
        ].join('\n')
      : null,
    wrapper === 'AccountingSupplierParty' && fSkatt
      ? [
          '      <cac:PartyTaxScheme>',
          '        <cbc:CompanyID>Godkänd för F-skatt</cbc:CompanyID>',
          '        <cac:TaxScheme><cbc:ID>TAX</cbc:ID></cac:TaxScheme>',
          '      </cac:PartyTaxScheme>',
        ].join('\n')
      : null,
  ].filter(Boolean)

  return [
    `  <cac:${wrapper}>`,
    '    <cac:Party>',
    `      <cbc:EndpointID schemeID="0007">${party.orgNumber}</cbc:EndpointID>`,
    '      <cac:PartyIdentification>',
    `        <cbc:ID schemeID="0007">${party.orgNumber}</cbc:ID>`,
    '      </cac:PartyIdentification>',
    '      <cac:PostalAddress>',
    renderAddress(party),
    '      </cac:PostalAddress>',
    ...taxBlocks,
    '      <cac:PartyLegalEntity>',
    `        <cbc:RegistrationName>${escapeXml(party.name)}</cbc:RegistrationName>`,
    `        <cbc:CompanyID schemeID="0007">${party.orgNumber}</cbc:CompanyID>`,
    '      </cac:PartyLegalEntity>',
    renderContact(party),
    '    </cac:Party>',
    `  </cac:${wrapper}>`,
  ].filter(Boolean).join('\n')
}

function renderInvoiceXml(input: PeppolInvoiceInput, prepared: PreparedInvoice): string {
  const { invoice, company } = input
  const taxTotal = roundMoney(prepared.taxBreakdown.reduce((sum, group) => sum + group.taxAmount, 0))
  const taxSubtotals = prepared.taxBreakdown.flatMap((group) => [
    '    <cac:TaxSubtotal>',
    `      <cbc:TaxableAmount currencyID="SEK">${formatMoney(group.taxableAmount)}</cbc:TaxableAmount>`,
    `      <cbc:TaxAmount currencyID="SEK">${formatMoney(group.taxAmount)}</cbc:TaxAmount>`,
    '      <cac:TaxCategory>',
    '        <cbc:ID>S</cbc:ID>',
    `        <cbc:Percent>${formatDecimal(group.rate)}</cbc:Percent>`,
    '        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>',
    '      </cac:TaxCategory>',
    '    </cac:TaxSubtotal>',
  ])
  const invoiceLines = prepared.productItems.flatMap((item, index) => {
    // Line discount as a BG-27 allowance: LineExtensionAmount stays the net
    // line_total and the allowance documents base − amount = net exactly
    // (the amounts come from the same öre arithmetic as the stored total).
    const amounts = computeLineAmounts(item.quantity, item.unit_price, item.discount_percent)
    const allowance = hasLineDiscount(item.discount_percent)
      ? [
          '    <cac:AllowanceCharge>',
          '      <cbc:ChargeIndicator>false</cbc:ChargeIndicator>',
          '      <cbc:AllowanceChargeReasonCode>95</cbc:AllowanceChargeReasonCode>',
          '      <cbc:AllowanceChargeReason>Rabatt</cbc:AllowanceChargeReason>',
          `      <cbc:MultiplierFactorNumeric>${formatDecimal(item.discount_percent as number)}</cbc:MultiplierFactorNumeric>`,
          `      <cbc:Amount currencyID="SEK">${formatMoney(amounts.discount)}</cbc:Amount>`,
          `      <cbc:BaseAmount currencyID="SEK">${formatMoney(amounts.gross)}</cbc:BaseAmount>`,
          '    </cac:AllowanceCharge>',
        ]
      : []
    return [
    '  <cac:InvoiceLine>',
    `    <cbc:ID>${index + 1}</cbc:ID>`,
    `    <cbc:InvoicedQuantity unitCode="${UNIT_CODES[item.unit]}">${formatDecimal(item.quantity)}</cbc:InvoicedQuantity>`,
    `    <cbc:LineExtensionAmount currencyID="SEK">${formatMoney(item.line_total)}</cbc:LineExtensionAmount>`,
    ...allowance,
    '    <cac:Item>',
    `      <cbc:Name>${escapeXml(item.description.trim())}</cbc:Name>`,
    '      <cac:ClassifiedTaxCategory>',
    '        <cbc:ID>S</cbc:ID>',
    `        <cbc:Percent>${formatDecimal(item.vat_rate)}</cbc:Percent>`,
    '        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>',
    '      </cac:ClassifiedTaxCategory>',
    '    </cac:Item>',
    '    <cac:Price>',
    `      <cbc:PriceAmount currencyID="SEK">${formatDecimal(item.unit_price)}</cbc:PriceAmount>`,
    '    </cac:Price>',
    '  </cac:InvoiceLine>',
    ]
  })

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"',
    '  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"',
    '  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">',
    `  <cbc:CustomizationID>${PEPPOL_BIS_BILLING_CUSTOMIZATION_ID}</cbc:CustomizationID>`,
    `  <cbc:ProfileID>${PEPPOL_BIS_BILLING_PROFILE_ID}</cbc:ProfileID>`,
    `  <cbc:ID>${escapeXml(invoice.invoice_number ?? '')}</cbc:ID>`,
    `  <cbc:IssueDate>${invoice.invoice_date}</cbc:IssueDate>`,
    `  <cbc:DueDate>${invoice.due_date}</cbc:DueDate>`,
    '  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>',
    invoice.notes ? `  <cbc:Note>${escapeXml(invoice.notes)}</cbc:Note>` : null,
    '  <cbc:DocumentCurrencyCode>SEK</cbc:DocumentCurrencyCode>',
    `  <cbc:BuyerReference>${escapeXml((invoice.invoice_marking?.trim() || invoice.your_reference?.trim()) ?? '')}</cbc:BuyerReference>`,
    renderParty('AccountingSupplierParty', prepared.supplier, company.f_skatt),
    renderParty('AccountingCustomerParty', prepared.buyer, false),
    invoice.delivery_date
      ? `  <cac:Delivery><cbc:ActualDeliveryDate>${invoice.delivery_date}</cbc:ActualDeliveryDate></cac:Delivery>`
      : null,
    '  <cac:PaymentMeans>',
    '    <cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>',
    `    <cbc:PaymentID>${prepared.payment.paymentId}</cbc:PaymentID>`,
    '    <cac:PayeeFinancialAccount>',
    `      <cbc:ID>${prepared.payment.accountId}</cbc:ID>`,
    '      <cac:FinancialInstitutionBranch>',
    `        <cbc:ID>${prepared.payment.branchId}</cbc:ID>`,
    '      </cac:FinancialInstitutionBranch>',
    '    </cac:PayeeFinancialAccount>',
    '  </cac:PaymentMeans>',
    '  <cac:TaxTotal>',
    `    <cbc:TaxAmount currencyID="SEK">${formatMoney(taxTotal)}</cbc:TaxAmount>`,
    ...taxSubtotals,
    '  </cac:TaxTotal>',
    '  <cac:LegalMonetaryTotal>',
    `    <cbc:LineExtensionAmount currencyID="SEK">${formatMoney(invoice.subtotal)}</cbc:LineExtensionAmount>`,
    `    <cbc:TaxExclusiveAmount currencyID="SEK">${formatMoney(invoice.subtotal)}</cbc:TaxExclusiveAmount>`,
    `    <cbc:TaxInclusiveAmount currencyID="SEK">${formatMoney(invoice.total)}</cbc:TaxInclusiveAmount>`,
    prepared.roundingAmount !== 0
      ? `    <cbc:PayableRoundingAmount currencyID="SEK">${formatMoney(prepared.roundingAmount)}</cbc:PayableRoundingAmount>`
      : null,
    `    <cbc:PayableAmount currencyID="SEK">${formatMoney(prepared.payableAmount)}</cbc:PayableAmount>`,
    '  </cac:LegalMonetaryTotal>',
    ...invoiceLines,
    '</Invoice>',
    '',
  ].filter(Boolean).join('\n')
}

export function generatePeppolBisBillingInvoice(input: PeppolInvoiceInput): PeppolInvoiceResult {
  const validation = prepareInvoice(input)
  if (validation.prepared === null) return { ok: false, issues: validation.issues }

  const filenameNumber = (input.invoice.invoice_number ?? input.invoice.id)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || input.invoice.id
  return {
    ok: true,
    xml: renderInvoiceXml(input, validation.prepared),
    filename: `peppol-invoice-${filenameNumber}.xml`,
    sender: { scheme: '0007', identifier: validation.prepared.supplier.orgNumber },
    recipient: { scheme: '0007', identifier: validation.prepared.buyer.orgNumber },
  }
}
