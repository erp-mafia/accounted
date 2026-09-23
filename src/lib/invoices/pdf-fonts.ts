import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
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
import { createServiceClient } from '@/lib/supabase/server'

export const CUSTOM_INVOICE_FONT_RENDER_PREFIX = 'InvoiceCustom-'

type BundledInvoiceFontFamily = (typeof BUNDLED_INVOICE_FONT_FAMILIES)[number]

interface FontVariantFiles {
  regular: string
  bold: string
  italic: string
  boldItalic: string
}

const BUNDLED_FONT_FILES: Record<BundledInvoiceFontFamily, FontVariantFiles> = {
  'Source Sans 3': {
    regular: 'SourceSans3-Regular.ttf',
    bold: 'SourceSans3-Bold.ttf',
    italic: 'SourceSans3-Italic.ttf',
    boldItalic: 'SourceSans3-BoldItalic.ttf',
  },
  'Source Serif 4': {
    regular: 'SourceSerif4-Regular.ttf',
    bold: 'SourceSerif4-Bold.ttf',
    italic: 'SourceSerif4-Italic.ttf',
    boldItalic: 'SourceSerif4-BoldItalic.ttf',
  },
}

const log = createLogger('invoice.pdf-fonts')
const registeredFamilies = new Set<string>()
const bundledRegistration = new Map<string, Promise<void>>()
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

async function readBundledFont(fileName: string): Promise<string> {
  const bytes = await readFile(join(process.cwd(), 'public', 'fonts', 'invoice', fileName))
  const format = detectInvoiceFontFileFormat(bytes)
  if (!format) throw new Error(`Invalid bundled invoice font: ${fileName}`)
  return toInvoiceFontDataUrl(bytes, format)
}

async function registerBundledFont(family: BundledInvoiceFontFamily): Promise<void> {
  if (registeredFamilies.has(family)) return

  let registration = bundledRegistration.get(family)
  if (!registration) {
    registration = (async () => {
      const files = BUNDLED_FONT_FILES[family]
      const [regular, bold, italic, boldItalic] = await Promise.all([
        readBundledFont(files.regular),
        readBundledFont(files.bold),
        readBundledFont(files.italic),
        readBundledFont(files.boldItalic),
      ])

      Font.register({
        family,
        fonts: [
          { src: regular, fontWeight: 400, fontStyle: 'normal' },
          { src: bold, fontWeight: 700, fontStyle: 'normal' },
          { src: italic, fontWeight: 400, fontStyle: 'italic' },
          { src: boldItalic, fontWeight: 700, fontStyle: 'italic' },
        ],
      })
      await Promise.all([
        Font.load({ fontFamily: family, fontWeight: 400, fontStyle: 'normal' }),
        Font.load({ fontFamily: family, fontWeight: 700, fontStyle: 'normal' }),
        Font.load({ fontFamily: family, fontWeight: 400, fontStyle: 'italic' }),
        Font.load({ fontFamily: family, fontWeight: 700, fontStyle: 'italic' }),
      ])
      registeredFamilies.add(family)
    })()
    bundledRegistration.set(family, registration)
  }

  try {
    await registration
  } finally {
    bundledRegistration.delete(family)
  }
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
