import type { InvoiceFontFamily } from '@/types'

export const LOGO_UPLOAD_MAX_MB = 10
export const LOGO_UPLOAD_MAX_BYTES = LOGO_UPLOAD_MAX_MB * 1024 * 1024

export const INVOICE_FONT_FAMILIES = [
  'Helvetica',
  'Times-Roman',
  'Courier',
  'Source Sans 3',
  'Source Serif 4',
  'Custom',
] as const satisfies readonly InvoiceFontFamily[]

export const STANDARD_PDF_FONT_FAMILIES = [
  'Helvetica',
  'Times-Roman',
  'Courier',
] as const satisfies readonly InvoiceFontFamily[]

export const BUNDLED_INVOICE_FONT_FAMILIES = [
  'Source Sans 3',
  'Source Serif 4',
] as const satisfies readonly InvoiceFontFamily[]

export const CUSTOM_INVOICE_FONT_FAMILY = 'Custom' as const
export const INVOICE_FONT_UPLOAD_MAX_MB = 5
export const INVOICE_FONT_UPLOAD_MAX_BYTES = INVOICE_FONT_UPLOAD_MAX_MB * 1024 * 1024

/**
 * Invoice colours and the company's own header and footer line: the column
 * defaults (migration 20260526120200_invoice_branding.sql), the #RRGGBB
 * format its CHECK constraints enforce, and the text lengths the settings
 * save accepts. Read by the PDF stylesheet, the settings schema and the
 * Inställningar > Fakturor controls, so the three agree.
 */
export const DEFAULT_INVOICE_PRIMARY_COLOR = '#1a1a1a'
export const DEFAULT_INVOICE_ACCENT_COLOR = '#666666'
export const INVOICE_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/
export const INVOICE_HEADER_TEXT_MAX_LENGTH = 200
export const INVOICE_FOOTER_TEXT_MAX_LENGTH = 500

/**
 * A colour typed in the settings as #RRGGBB, with or without the #, in the
 * stored form (lower case); null for anything the column would refuse.
 */
export function normalizeInvoiceColor(input: string): string | null {
  const trimmed = input.trim()
  const hex = trimmed.startsWith('#') ? trimmed : `#${trimmed}`
  return INVOICE_COLOR_PATTERN.test(hex) ? hex.toLowerCase() : null
}
