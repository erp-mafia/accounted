/**
 * Inbound Peppol BIS Billing 3 documents, read from the UBL-JSON the Access
 * Point hands us. Qvalia's JSON is the xml2js rendering of the UBL XML
 * (verified live 2026-08-21): element keys keep their namespace prefix
 * (`cac:AccountingSupplierParty`, `cbc:ID`), every element is an array, text
 * sits under `_` and attributes under `$`. The OASIS UBL-JSON form (no
 * prefixes, attributes beside `_`) is read the same way so a later XML->JSON
 * converter does not need a second reader.
 *
 * This is a reader, not a validator: the Access Point validated the document
 * against the Peppol rules before accepting it. Anything the reader cannot
 * make sense of lands in `warnings` instead of throwing, because a received
 * e-invoice is räkenskapsinformation and must reach the inbox even when a
 * field is odd.
 */

export type UblJsonNode = Record<string, unknown>

export interface PeppolInboundEndpoint {
  scheme: string
  identifier: string
}

export interface PeppolInboundParty {
  name: string | null
  endpoint: PeppolInboundEndpoint | null
  /** cac:PartyLegalEntity/cbc:CompanyID as written, e.g. "556732-1707". */
  legalCompanyId: string | null
  /** Ten digits when a Swedish organisation number could be derived, else null. */
  orgNumber: string | null
  vatNumber: string | null
  street: string | null
  additionalStreet: string | null
  city: string | null
  postalZone: string | null
  countryCode: string | null
  email: string | null
  phone: string | null
}

export interface PeppolInboundPaymentMeans {
  code: string | null
  /** cbc:PaymentID, for Swedish payments the OCR reference. */
  paymentId: string | null
  accountId: string | null
  accountName: string | null
  /** cac:FinancialInstitutionBranch/cbc:ID, e.g. SE:BANKGIRO, SE:PLUSGIRO, BBAN, or a BIC. */
  branchId: string | null
  bankgiro: string | null
  plusgiro: string | null
  iban: string | null
}

export interface PeppolInboundTaxSubtotal {
  taxableAmount: number | null
  taxAmount: number | null
  categoryId: string | null
  percent: number | null
  exemptionReason: string | null
}

export interface PeppolInboundLine {
  id: string | null
  name: string | null
  description: string | null
  quantity: number | null
  unitCode: string | null
  priceAmount: number | null
  lineExtensionAmount: number | null
  vatCategoryId: string | null
  vatPercent: number | null
  sellersItemId: string | null
  buyerAccountingCost: string | null
}

export interface PeppolInboundAttachment {
  id: string | null
  description: string | null
  filename: string | null
  mimeType: string | null
  /** Base64 as embedded in the document; decoded by the caller. */
  base64: string | null
  externalUri: string | null
}

export interface PeppolInboundTotals {
  lineExtension: number | null
  taxExclusive: number | null
  taxInclusive: number | null
  allowanceTotal: number | null
  chargeTotal: number | null
  prepaid: number | null
  payableRounding: number | null
  payable: number | null
  taxAmount: number | null
}

export interface PeppolInboundDocument {
  documentType: 'Invoice' | 'CreditNote'
  customizationId: string | null
  profileId: string | null
  documentId: string
  issueDate: string | null
  dueDate: string | null
  typeCode: string | null
  currency: string | null
  buyerReference: string | null
  orderReference: string | null
  /** For credit notes: the invoice(s) being credited (cac:BillingReference). */
  billingReferences: string[]
  note: string | null
  paymentTermsNote: string | null
  supplier: PeppolInboundParty
  customer: PeppolInboundParty
  paymentMeans: PeppolInboundPaymentMeans[]
  totals: PeppolInboundTotals
  taxSubtotals: PeppolInboundTaxSubtotal[]
  lines: PeppolInboundLine[]
  attachments: PeppolInboundAttachment[]
  warnings: string[]
}

function asNode(value: unknown): UblJsonNode | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UblJsonNode)
    : null
}

/** All child elements named `name`, accepting both prefixed and bare keys. */
export function ublChildren(node: UblJsonNode | null, name: string): UblJsonNode[] {
  if (!node) return []
  const raw = node[name] ?? node[`cac:${name}`] ?? node[`cbc:${name}`] ?? node[`ext:${name}`]
  if (raw === undefined || raw === null) return []
  const list = Array.isArray(raw) ? raw : [raw]
  return list.map((item) => {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      return { _: String(item) }
    }
    return asNode(item)
  }).filter((item): item is UblJsonNode => item !== null)
}

export function ublFirst(node: UblJsonNode | null, name: string): UblJsonNode | null {
  return ublChildren(node, name)[0] ?? null
}

/** Text content of an element node (`_`), trimmed, empty -> null. */
export function ublNodeText(node: UblJsonNode | null): string | null {
  if (!node) return null
  const raw = node._
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    return trimmed ? trimmed : null
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
  return null
}

export function ublText(node: UblJsonNode | null, name: string): string | null {
  return ublNodeText(ublFirst(node, name))
}

/** Attribute of an element node: xml2js keeps them under `$`, OASIS beside `_`. */
export function ublAttr(node: UblJsonNode | null, attribute: string): string | null {
  if (!node) return null
  const direct = node[attribute]
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  const bag = asNode(node.$)
  const nested = bag?.[attribute]
  return typeof nested === 'string' && nested.trim() ? nested.trim() : null
}

export function ublNumber(node: UblJsonNode | null, name: string): number | null {
  const text = ublText(node, name)
  if (text === null) return null
  const normalized = text.replace(/\s/g, '').replace(',', '.')
  const value = Number(normalized)
  return Number.isFinite(value) ? value : null
}

function digitsOnly(value: string | null): string {
  return (value ?? '').replace(/\D/g, '')
}

/** Ten-digit Swedish organisation number from an endpoint or legal id, else null. */
export function swedishOrgNumberFrom(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const digits = digitsOnly(candidate ?? null)
    if (digits.length === 10) return digits
    // Twelve-digit form (16 + orgnr) used by some senders.
    if (digits.length === 12 && digits.startsWith('16')) return digits.slice(2)
  }
  return null
}

function readEndpoint(party: UblJsonNode | null): PeppolInboundEndpoint | null {
  const endpoint = ublFirst(party, 'EndpointID')
  const identifier = ublNodeText(endpoint)
  const scheme = ublAttr(endpoint, 'schemeID')
  if (!identifier || !scheme) return null
  return { scheme, identifier: identifier.replace(/\s/g, '') }
}

function readParty(root: UblJsonNode | null, container: string, warnings: string[]): PeppolInboundParty {
  const party = ublFirst(ublFirst(root, container), 'Party')
  if (!party) warnings.push(`${container} missing`)
  const address = ublFirst(party, 'PostalAddress')
  const legal = ublFirst(party, 'PartyLegalEntity')
  const contact = ublFirst(party, 'Contact')
  const endpoint = readEndpoint(party)
  const legalCompanyId = ublText(legal, 'CompanyID')
  const vatNumber = ublChildren(party, 'PartyTaxScheme')
    .map((scheme) => ({ id: ublText(scheme, 'CompanyID'), kind: ublText(ublFirst(scheme, 'TaxScheme'), 'ID') }))
    .find((scheme) => scheme.kind === 'VAT' && scheme.id)?.id ?? null
  const partyIdentification = ublText(ublFirst(party, 'PartyIdentification'), 'ID')
  const countryCode = ublText(ublFirst(address, 'Country'), 'IdentificationCode')
  const swedish = !countryCode || countryCode.toUpperCase() === 'SE'
    || endpoint?.scheme === '0007' || (vatNumber ?? '').toUpperCase().startsWith('SE')

  return {
    name: ublText(legal, 'RegistrationName') ?? ublText(ublFirst(party, 'PartyName'), 'Name'),
    endpoint,
    legalCompanyId,
    orgNumber: swedish
      ? swedishOrgNumberFrom(
          endpoint?.scheme === '0007' ? endpoint.identifier : null,
          legalCompanyId,
          partyIdentification,
        )
      : null,
    vatNumber,
    street: ublText(address, 'StreetName'),
    additionalStreet: ublText(address, 'AdditionalStreetName'),
    city: ublText(address, 'CityName'),
    postalZone: ublText(address, 'PostalZone'),
    countryCode,
    email: ublText(contact, 'ElectronicMail'),
    phone: ublText(contact, 'Telephone'),
  }
}

function readPaymentMeans(root: UblJsonNode | null): PeppolInboundPaymentMeans[] {
  return ublChildren(root, 'PaymentMeans').map((means) => {
    const account = ublFirst(means, 'PayeeFinancialAccount')
    const accountId = ublText(account, 'ID')
    const branchId = ublText(ublFirst(account, 'FinancialInstitutionBranch'), 'ID')
    const branch = (branchId ?? '').toUpperCase()
    const digits = digitsOnly(accountId)
    const isIban = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test((accountId ?? '').replace(/\s/g, '').toUpperCase())
    return {
      code: ublText(means, 'PaymentMeansCode'),
      paymentId: ublText(means, 'PaymentID'),
      accountId,
      accountName: ublText(account, 'Name'),
      branchId,
      bankgiro: branch === 'SE:BANKGIRO' && digits ? digits : null,
      plusgiro: branch === 'SE:PLUSGIRO' && digits ? digits : null,
      iban: isIban ? (accountId ?? '').replace(/\s/g, '').toUpperCase() : null,
    }
  })
}

function readLines(root: UblJsonNode | null, lineElement: 'InvoiceLine' | 'CreditNoteLine'): PeppolInboundLine[] {
  const quantityElement = lineElement === 'InvoiceLine' ? 'InvoicedQuantity' : 'CreditedQuantity'
  return ublChildren(root, lineElement).map((line) => {
    const item = ublFirst(line, 'Item')
    const tax = ublFirst(item, 'ClassifiedTaxCategory')
    const quantity = ublFirst(line, quantityElement)
    return {
      id: ublText(line, 'ID'),
      name: ublText(item, 'Name'),
      description: ublText(item, 'Description') ?? ublText(line, 'Note'),
      quantity: ublNumber(line, quantityElement),
      unitCode: ublAttr(quantity, 'unitCode'),
      priceAmount: ublNumber(ublFirst(line, 'Price'), 'PriceAmount'),
      lineExtensionAmount: ublNumber(line, 'LineExtensionAmount'),
      vatCategoryId: ublText(tax, 'ID'),
      vatPercent: ublNumber(tax, 'Percent'),
      sellersItemId: ublText(ublFirst(item, 'SellersItemIdentification'), 'ID'),
      buyerAccountingCost: ublText(line, 'AccountingCost'),
    }
  })
}

function readAttachments(root: UblJsonNode | null): PeppolInboundAttachment[] {
  return ublChildren(root, 'AdditionalDocumentReference').map((reference) => {
    const attachment = ublFirst(reference, 'Attachment')
    const embedded = ublFirst(attachment, 'EmbeddedDocumentBinaryObject')
    return {
      id: ublText(reference, 'ID'),
      description: ublText(reference, 'DocumentDescription'),
      filename: ublAttr(embedded, 'filename'),
      mimeType: ublAttr(embedded, 'mimeCode'),
      base64: ublNodeText(embedded)?.replace(/\s/g, '') ?? null,
      externalUri: ublText(ublFirst(attachment, 'ExternalReference'), 'URI'),
    }
  }).filter((attachment) => attachment.base64 || attachment.externalUri)
}

/**
 * Read an inbound UBL-JSON message. Accepts the message envelope Qvalia
 * returns (`{ Invoice: {...}, integrationId }`), a bare root, or a CreditNote.
 * Returns null when no UBL root element can be found.
 */
export function parseUblJsonDocument(message: unknown): PeppolInboundDocument | null {
  const envelope = asNode(message)
  if (!envelope) return null

  let documentType: 'Invoice' | 'CreditNote' | null = null
  let root: UblJsonNode | null = null
  for (const candidate of ['Invoice', 'CreditNote'] as const) {
    const found = ublFirst(envelope, candidate)
    if (found) {
      documentType = candidate
      root = found
      break
    }
  }
  if (!root || !documentType) {
    // A bare root: decide by the line element present.
    if (ublChildren(envelope, 'InvoiceLine').length) {
      documentType = 'Invoice'
      root = envelope
    } else if (ublChildren(envelope, 'CreditNoteLine').length) {
      documentType = 'CreditNote'
      root = envelope
    } else {
      return null
    }
  }

  const warnings: string[] = []
  const documentId = ublText(root, 'ID')
  if (!documentId) warnings.push('document id missing')

  const totalsNode = ublFirst(root, 'LegalMonetaryTotal')
  const taxTotal = ublFirst(root, 'TaxTotal')
  const taxSubtotals = ublChildren(taxTotal, 'TaxSubtotal').map((subtotal) => {
    const category = ublFirst(subtotal, 'TaxCategory')
    return {
      taxableAmount: ublNumber(subtotal, 'TaxableAmount'),
      taxAmount: ublNumber(subtotal, 'TaxAmount'),
      categoryId: ublText(category, 'ID'),
      percent: ublNumber(category, 'Percent'),
      exemptionReason: ublText(category, 'TaxExemptionReason'),
    }
  })

  const lines = readLines(root, documentType === 'Invoice' ? 'InvoiceLine' : 'CreditNoteLine')
  if (lines.length === 0) warnings.push('no lines')

  const totals: PeppolInboundTotals = {
    lineExtension: ublNumber(totalsNode, 'LineExtensionAmount'),
    taxExclusive: ublNumber(totalsNode, 'TaxExclusiveAmount'),
    taxInclusive: ublNumber(totalsNode, 'TaxInclusiveAmount'),
    allowanceTotal: ublNumber(totalsNode, 'AllowanceTotalAmount'),
    chargeTotal: ublNumber(totalsNode, 'ChargeTotalAmount'),
    prepaid: ublNumber(totalsNode, 'PrepaidAmount'),
    payableRounding: ublNumber(totalsNode, 'PayableRoundingAmount'),
    payable: ublNumber(totalsNode, 'PayableAmount'),
    taxAmount: ublNumber(taxTotal, 'TaxAmount'),
  }
  if (totals.payable === null) warnings.push('payable amount missing')

  return {
    documentType,
    customizationId: ublText(root, 'CustomizationID'),
    profileId: ublText(root, 'ProfileID'),
    documentId: documentId ?? '',
    issueDate: ublText(root, 'IssueDate'),
    dueDate: ublText(root, 'DueDate') ?? ublText(ublFirst(root, 'PaymentMeans'), 'PaymentDueDate'),
    typeCode: ublText(root, documentType === 'Invoice' ? 'InvoiceTypeCode' : 'CreditNoteTypeCode'),
    currency: ublText(root, 'DocumentCurrencyCode'),
    buyerReference: ublText(root, 'BuyerReference'),
    orderReference: ublText(ublFirst(root, 'OrderReference'), 'ID'),
    billingReferences: ublChildren(root, 'BillingReference')
      .map((reference) => ublText(ublFirst(reference, 'InvoiceDocumentReference'), 'ID'))
      .filter((id): id is string => !!id),
    note: ublText(root, 'Note'),
    paymentTermsNote: ublText(ublFirst(root, 'PaymentTerms'), 'Note'),
    supplier: readParty(root, 'AccountingSupplierParty', warnings),
    customer: readParty(root, 'AccountingCustomerParty', warnings),
    paymentMeans: readPaymentMeans(root),
    totals,
    taxSubtotals,
    lines,
    attachments: readAttachments(root),
    warnings,
  }
}
