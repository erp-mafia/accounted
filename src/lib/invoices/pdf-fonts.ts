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
import { registerBundledFont, warmGlyphCache } from '@/lib/pdf/bundled-fonts'
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

/**
 * Make the four faces of an uploaded font one parsed font.
 *
 * The bold and italic faces are the same file as the regular one, but
 * @react-pdf/renderer parses every registered face on its own, while the
 * PDF embeds them as ONE font (pdfkit merges fonts by PostScript name). A
 * glyph drawn in one face was embedded through the face that drew first,
 * and fontkit cached it there without its character. The next invoice drawn
 * in that face lost the glyph from the line and the text layer, for the life
 * of the process (crm#1763: a bold total "5 124,00" printed as "124,00", the
 * bold OCR number without its first digit, "Org.nr" read as "0rg.nr").
 * warmGlyphCache creates every glyph a character maps to before that can
 * happen, but not a ligature such as "fi", which no character maps to; with
 * one parsed font, every glyph is embedded through the font that laid it out.
 */
function shareOneParsedFont(family: string): void {
  const regular = Font.getFont({ fontFamily: family, fontWeight: 400, fontStyle: 'normal' })
  for (const [fontWeight, fontStyle] of [[700, 'normal'], [400, 'italic'], [700, 'italic']] as const) {
    const face = Font.getFont({ fontFamily: family, fontWeight, fontStyle })
    face.data = regular.data
    face.loadResultPromise = regular.loadResultPromise
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
      shareOneParsedFont(family)
      warmGlyphCache(family)
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
