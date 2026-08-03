import type { InvoiceFontFamily } from '@/types'

export const LOGO_UPLOAD_MAX_MB = 10
export const LOGO_UPLOAD_MAX_BYTES = LOGO_UPLOAD_MAX_MB * 1024 * 1024

export const LOGO_ALLOWED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/svg+xml',
  'image/webp',
] as const

export type LogoMimeType = (typeof LOGO_ALLOWED_MIME_TYPES)[number]

export const LOGO_EXTENSION_BY_MIME_TYPE: Record<LogoMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
}

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
