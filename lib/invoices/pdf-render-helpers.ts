/**
 * Shared helpers for invoice PDF render call sites.
 *
 * Three responsibilities:
 *   1. Build the branding object from company settings.
 *   2. Resolve the company logo into a format @react-pdf/renderer can draw.
 *   3. Build the optional Swish payment QR.
 *
 * Why the logo needs resolving (issue #772: "Logotyp kommer inte med på
 * fakturor"): @react-pdf/renderer's <Image> only decodes JPG and PNG, but the
 * logo upload route and the `logos` storage bucket both accept SVG and WebP.
 * When the logo is an SVG/WebP, @react-pdf fails to decode it and *silently*
 * swallows the error (a console.warn inside a try/catch in its fetchImage step):
 * so the invoice renders fine but with no logo, and nothing surfaces.
 *
 * Fix: fetch the stored logo and re-encode it to a PNG data URL via sharp, then
 * hand the template a company whose `logo_url` is that data URL. This makes the
 * logo render regardless of the uploaded format and removes the render-time
 * dependency on a remote fetch succeeding inside @react-pdf.
 */

import QRCode from 'qrcode'
import type { CompanySettings, Invoice } from '@/types'
import { brandingFromCompanySettings, SHOW_SWISH_ON_INVOICE, type InvoiceBranding } from '@/lib/invoices/pdf-template'
import { buildSwishQrPayload } from '@/lib/payments/swish'
import { getDisplayTotal } from '@/lib/invoices/rounding'
import { createLogger } from '@/lib/logger'

const log = createLogger('invoice.swish-qr')

export interface InvoicePdfRenderExtras {
  branding: InvoiceBranding
  /**
   * The company settings to pass to InvoicePDF. Identical to the input except
   * `logo_url` is replaced by an embedded PNG data URL when the stored logo
   * could be fetched and re-encoded. Falls back to the original settings
   * unchanged on any failure, so behaviour is never worse than before.
   */
  company: CompanySettings
}

// A company's logo is reused across every invoice render, and twice per send
// (preflight + final render), and once per invoice in recurring/batch loops:
// so cache the re-encoded result keyed by logo URL. Only successes are cached
// (with a short TTL); a transient fetch blip is retried on the next render
// rather than sticking around as a logo-less invoice. Bounded so a long-lived
// self-hosted process doesn't grow the map without limit.
const LOGO_CACHE_TTL_MS = 5 * 60 * 1000
const LOGO_CACHE_MAX = 50
const logoDataUrlCache = new Map<string, { dataUrl: string; at: number }>()

// The invoice draws the logo at maxWidth 150pt / maxHeight 40pt (~200px at
// print resolution), so 600px keeps it crisp while bounding the embedded
// base64 payload.
const LOGO_MAX_PX = 600

// Bound the logo fetch so a slow or oversized response can't hang or balloon an
// invoice render. logo_url is currently always a Supabase `logos`-bucket public
// URL (set only by the upload route), so SSRF is not reachable today: these
// caps are defense-in-depth for that invariant plus plain robustness.
const LOGO_FETCH_TIMEOUT_MS = 5_000
const LOGO_MAX_BYTES = 5 * 1024 * 1024 // 5 MB: generous for a logo, bounds memory

// Coalesce concurrent renders of the same logo (preflight + final on a send, and
// every invoice in a recurring/batch loop) onto one in-flight fetch+encode
// instead of each doing the full round-trip before the first result is cached.
const logoInflight = new Map<string, Promise<string | null>>()

/**
 * Fetch a stored logo and re-encode it to a PNG data URL. Returns null on any
 * failure (network error, timeout, oversized payload, unreadable image, sharp
 * unavailable): the caller then keeps the original URL, which @react-pdf can
 * still fetch directly for PNG/JPEG logos. Concurrent calls for the same URL
 * share a single in-flight request.
 */
async function resolveLogoDataUrl(logoUrl: string): Promise<string | null> {
  // Already embedded: nothing to fetch or convert.
  if (logoUrl.startsWith('data:')) return logoUrl

  const cached = logoDataUrlCache.get(logoUrl)
  if (cached && Date.now() - cached.at < LOGO_CACHE_TTL_MS) return cached.dataUrl

  const inflight = logoInflight.get(logoUrl)
  if (inflight) return inflight

  const work = encodeLogo(logoUrl)
  logoInflight.set(logoUrl, work)
  try {
    return await work
  } finally {
    // Only successes are cached (in encodeLogo); dropping the in-flight entry
    // here lets a transient failure be retried on the next render.
    logoInflight.delete(logoUrl)
  }
}

async function encodeLogo(logoUrl: string): Promise<string | null> {
  try {
    const res = await fetch(logoUrl, { signal: AbortSignal.timeout(LOGO_FETCH_TIMEOUT_MS) })
    if (!res.ok) return null

    // Reject oversized payloads up front when the server declares a length, and
    // again after reading in case the header lied or was absent.
    const declared = Number(res.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > LOGO_MAX_BYTES) return null
    const input = Buffer.from(await res.arrayBuffer())
    if (input.byteLength > LOGO_MAX_BYTES) return null

    // SVGs must be rasterized at a higher density or sharp renders them at
    // their intrinsic (often tiny) pixel size and the result looks blurry.
    const contentType = res.headers.get('content-type') ?? ''
    const isSvg =
      /svg/i.test(contentType) ||
      input.subarray(0, 256).toString('utf8').trimStart().startsWith('<')

    // Lazy, isolated import: if sharp ever fails to load in a given runtime we
    // degrade to the original URL instead of breaking invoice sending entirely.
    const { default: sharp } = await import('sharp')
    const png = await sharp(input, isSvg ? { density: 288 } : {})
      .resize({
        width: LOGO_MAX_PX,
        height: LOGO_MAX_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .png()
      .toBuffer()

    const dataUrl = `data:image/png;base64,${png.toString('base64')}`

    // Refresh insertion order so eviction is LRU-ish, then bound the cache.
    logoDataUrlCache.delete(logoUrl)
    if (logoDataUrlCache.size >= LOGO_CACHE_MAX) {
      const oldest = logoDataUrlCache.keys().next().value
      if (oldest !== undefined) logoDataUrlCache.delete(oldest)
    }
    logoDataUrlCache.set(logoUrl, { dataUrl, at: Date.now() })
    return dataUrl
  } catch {
    return null
  }
}

export async function prepareInvoicePdfRender(
  company: CompanySettings,
): Promise<InvoicePdfRenderExtras> {
  const branding = brandingFromCompanySettings(company)
  if (!company.logo_url) return { branding, company }

  const dataUrl = await resolveLogoDataUrl(company.logo_url)
  const resolved =
    dataUrl && dataUrl !== company.logo_url
      ? { ...company, logo_url: dataUrl }
      : company
  return { branding, company: resolved }
}

/**
 * Build the Swish payment QR for an invoice as a PNG data URL, or null when:
 * Swish display is off, there's no/invalid Swish number, the invoice isn't in
 * SEK (Swish is SEK-only), or the amount is not positive. Generated locally with
 * the `qrcode` lib: no call to any Swish API. Pass the result to InvoicePDF's
 * `swishQrDataUrl` prop; the template gates rendering on the same payment box
 * that already shows the Swish number.
 */
export async function buildSwishQrDataUrl(
  company: CompanySettings,
  invoice: Invoice,
): Promise<string | null> {
  // Swish on invoices is "coming soon": gated off in pdf-template. Bail before
  // any work while the feature is disabled.
  if (!SHOW_SWISH_ON_INVOICE) return null
  // Swish display off is the normal "no QR" case: stay quiet. Every other
  // skip is logged so a missing QR is diagnosable instead of silent.
  if (!(company.invoice_show_swish ?? false)) return null
  if ((invoice.currency ?? 'SEK') !== 'SEK') {
    log.info('swish QR skipped: invoice not in SEK', { invoiceId: invoice.id, currency: invoice.currency })
    return null
  }
  const amount = getDisplayTotal(invoice, company).displayed
  const payload = buildSwishQrPayload(company.swish, amount, invoice.invoice_number ?? '')
  if (!payload) {
    log.warn('swish QR skipped: invalid number or non-positive amount', {
      invoiceId: invoice.id,
      hasSwish: !!company.swish,
      amount,
    })
    return null
  }
  try {
    return await QRCode.toDataURL(payload, { margin: 1, width: 240, errorCorrectionLevel: 'M' })
  } catch (err) {
    log.warn('swish QR generation failed', {
      invoiceId: invoice.id,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
