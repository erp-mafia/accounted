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
import type { CompanySettings, Currency, Invoice, InvoicePaymentAccount } from '@/types'
import { brandingFromCompanySettings, SHOW_SWISH_ON_INVOICE, type InvoiceBranding } from '@/lib/invoices/pdf-template'
import { buildSwishQrPayload } from '@/lib/payments/swish'
import { getAmountToPay } from '@/lib/invoices/rounding'
import { createLogger } from '@/lib/logger'
import { isUnsafeUrlError, readBodyWithCap, safeFetch } from '@/lib/http/safe-fetch'
import { LOGO_UPLOAD_MAX_BYTES } from '@/lib/invoices/branding-constants'
import { prepareInvoiceFont } from '@/lib/invoices/pdf-fonts'
import {
  assertInvoicePaymentAccountForRender,
  companyWithInvoicePaymentAccount,
} from '@/lib/invoices/payment-accounts'

const log = createLogger('invoice.swish-qr')
const paymentLinkLog = createLogger('invoice.payment-link-qr')
const logoLog = createLogger('invoice.logo')

export interface InvoicePdfRenderExtras {
  branding: InvoiceBranding
  /**
   * The company settings to pass to InvoicePDF. Identical to the input except
   * `logo_url` is replaced by an embedded PNG data URL when the stored logo
   * could be fetched and re-encoded, or set to null when the stored URL was
   * refused by the outbound URL guard (the invoice then renders without a
   * logo). A transient failure keeps the original URL only when it points at
   * the deployment's own storage origin; @react-pdf must never be handed an
   * arbitrary remote URL to fetch unguarded.
   */
  company: CompanySettings
}

export interface InvoicePdfRenderOptions {
  paymentAccountRequired?: boolean
  /**
   * The invoice's own frozen payee (invoices.payment_details) when it chose
   * a bank account. Null/undefined = the company's default for the currency.
   */
  payee?: Partial<InvoicePaymentAccount> | null
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

// The invoice draws the logo at up to 240pt by 80pt, so 600px keeps it crisp
// while bounding the embedded base64 payload.
const LOGO_MAX_PX = 600

// Bound the logo fetch so a slow or oversized response can't hang or balloon an
// invoice render. The upload route only ever writes Supabase `logos`-bucket
// URLs, but company members can PATCH `company_settings.logo_url` directly
// through PostgREST, so the stored value is tenant-controlled input that this
// server fetches: it goes through `safeFetch` (public address only, no
// redirects) unless it sits on the deployment's own storage origin.
const LOGO_FETCH_TIMEOUT_MS = 5_000

/**
 * What became of a stored logo URL:
 *   embedded: fetched, re-encoded, safe to hand to @react-pdf as a data URL
 *   refused:  the outbound URL guard said no (private address, non-http(s),
 *             redirect); the invoice renders without a logo
 *   failed:   transient or decode failure after the guard passed
 */
type LogoResolution =
  | { kind: 'embedded'; dataUrl: string }
  | { kind: 'refused' }
  | { kind: 'failed' }

// Coalesce concurrent renders of the same logo (preflight + final on a send, and
// every invoice in a recurring/batch loop) onto one in-flight fetch+encode
// instead of each doing the full round-trip before the first result is cached.
const logoInflight = new Map<string, Promise<LogoResolution>>()

/**
 * The origin the app's own Supabase storage lives on. Logos uploaded through
 * the app always resolve here, and on a self-hosted install this origin may
 * legitimately be a private address (a NAS on the LAN), so it is exempt from
 * the public-address check. Redirect refusal and the size cap still apply.
 */
function trustedLogoOrigins(): string[] {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!raw) return []
  try {
    return [new URL(raw).origin]
  } catch {
    return []
  }
}

function isTrustedLogoOrigin(logoUrl: string): boolean {
  try {
    return trustedLogoOrigins().includes(new URL(logoUrl).origin)
  } catch {
    return false
  }
}

/**
 * Fetch a stored logo and re-encode it to a PNG data URL. Concurrent calls
 * for the same URL share a single in-flight request; only successes are
 * cached so a transient blip is retried on the next render.
 */
async function resolveLogoDataUrl(logoUrl: string): Promise<LogoResolution> {
  // Already embedded: nothing to fetch or convert.
  if (logoUrl.startsWith('data:')) return { kind: 'embedded', dataUrl: logoUrl }

  const cached = logoDataUrlCache.get(logoUrl)
  if (cached && Date.now() - cached.at < LOGO_CACHE_TTL_MS) {
    return { kind: 'embedded', dataUrl: cached.dataUrl }
  }

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

async function encodeLogo(logoUrl: string): Promise<LogoResolution> {
  let res: Response
  try {
    res = await safeFetch(
      logoUrl,
      { signal: AbortSignal.timeout(LOGO_FETCH_TIMEOUT_MS) },
      { trustedOrigins: trustedLogoOrigins() },
    )
  } catch (err) {
    if (isUnsafeUrlError(err)) {
      logoLog.warn('logo URL refused by outbound URL guard; rendering without logo', {
        reason: err.reason,
        detail: err.detail,
      })
      return { kind: 'refused' }
    }
    return { kind: 'failed' }
  }

  try {
    if (!res.ok) return { kind: 'failed' }

    // Declared Content-Length is checked before any byte is read, and the
    // stream is cut off at the cap in case the header lied or was absent.
    const input = await readBodyWithCap(res, LOGO_UPLOAD_MAX_BYTES)
    if (!input) return { kind: 'failed' }

    // SVGs must be rasterized at a higher density or sharp renders them at
    // their intrinsic (often tiny) pixel size and the result looks blurry.
    const contentType = res.headers.get('content-type') ?? ''
    const isSvg =
      /svg/i.test(contentType) ||
      input.subarray(0, 256).toString('utf8').trimStart().startsWith('<')

    // Lazy, isolated import: if sharp ever fails to load in a given runtime we
    // degrade instead of breaking invoice sending entirely.
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
    return { kind: 'embedded', dataUrl }
  } catch {
    return { kind: 'failed' }
  }
}

/**
 * Apply the logo resolution to the company handed to the PDF template.
 *
 * On a transient failure the original URL is kept only when it points at our
 * own storage origin (the pre-existing "never worse than before" fallback:
 * @react-pdf can still draw a PNG/JPEG from there). For any other origin the
 * logo is dropped instead: handing @react-pdf a remote URL means it fetches
 * it with a plain, redirect-following fetch, which is exactly the unguarded
 * request this module exists to prevent.
 */
function applyLogoResolution(company: CompanySettings, resolution: LogoResolution): CompanySettings {
  if (resolution.kind === 'embedded') {
    return resolution.dataUrl === company.logo_url
      ? company
      : { ...company, logo_url: resolution.dataUrl }
  }
  if (resolution.kind === 'refused') return { ...company, logo_url: null }
  return company.logo_url && isTrustedLogoOrigin(company.logo_url)
    ? company
    : { ...company, logo_url: null }
}

export async function prepareInvoicePdfRender(
  company: CompanySettings,
  currency?: Currency,
  options: InvoicePdfRenderOptions = {},
): Promise<InvoicePdfRenderExtras> {
  if (currency && options.paymentAccountRequired !== false) {
    assertInvoicePaymentAccountForRender(company, currency, options.payee ?? null)
  }
  const branding = await prepareInvoiceFont(
    company,
    brandingFromCompanySettings(company),
  )
  const paymentCompany = currency
    ? companyWithInvoicePaymentAccount(company, currency, options.payee ?? null)
    : company
  if (!paymentCompany.logo_url) return { branding, company: paymentCompany }

  const resolution = await resolveLogoDataUrl(paymentCompany.logo_url)
  return { branding, company: applyLogoResolution(paymentCompany, resolution) }
}

/**
 * Build the payment-link QR for an invoice as a PNG data URL, or null when the
 * invoice carries no payment_link_url or it isn't a payable document (credit
 * notes, proformas and delivery notes show no payment box). The URL was
 * https-validated at write time (lib/api/schemas.ts); the QR simply encodes it
 * locally with the `qrcode` lib: no call to any payment provider.
 */
export async function buildPaymentLinkQrDataUrl(invoice: Invoice): Promise<string | null> {
  const url = invoice.payment_link_url?.trim()
  if (!url) return null
  const docType = invoice.document_type || 'invoice'
  if (docType !== 'invoice' || invoice.credited_invoice_id) return null
  try {
    return await QRCode.toDataURL(url, { margin: 1, width: 240, errorCorrectionLevel: 'M' })
  } catch (err) {
    paymentLinkLog.warn('payment link QR generation failed', {
      invoiceId: invoice.id,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Build the Swish payment QR for an invoice as a PNG data URL, or null when:
 * Swish display is off, the document isn't a payable invoice (credit notes,
 * proformas and delivery notes collect no payment), there's no/invalid Swish
 * number, the invoice isn't in SEK (Swish is SEK-only), or the amount to pay
 * is not positive. The encoded amount is the customer-facing "Att betala"
 * from getAmountToPay: the rounded total minus any ROT/RUT deduction, the
 * same figure the PDF totals block and the invoice email state. The Swish payload locks the amount (editmask 0),
 * so encoding anything else makes the customer overpay with no way to correct
 * it in the app. A fully deducted invoice (toPay = 0) therefore renders no QR.
 * Generated locally with the `qrcode` lib: no call to any Swish API. Pass the
 * result to InvoicePDF's `swishQrDataUrl` prop; the template gates rendering
 * on the same payment box that already shows the Swish number.
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
  // Non-payable documents: the PDF hides the whole payment box for them, and
  // a locked payment QR on a kreditfaktura (a refund document, "Er tillgodo")
  // must stay impossible even if a template regression ever exposed the
  // corner. Same gate as buildPaymentLinkQrDataUrl; quiet like display-off.
  const docType = invoice.document_type || 'invoice'
  if (docType !== 'invoice' || invoice.credited_invoice_id) return null
  if ((invoice.currency ?? 'SEK') !== 'SEK') {
    log.info('swish QR skipped: invoice not in SEK', { invoiceId: invoice.id, currency: invoice.currency })
    return null
  }
  const amount = getAmountToPay(invoice, company).toPay
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
