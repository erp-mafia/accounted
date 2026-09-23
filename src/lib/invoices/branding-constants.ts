import type { InvoiceFontFamily } from '@/types'

export const LOGO_UPLOAD_MAX_MB = 10
export const LOGO_UPLOAD_MAX_BYTES = LOGO_UPLOAD_MAX_MB * 1024 * 1024

export const INVOICE_LOGO_MAX_WIDTH_PT = 240
export const INVOICE_LOGO_MAX_HEIGHT_PT = 80

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
