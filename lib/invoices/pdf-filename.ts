import type { InvoiceDocumentType } from '@/types'

const MAX_NAME_PART_LENGTH = 60
const MAX_NUMBER_PART_LENGTH = 40
const MAX_FILENAME_BYTES = 255

interface InvoicePdfFilenameInput {
  companyName?: string | null
  customerName?: string | null
  invoiceNumber?: string | null
  invoiceId?: string | null
  invoiceDate?: string | null
  documentType?: InvoiceDocumentType | null
  isCreditNote?: boolean
}

function safeFilenamePart(value: string | null | undefined, fallback: string, maxLength: number): string {
  const normalized = (value ?? '')
    .toWellFormed()
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[ .]+$/g, '')
    .trim()

  if (!normalized) return fallback
  return Array.from(normalized).slice(0, maxLength).join('').replace(/[ .]+$/g, '') || fallback
}

function documentLabel(documentType: InvoiceDocumentType, isCreditNote: boolean): string {
  if (isCreditNote) return 'Kreditfaktura'
  if (documentType === 'proforma') return 'Proformafaktura'
  if (documentType === 'delivery_note') return 'Följesedel'
  return 'Faktura'
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function fitFilename(companyName: string, customerName: string, suffix: string): string {
  const company = Array.from(companyName)
  const customer = Array.from(customerName)
  const build = () => `${company.join('')} x ${customer.join('')} ${suffix}`

  while (utf8ByteLength(build()) > MAX_FILENAME_BYTES && (company.length > 1 || customer.length > 1)) {
    if (utf8ByteLength(company.join('')) >= utf8ByteLength(customer.join('')) && company.length > 1) {
      company.pop()
    } else if (customer.length > 1) {
      customer.pop()
    } else {
      company.pop()
    }
  }

  return build()
}

/**
 * Build a descriptive, cross-platform-safe PDF filename for an invoice document.
 *
 * Example: `Oppy x Kund AB Faktura nr 2621 20260721.pdf`.
 */
export function invoicePdfFilename({
  companyName,
  customerName,
  invoiceNumber,
  invoiceId,
  invoiceDate,
  documentType = 'invoice',
  isCreditNote = false,
}: InvoicePdfFilenameInput): string {
  const company = safeFilenamePart(companyName, 'Företag', MAX_NAME_PART_LENGTH)
  const customer = safeFilenamePart(customerName, 'Kund', MAX_NAME_PART_LENGTH)
  const label = documentLabel(documentType ?? 'invoice', isCreditNote)
  // The cross-platform filename is descriptive only. The invoice body retains
  // the authoritative number and credit-note reference, including separators.
  const number = invoiceNumber
    ? `nr ${safeFilenamePart(invoiceNumber, 'okänd', MAX_NUMBER_PART_LENGTH)}`
    : `utkast-${safeFilenamePart(invoiceId?.slice(0, 8), 'utan-nummer', MAX_NUMBER_PART_LENGTH)}`
  const compactDate = (invoiceDate ?? '').replace(/[^0-9]/g, '').slice(0, 8)
  const suffix = [label, number, compactDate].filter(Boolean).join(' ') + '.pdf'

  return fitFilename(company, customer, suffix)
}

/**
 * Filename for the betalningsbekräftelse (#1693): the paid re-render of a
 * settled faktura. Deliberately not the invoice filename shape above, so the
 * file can never be mistaken for the invoice that was sent. ASCII on purpose
 * (no ä): the name travels as an email attachment to arbitrary mail clients.
 *
 * Example: `Betalningsbekraftelse-2621.pdf`.
 */
export function paymentConfirmationPdfFilename(invoiceNumber: string | null | undefined): string {
  const number = safeFilenamePart(invoiceNumber, 'okand', MAX_NUMBER_PART_LENGTH).replace(/\s+/g, '-')
  return `Betalningsbekraftelse-${number}.pdf`
}
