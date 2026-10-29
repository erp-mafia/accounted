import { createHash } from 'node:crypto'
import { Font } from '@react-pdf/renderer'
import type { CompanySettings, InvoiceFontFamily } from '@/types'
import type { InvoiceBranding } from '@/lib/invoices/pdf-template'
import {
  BUNDLED_INVOICE_FONT_FAMILIES,
  CUSTOM_INVOICE_FONT_FAMILY,
  INVOICE_FONT_UPLOAD_MAX_BYTES,
  STANDARD_PDF_FONT_FAMILIES,
} from '@/lib/invoices/branding-constants'
import {
  detectInvoiceFontFileFormat,
  toInvoiceFontDataUrl,
} from '@/lib/invoices/font-files'
import { createLogger } from '@/lib/logger'
import { registerBundledFont } from '@/lib/pdf/bundled-fonts'
import { createServiceClient } from '@/lib/supabase/server'

export const CUSTOM_INVOICE_FONT_RENDER_PREFIX = 'InvoiceCustom-'

type BundledInvoiceFontFamily = (typeof BUNDLED_INVOICE_FONT_FAMILIES)[number]

const log = createLogger('invoice.pdf-fonts')
const registeredFamilies = new Set<string>()
const customRegistration = new Map<string, Promise<string | null>>()
const invalidCustomFontPaths = new Set<string>()

function isStandardPdfFont(
  family: InvoiceFontFamily,
): family is (typeof STANDARD_PDF_FONT_FAMILIES)[number] {
  return STANDARD_PDF_FONT_FAMILIES.includes(
    family as (typeof STANDARD_PDF_FONT_FAMILIES)[number],
  )
}

function isBundledInvoiceFont(
  family: InvoiceFontFamily,
): family is BundledInvoiceFontFamily {
  return BUNDLED_INVOICE_FONT_FAMILIES.includes(
    family as BundledInvoiceFontFamily,
  )
}

async function downloadCustomFontDataUrl(
  companyId: string,
  storagePath: string,
): Promise<string | null> {
  const pathPrefix = `${companyId}/`
  const fileName = storagePath.slice(pathPrefix.length)
  if (
    !storagePath.startsWith(pathPrefix) ||
    !/^invoice-font-\d+\.(ttf|woff)$/.test(fileName)
  ) {
    return null
  }

  try {
    const serviceClient = createServiceClient()
    const { data, error } = await serviceClient.storage
      .from('invoice-fonts')
      .download(storagePath)
    if (error || !data || data.size > INVOICE_FONT_UPLOAD_MAX_BYTES) return null

    const bytes = new Uint8Array(await data.arrayBuffer())
    if (bytes.byteLength > INVOICE_FONT_UPLOAD_MAX_BYTES) return null
    const format = detectInvoiceFontFileFormat(bytes)
    return format ? toInvoiceFontDataUrl(bytes, format) : null
  } catch {
    return null
  }
}

async function registerCustomFont(company: CompanySettings): Promise<string | null> {
  const storagePath = company.invoice_custom_font_path
  if (!storagePath || invalidCustomFontPaths.has(storagePath)) return null

  const digest = createHash('sha256').update(storagePath).digest('hex').slice(0, 12)
  const family = `${CUSTOM_INVOICE_FONT_RENDER_PREFIX}${digest}`
  if (registeredFamilies.has(family)) return family

  let registration = customRegistration.get(storagePath)
  if (!registration) {
    registration = (async () => {
      const src = await downloadCustomFontDataUrl(company.company_id, storagePath)
      if (!src) return null

      Font.register({
        family,
        fonts: [
          { src, fontWeight: 400, fontStyle: 'normal' },
          { src, fontWeight: 700, fontStyle: 'normal' },
          { src, fontWeight: 400, fontStyle: 'italic' },
          { src, fontWeight: 700, fontStyle: 'italic' },
        ],
      })
      try {
        await Font.load({ fontFamily: family, fontWeight: 400, fontStyle: 'normal' })
      } catch {
        invalidCustomFontPaths.add(storagePath)
        return null
      }
      registeredFamilies.add(family)
      return family
    })()
    customRegistration.set(storagePath, registration)
  }

  try {
    return await registration
  } finally {
    customRegistration.delete(storagePath)
  }
}

function withHelveticaFallback(branding: InvoiceBranding): InvoiceBranding {
  return { ...branding, fontFamily: 'Helvetica' }
}

export async function prepareInvoiceFont(
  company: CompanySettings,
  branding: InvoiceBranding,
): Promise<InvoiceBranding> {
  const family = branding.fontFamily ?? 'Helvetica'
  if (isStandardPdfFont(family as InvoiceFontFamily)) return branding

  if (isBundledInvoiceFont(family as InvoiceFontFamily)) {
    try {
      await registerBundledFont(family as BundledInvoiceFontFamily)
      return branding
    } catch (error) {
      log.warn('bundled invoice font registration failed', {
        family,
        error: error instanceof Error ? error.message : String(error),
      })
      return withHelveticaFallback(branding)
    }
  }

  if (family === CUSTOM_INVOICE_FONT_FAMILY) {
    const registeredFamily = await registerCustomFont(company)
    if (registeredFamily) return { ...branding, fontFamily: registeredFamily }
    log.warn('custom invoice font unavailable, using Helvetica', {
      companyId: company.company_id,
    })
  }

  return withHelveticaFallback(branding)
}
